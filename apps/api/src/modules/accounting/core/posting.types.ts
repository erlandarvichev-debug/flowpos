import { Dim } from '../chart/kz-chart.data';

export type Ledger = 'BU' | 'NU';
export type Side = 'D' | 'C';

/** Проводка в терминах правила: счёт по коду, суммы строками/Decimal. */
export interface PostingInput {
  ledger?: Ledger;
  side: Side;
  account: string; // код счёта
  amount: string | number; // тенге, может быть отрицательной (красное сторно)
  currency?: string;
  currencyAmount?: string | number;
  quantity?: string | number;
  dims?: Partial<Record<Dim, string>>;
  memo?: string;
}

/** Складское движение (для расчёта себестоимости). */
export interface StockMoveInput {
  lineNo: number;
  productId: string;
  storeId: string;
  account: string;
  direction: 'IN' | 'OUT';
  kind: string;
  quantity: string;
  knownCost?: string | null;
  costAccount?: string | null;
  pairKey?: string | null;
  meta?: any;
}

export interface EntryInput {
  sourceType: string;
  sourceId: string;
  sourceVersion: number;
  ruleCode: string;
  ruleVersion: string;
  date: Date;
  postings: PostingInput[];
  moves?: StockMoveInput[];
  /** Разрешить запись без проводок (документ только со складскими движениями). */
  allowEmpty?: boolean;
}
