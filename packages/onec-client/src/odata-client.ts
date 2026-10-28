import axios, { AxiosInstance } from 'axios';
import { OnecConnectionConfig } from './types';

/**
 * OData client for simple catalog reads and debugging.
 * For sync, prefer OnecHttpClient.getDelta (keyset).
 * OData $skip is slow on large offsets.
 */
export class OnecODataClient {
  private client: AxiosInstance;

  constructor(config: OnecConnectionConfig) {
    this.client = axios.create({
      baseURL: `${config.baseUrl}/${config.baseCode}/odata/standard.odata`,
      auth: { username: config.username, password: config.password },
      timeout: 30_000,
    });
  }

  async query<T = any>(
    entity: string,
    params: {
      top?: number;
      filter?: string;
      select?: string;
      orderby?: string;
      expand?: string;
    } = {},
  ): Promise<T[]> {
    const odataParams: Record<string, any> = { $format: 'json' };
    if (params.top) odataParams['$top'] = params.top;
    if (params.filter) odataParams['$filter'] = params.filter;
    if (params.select) odataParams['$select'] = params.select;
    if (params.orderby) odataParams['$orderby'] = params.orderby;
    if (params.expand) odataParams['$expand'] = params.expand;

    const res = await this.client.get(`/${entity}`, { params: odataParams });
    return res.data.value ?? [];
  }

  async getOne<T = any>(entity: string, guid: string): Promise<T> {
    const res = await this.client.get(`/${entity}(guid'${guid}')`, {
      params: { $format: 'json' },
    });
    return res.data;
  }
}
