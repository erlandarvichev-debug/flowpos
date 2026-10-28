import axios, { AxiosInstance } from 'axios';
import {
  MoyskladConnectionConfig, MsListResponse, MsProduct, MsCounterparty,
  MsStore, MsProductFolder, MsUom, MsPriceType, MsEntity,
} from './types';

const BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';

export class MoyskladHttpClient {
  private readonly client: AxiosInstance;

  constructor(private config: MoyskladConnectionConfig) {
    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip',
      },
      timeout: 30_000,
    });
  }

  private async getList<T>(path: string, params: Record<string, any> = {}): Promise<MsListResponse<T>> {
    const res = await this.client.get<MsListResponse<T>>(path, { params });
    return res.data;
  }

  /** Итеративно тянет все страницы начиная с updatedFrom */
  async *iterateDelta<T>(entity: MsEntity, updatedFrom?: string): AsyncGenerator<T[]> {
    const limit = 1000;
    let offset = 0;

    const params: Record<string, any> = { limit, offset, order: 'updated,asc' };
    if (updatedFrom) params.filter = `updated>${updatedFrom}`;

    while (true) {
      params.offset = offset;
      const resp = await this.getList<T>(`/entity/${entity}`, params);

      if (resp.rows.length > 0) yield resp.rows;

      if (offset + limit >= resp.meta.size) break;
      offset += limit;
    }
  }

  async getProducts(updatedFrom?: string): Promise<AsyncGenerator<MsProduct[]>> {
    return this.iterateDelta<MsProduct>('product', updatedFrom);
  }

  async getCounterparties(updatedFrom?: string): Promise<AsyncGenerator<MsCounterparty[]>> {
    return this.iterateDelta<MsCounterparty>('counterparty', updatedFrom);
  }

  async getStores(updatedFrom?: string): Promise<AsyncGenerator<MsStore[]>> {
    return this.iterateDelta<MsStore>('store', updatedFrom);
  }

  async getProductFolders(updatedFrom?: string): Promise<AsyncGenerator<MsProductFolder[]>> {
    return this.iterateDelta<MsProductFolder>('productfolder', updatedFrom);
  }

  async getUoms(updatedFrom?: string): Promise<AsyncGenerator<MsUom[]>> {
    return this.iterateDelta<MsUom>('uom', updatedFrom);
  }

  async getPriceTypes(): Promise<MsPriceType[]> {
    const resp = await this.getList<MsPriceType>('/context/companysettings/pricetype');
    return resp.rows;
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.get('/context/employee', { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}
