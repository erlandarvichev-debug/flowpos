import { z } from 'zod';

// ─── Pagination ───────────────────────────────────────────────────────────────

export interface PageMeta {
  nextCursor?: string | null;
  hasMore: boolean;
  total?: number;
}

export interface PageResult<T> {
  data: T[];
  meta: PageMeta;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
// FP-008: JWT payload with tenantId and grants (action-based RBAC)

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});
export type LoginDto = z.infer<typeof LoginSchema>;

export interface Grant {
  organizationId: string;
  action: string; // read, draft, approve, send, reconcile, etc.
  scope: string; // organization, department, project
}

// FP-008: JWT payload (15min access token)
export interface TokenPayload {
  sub: string; // user ID
  email: string;
  tenantId: string; // Immutable from JWT, cannot be overridden by client
  organizationId: string; // Default org (can switch via header)
  grants: Grant[]; // Action-based RBAC per organization
  iat: number;
  exp: number;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: UserProfile;
}

// FP-008: User profile with grants (not roles)
export interface UserProfile {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  tenantId: string;
  organizationId: string;
  organization?: any; // Organization object
  grants: Grant[]; // List of action+org+scope
}

// ─── Sync ────────────────────────────────────────────────────────────────────

export type SyncStatus = 'SYNCED' | 'DIRTY' | 'PENDING' | 'ERROR' | 'CONFLICT';
export type Owner = 'PLATFORM' | 'C1' | 'MANUAL';
export type OutboxStatus = 'PENDING' | 'SENDING' | 'DONE' | 'ERROR' | 'DEAD';
export type SyncDir = 'PULL' | 'PUSH';

export interface OutboxQueueStatus {
  pending: number;
  sending: number;
  done: number;
  error: number;
  dead: number;
}

// ─── Products ────────────────────────────────────────────────────────────────

export const CreateProductSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  article: z.string().optional(),
  kind: z.enum(['PRODUCT', 'SERVICE', 'BUNDLE', 'VARIANT']).default('PRODUCT'),
  groupId: z.string().uuid().optional(),
  uomId: z.string().uuid(),
  vatRate: z.number().optional(),
  barcode: z.string().optional(),
  attributes: z.record(z.any()).optional(),
});
export type CreateProductDto = z.infer<typeof CreateProductSchema>;

// ─── Documents ───────────────────────────────────────────────────────────────

export const DocLineSchema = z.object({
  productId: z.string().uuid(),
  qty: z.number().positive(),
  price: z.number().optional(),
  discount: z.number().optional(),
  vatRate: z.number().optional(),
});

export const CreateDocumentSchema = z.object({
  docType: z.string(),
  date: z.string(),
  organizationId: z.string().uuid().optional(),
  counterpartyId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  storeToId: z.string().uuid().optional(),
  contractId: z.string().uuid().optional(),
  comment: z.string().optional(),
  attributes: z.record(z.any()).optional(),
  lines: z.array(DocLineSchema),
});
export type CreateDocumentDto = z.infer<typeof CreateDocumentSchema>;

// ─── POS Sale ─────────────────────────────────────────────────────────────────

export const POSSaleSchema = z.object({
  posId: z.string(),
  shiftId: z.string().uuid(),
  datetime: z.string(),
  items: z.array(z.object({
    barcode: z.string(),
    qty: z.number().positive(),
    price: z.number(),
    discount: z.number().default(0),
  })),
  payments: z.array(z.object({
    type: z.enum(['CASH', 'CARD', 'QR', 'MIXED']),
    amount: z.number(),
  })),
  customer: z.string().uuid().optional().nullable(),
});
export type POSSaleDto = z.infer<typeof POSSaleSchema>;

// ─── HR ──────────────────────────────────────────────────────────────────────

export const CreateEmployeeSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  middleName: z.string().optional(),
  positionId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'SELF_EMPLOYED']).default('FULL_TIME'),
  hireDate: z.string().optional(),
  salary: z.number().optional(),
  hourlyRate: z.number().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  inn: z.string().optional(),
});
export type CreateEmployeeDto = z.infer<typeof CreateEmployeeSchema>;
