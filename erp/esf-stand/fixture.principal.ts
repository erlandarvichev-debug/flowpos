/**
 * FP-081: Fixture Principal & Org/Action Guards
 * Synthetic user for local ESF testing
 *
 * Key constraints:
 * - Fixed principal (hardcoded for reproducibility)
 * - Scoped to specific organization
 * - Limited to specific actions (for audit)
 * - Cannot escalate privileges
 * - Expired credentials block all operations
 */

import { randomUUID } from 'node:crypto';

export interface FixturePrincipal {
  principalId: string;
  tenantId: string;
  organizationId: string;
  actorName: string;
  actions: Set<string>; // 'draft', 'approve', 'send', 'reconcile'
  expiresAt: Date;
}

export interface FixtureScope {
  tenantId: string;
  organizationId: string;
  actions: string[];
}

/**
 * FP-081: Create fixture principal (for local testing only)
 * Fixed principal ensures reproducible test behavior
 */
export function createFixturePrincipal(scope: FixtureScope): FixturePrincipal {
  return {
    principalId: 'fixture-principal-synthetic', // fixed for reproducibility
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    actorName: 'Fixture (Local ESF)',
    actions: new Set(scope.actions || ['draft', 'approve', 'send', 'reconcile']),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h validity
  };
}

/**
 * FP-081: Org/Action Guard
 * Ensures operation is within principal's scope
 */
export function guardOrganization(
  principal: FixturePrincipal,
  requestedOrgId: string,
): void {
  if (principal.organizationId !== requestedOrgId) {
    throw new Error(
      `Cross-org access denied: principal ${principal.principalId} ` +
      `scoped to ${principal.organizationId}, requested ${requestedOrgId}`,
    );
  }
}

/**
 * FP-081: Action Guard
 * Ensures principal has permission for action
 */
export function guardAction(principal: FixturePrincipal, action: string): void {
  if (!principal.actions.has(action)) {
    throw new Error(
      `Action denied: principal ${principal.principalId} ` +
      `does not have ${action} permission`,
    );
  }
}

/**
 * FP-081: Expiry Guard
 * Ensures principal credentials are valid
 */
export function guardExpiry(principal: FixturePrincipal): void {
  if (principal.expiresAt < new Date()) {
    throw new Error(
      `Principal ${principal.principalId} credentials expired at ${principal.expiresAt}`,
    );
  }
}

/**
 * FP-081: Combined guard (all checks)
 */
export function guardPrincipal(
  principal: FixturePrincipal,
  action: string,
  organizationId: string,
): void {
  guardExpiry(principal);
  guardOrganization(principal, organizationId);
  guardAction(principal, action);
}

/**
 * FP-081: Audit entry (immutable record)
 */
export interface AuditEntry {
  id: string;
  tenantId: string;
  organizationId: string;
  principalId: string;
  action: string;
  target: string; // document ID or resource
  result: 'SUCCESS' | 'DENIED' | 'ERROR';
  reason?: string;
  timestamp: Date;
}

/**
 * FP-081: Audit log (for compliance)
 */
export class FixtureAuditLog {
  private entries: AuditEntry[] = [];

  record(
    principal: FixturePrincipal,
    action: string,
    target: string,
    result: 'SUCCESS' | 'DENIED' | 'ERROR',
    reason?: string,
  ): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      tenantId: principal.tenantId,
      organizationId: principal.organizationId,
      principalId: principal.principalId,
      action,
      target,
      result,
      reason,
      timestamp: new Date(),
    };

    this.entries.push(entry);
    return entry;
  }

  getEntries(filter?: { action?: string; result?: string }): AuditEntry[] {
    if (!filter) return this.entries;

    return this.entries.filter(
      (e) =>
        (!filter.action || e.action === filter.action) &&
        (!filter.result || e.result === filter.result),
    );
  }

  clear(): void {
    this.entries = [];
  }
}
