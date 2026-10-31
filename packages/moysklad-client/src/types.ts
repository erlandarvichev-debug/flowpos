export interface MoyskladConnectionConfig {
  token: string;
  accountId?: string;
}

export interface MsMeta {
  href: string;
  type: string;
  mediaType: string;
}

export interface MsListResponse<T> {
  meta: {
    href: string;
    type: string;
    limit: number;
    offset: number;
    size: number;
    nextHref?: string;
  };
  rows: T[];
}

export interface MsProduct {
  id: string;
  accountId: string;
  updated: string;
  name: string;
  code?: string;
  article?: string;
  description?: string;
  pathName?: string;
  deleted?: boolean;
  archived: boolean;
  vat?: number;
  vatEnabled?: boolean;
  uom?: { meta: MsMeta; id: string };
  productFolder?: { meta: MsMeta; id: string };
  barcodes?: Array<{ ean13?: string; ean8?: string; code128?: string; gtin?: string; upc?: string }>;
  salePrices?: Array<{ value: number; priceType?: { meta: MsMeta; id: string; name: string } }>;
  meta: MsMeta;
}

export interface MsCounterparty {
  id: string;
  accountId: string;
  updated: string;
  name: string;
  fullName?: string;
  inn?: string;
  kpp?: string;
  phone?: string;
  email?: string;
  deleted?: boolean;
  archived: boolean;
  companyType?: 'legal' | 'entrepreneur' | 'individual';
  meta: MsMeta;
}

export interface MsStore {
  id: string;
  accountId: string;
  updated: string;
  name: string;
  code?: string;
  address?: string;
  deleted?: boolean;
  archived: boolean;
  meta: MsMeta;
}

export interface MsProductFolder {
  id: string;
  accountId: string;
  updated: string;
  name: string;
  code?: string;
  pathName?: string;
  deleted?: boolean;
  archived: boolean;
  productFolder?: { meta: MsMeta; id: string };
  meta: MsMeta;
}

export interface MsUom {
  id: string;
  accountId: string;
  updated: string;
  name: string;
  code?: string;
  description?: string;
  meta: MsMeta;
}

export interface MsPriceType {
  id: string;
  name: string;
  externalCode: string;
  meta: MsMeta;
}

export type MsEntity = 'product' | 'counterparty' | 'store' | 'productfolder' | 'uom' | 'pricetype';
