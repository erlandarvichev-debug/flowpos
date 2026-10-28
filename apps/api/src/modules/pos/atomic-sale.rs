// FP-002: Atomic POS Sale Intent (Rust for Tauri)
// Single transaction: BEGIN → INSERT operation/receipt/lines/payments → COMMIT
//
// No partial writes. SQLITE_BUSY retry only on proven rollback.
// Error after commit reads by operation_id, not replay.

use rusqlite::{Connection, params, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use chrono::{DateTime, Utc};

#[derive(Debug, Serialize, Deserialize)]
pub struct SaleIntent {
    pub operation_id: String,
    pub device_id: String,
    pub terminal_id: String,
    pub shift_id: String,

    pub sale_number: String,
    pub sale_date: DateTime<Utc>,
    pub total_amount: i64, // in minor units (cents)
    pub items: Vec<SaleLineItem>,
    pub payments: Vec<PaymentAttempt>,

    pub payload_hash: String, // SHA256 for idempotency
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SaleLineItem {
    pub product_id: String,
    pub qty: f64,
    pub unit_price: i64,
    pub discount: i64,
    pub vat_rate: i32,
    pub line_total: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PaymentAttempt {
    pub payment_id: String,
    pub type_: String, // CASH, CARD, QR, MIXED
    pub amount: i64,
    pub status: String, // CREATED, PENDING, CONFIRMED, REJECTED
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SaleResult {
    pub sale_id: String,
    pub receipt_number: String,
    pub fiscal_number: Option<String>,
    pub durable_intent_stored: bool,
}

/**
 * FP-002: Atomic sale command
 *
 * **Contract:**
 * 1. Input validation (caller responsible)
 * 2. One SQLite connection, one transaction
 * 3. UNIQUE(operation_id) → either new sale or exists
 * 4. All inserts succeed or all rollback
 * 5. After commit: operation_id + payload_hash cannot change
 * 6. External effects (payment, fiscal) called AFTER this returns
 *
 * **Error handling:**
 * - SQLITE_BUSY: retry only if confirmed rollback
 * - UNIQUE constraint: return existing sale (idempotent)
 * - Other error: rollback, return error (not retryable)
 * - After commit error: read sale by operation_id
 */
pub fn atomic_sale(db: &Connection, intent: &SaleIntent, max_retries: u32) -> Result<SaleResult, String> {
    let mut retries = 0;

    loop {
        match attempt_atomic_sale(db, intent) {
            Ok(result) => return Ok(result),

            Err(rusqlite::Error::SqliteFailure(err, _)) if err.code == rusqlite::ErrorCode::Busy => {
                // FP-002: SQLITE_BUSY retry only if transaction rolled back
                retries += 1;
                if retries >= max_retries {
                    return Err(format!("SQLITE_BUSY after {} retries", max_retries));
                }

                // Check if we have an existing sale (transaction rolled back)
                if let Ok(Some(existing_id)) = get_sale_by_operation_id(db, &intent.operation_id) {
                    // Transaction rolled back, this was a retry, return existing sale
                    return Ok(SaleResult {
                        sale_id: existing_id,
                        receipt_number: intent.sale_number.clone(),
                        fiscal_number: None,
                        durable_intent_stored: true,
                    });
                }

                // Transaction didn't roll back, retry with backoff
                std::thread::sleep(std::time::Duration::from_millis(10 * retries as u64));
                continue;
            }

            Err(rusqlite::Error::SqliteFailure(_, Some(msg))) if msg.contains("UNIQUE constraint failed") => {
                // FP-002: Idempotent: return existing sale
                if let Ok(Some(existing_id)) = get_sale_by_operation_id(db, &intent.operation_id) {
                    return Ok(SaleResult {
                        sale_id: existing_id,
                        receipt_number: intent.sale_number.clone(),
                        fiscal_number: None,
                        durable_intent_stored: true,
                    });
                }
                return Err("UNIQUE constraint but sale not found".to_string());
            }

            Err(e) => {
                return Err(format!("Sale failed: {:?}", e));
            }
        }
    }
}

/**
 * FP-002: One atomic transaction
 */
fn attempt_atomic_sale(db: &Connection, intent: &SaleIntent) -> Result<SaleResult, rusqlite::Error> {
    let tx = db.transaction()?;

    // FP-002: Generate IDs
    let sale_id = Uuid::new_v4().to_string();

    // FP-002: Insert sale (UNIQUE operation_id blocks duplicates)
    tx.execute(
        "INSERT INTO pos_sales (id, operation_id, device_id, terminal_id, shift_id,
                                sale_number, sale_date, total_amount, payload_hash, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'DRAFT')",
        params![
            &sale_id,
            &intent.operation_id,
            &intent.device_id,
            &intent.terminal_id,
            &intent.shift_id,
            &intent.sale_number,
            intent.sale_date.to_rfc3339(),
            intent.total_amount,
            &intent.payload_hash,
        ],
    )?;

    // FP-002: Insert receipt lines
    for (idx, item) in intent.items.iter().enumerate() {
        tx.execute(
            "INSERT INTO pos_receipt_lines (id, sale_id, product_id, qty, unit_price, discount, vat_rate, line_total, sequence)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                Uuid::new_v4().to_string(),
                &sale_id,
                &item.product_id,
                item.qty,
                item.unit_price,
                item.discount,
                item.vat_rate,
                item.line_total,
                idx + 1,
            ],
        )?;
    }

    // FP-002: Insert expected payments (for recovery)
    for payment in intent.payments.iter() {
        tx.execute(
            "INSERT INTO pos_payments (id, sale_id, payment_id, type, amount, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                Uuid::new_v4().to_string(),
                &sale_id,
                &payment.payment_id,
                &payment.type_,
                payment.amount,
                &payment.status,
                Utc::now().to_rfc3339(),
            ],
        )?;
    }

    // FP-002: Insert recovery job (before external effects)
    tx.execute(
        "INSERT INTO recovery_jobs (id, sale_id, status, retry_count, next_retry_at, created_at)
         VALUES (?1, ?2, 'PENDING_PAYMENT', 0, ?3, ?4)",
        params![
            Uuid::new_v4().to_string(),
            &sale_id,
            Utc::now().to_rfc3339(),
            Utc::now().to_rfc3339(),
        ],
    )?;

    // FP-002: Atomic commit
    tx.commit()?;

    Ok(SaleResult {
        sale_id,
        receipt_number: intent.sale_number.clone(),
        fiscal_number: None,
        durable_intent_stored: true,
    })
}

/**
 * FP-002: Read sale by operation_id (after commit error)
 */
fn get_sale_by_operation_id(db: &Connection, operation_id: &str) -> Result<Option<String>, rusqlite::Error> {
    db.query_row(
        "SELECT id FROM pos_sales WHERE operation_id = ?1",
        params![operation_id],
        |row| row.get(0),
    ).optional()
}

/**
 * FP-002: External effect: Payment provider call
 * Called AFTER atomic_sale() returns
 * Must be idempotent: same payment_id → same result
 */
pub async fn process_payment(
    sale_id: &str,
    payment_id: &str,
    amount: i64,
    provider: &PaymentProvider,
) -> Result<PaymentResult, String> {
    // TODO: Call payment provider with payment_id (idempotency key)
    // Return: CONFIRMED | REJECTED | TIMEOUT
    todo!()
}

/**
 * FP-002: External effect: Fiscal printer
 * Called AFTER atomic_sale() returns
 * Must be idempotent: same receipt_number + hash → same fiscal_number
 */
pub async fn register_fiscal(
    sale_id: &str,
    receipt_number: &str,
    payload_hash: &str,
    fiscal_printer: &FiscalPrinter,
) -> Result<String, String> {
    // TODO: Call fiscal printer with receipt_number + hash (idempotency key)
    // Return: fiscal_number or error
    todo!()
}

// Stub types
pub struct PaymentProvider;
pub struct PaymentResult;
pub struct FiscalPrinter;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_atomic_sale_idempotent() {
        // FP-002: Same operation_id + payload_hash → same result
        todo!()
    }

    #[test]
    fn test_sqlite_busy_retry() {
        // FP-002: SQLITE_BUSY retry with backoff
        todo!()
    }

    #[test]
    fn test_fault_before_commit() {
        // FP-002: Crash before commit → no partial writes
        todo!()
    }
}
