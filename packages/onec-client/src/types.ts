export interface OnecConnectionConfig {
  baseUrl: string;
  baseCode: string;
  username: string;
  password: string;
  instanceType: 'ONPREM' | 'FRESH';
}

export interface DeltaItem {
  guid: string;
  version: string;
  deletionMark: boolean;
  data: Record<string, any>;
}

export interface DeltaResponse {
  items: DeltaItem[];
  nextSince: string;
  nextGuid?: string;
  hasMore: boolean;
}

export interface DocumentPayload {
  docType: string;
  number?: string | null;
  date: string;
  organization?: string;
  counterparty?: string;
  store?: string;
  storeTo?: string;
  contract?: string;
  lines: DocumentLinePayload[];
  attributes?: Record<string, any>;
  post?: boolean;
}

export interface DocumentLinePayload {
  product: string;
  qty: number;
  price?: number;
  discount?: number;
  vatRate?: number;
}

export interface DocumentResult {
  guid: string;
  number: string;
  version: string;
  posted: boolean;
}

export interface RefResult {
  guid: string;
  version: string;
}

export type OnecEntity =
  | 'product' | 'product_group' | 'counterparty' | 'uom'
  | 'price_type' | 'price' | 'store' | 'employee' | 'currency';
