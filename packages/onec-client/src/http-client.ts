import axios, { AxiosInstance } from 'axios';
import {
  OnecConnectionConfig, DeltaResponse, DocumentPayload, DocumentResult,
  RefResult, OnecEntity,
} from './types';

export class OnecHttpClient {
  private client: AxiosInstance;
  private readonly baseCode: string;

  constructor(private config: OnecConnectionConfig) {
    this.baseCode = config.baseCode;
    this.client = axios.create({
      baseURL: `${config.baseUrl}/${config.baseCode}/hs/api/v1`,
      auth: { username: config.username, password: config.password },
      timeout: 30_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Pull delta — keyset pagination, no OFFSET
   * GET /delta?entity=product&since=...&afterGuid=...&limit=500
   */
  async getDelta(
    entity: OnecEntity,
    since: string,
    afterGuid?: string,
    limit = 500,
  ): Promise<DeltaResponse> {
    const params: Record<string, any> = { entity, since, limit };
    if (afterGuid) params.afterGuid = afterGuid;

    const res = await this.client.get<DeltaResponse>('/delta', { params });
    return res.data;
  }

  /**
   * Create or update a document in 1С
   * POST /document  with  Idempotency-Key header
   */
  async createDocument(payload: DocumentPayload, idempotencyKey: string): Promise<DocumentResult> {
    const res = await this.client.post<DocumentResult>('/document', payload, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    return res.data;
  }

  async postDocument(guid: string): Promise<DocumentResult> {
    const res = await this.client.post<DocumentResult>(`/document/${guid}/post`);
    return res.data;
  }

  async unpostDocument(guid: string): Promise<DocumentResult> {
    const res = await this.client.post<DocumentResult>(`/document/${guid}/unpost`);
    return res.data;
  }

  /**
   * Create or update a reference object
   */
  async createRef(entity: string, payload: Record<string, any>, idempotencyKey: string): Promise<RefResult> {
    const res = await this.client.post<RefResult>(`/ref/${entity}`, payload, {
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    return res.data;
  }

  async updateRef(entity: string, guid: string, payload: Record<string, any>): Promise<RefResult> {
    const res = await this.client.patch<RefResult>(`/ref/${entity}/${guid}`, payload);
    return res.data;
  }

  async deleteRef(entity: string, guid: string): Promise<void> {
    await this.client.delete(`/${entity}/${guid}`);
  }

  /** Check connectivity */
  async ping(): Promise<boolean> {
    try {
      await this.client.get('/ping', { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}
