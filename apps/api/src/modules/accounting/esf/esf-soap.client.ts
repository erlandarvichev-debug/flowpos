// SOAP-клиент ИС ЭСФ (api1, Apache CXF, document/literal). Описания сервисов — WSDL тестового стенда
// test3.esf.kgd.gov.kz и комплект разработчика КГД (esf-sdk-290824).
// Аутентификация: AuthService.createAuthTicket(iin) → тикет подписывается XMLDSig ключом AUTH на стороне
// владельца ЭЦП (NCALayer) → SessionService.createSessionSigned. Пароли и ключи сервер не хранит.
import { XMLParser } from 'fast-xml-parser';

export const ESF_ENDPOINTS: Record<string, string> = {
  TEST: 'https://test3.esf.kgd.gov.kz:8443/esf-web/ws/api1',
  PROD: 'https://esf.gov.kz:8443/esf-web/ws/api1',
};

/** Ошибка ИС ЭСФ: SOAP Fault или сетевой сбой. sessionClosed — сессию нужно открыть заново. */
export class EsfSoapError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly sessionClosed = false,
  ) {
    super(message);
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ['standardResponse', 'error', 'invoiceInfo', 'invoiceSummary', 'invoiceError', 'profileInfo', 'changeStatusResult', 'id'].includes(name),
});

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface StandardResponse { id?: string; num: string; date: string; errors: { property?: string; errorCode?: string; text?: string }[] }
export interface ChangeStatusResult { invoiceId: string; invoiceStatus?: string; registrationNumber?: string; isChanged: boolean; errorCode?: string; errorText?: string }
export interface InvoiceInfoRaw {
  invoiceBody: string;
  invoiceId?: string;
  registrationNumber?: string;
  invoiceStatus?: string;
  cancelReason?: string;
  lastUpdateDate?: string;
  version?: string;
}

export class EsfSoapClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init as any) as any,
    private readonly timeoutMs = 60000,
  ) {}

  static forEnvironment(env: string, fetcher?: Fetcher) {
    const url = ESF_ENDPOINTS[env];
    if (!url) throw new Error(`Неизвестная среда ИС ЭСФ: ${env}`);
    return new EsfSoapClient(url, fetcher);
  }

  /** Вызов операции: body — содержимое soap:Body (элемент запроса с префиксом esf:). */
  async call(service: string, body: string): Promise<any> {
    const envelope = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:esf="esf"><soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let text: string;
    try {
      const res = await this.fetcher(`${this.baseUrl}/${service}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml;charset=UTF-8', SOAPAction: '""' },
        body: envelope,
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (e: any) {
      throw new EsfSoapError(`ИС ЭСФ недоступна: ${e?.message ?? e}`, 'NETWORK');
    } finally {
      clearTimeout(timer);
    }
    let doc: any;
    try {
      doc = parser.parse(text);
    } catch {
      throw new EsfSoapError('ИС ЭСФ вернула неразборчивый ответ', 'BAD_RESPONSE');
    }
    const bodyEl = doc?.Envelope?.Body;
    if (!bodyEl) throw new EsfSoapError('ИС ЭСФ вернула ответ без SOAP Body', 'BAD_RESPONSE');
    if (bodyEl.Fault) {
      const f = bodyEl.Fault;
      const detail = f.detail ?? {};
      const kind = Object.keys(detail)[0] ?? '';
      const desc = detail[kind]?.description ?? f.faultstring ?? 'Ошибка ИС ЭСФ';
      const sessionClosed = /sessionClosed/i.test(kind) || /session/i.test(String(desc)) && /clos|закрыт|не найдена|not found|expired/i.test(String(desc));
      const code = /accessDenied/i.test(kind) ? 'ACCESS_DENIED' : sessionClosed ? 'SESSION_CLOSED' : /SecurityError/i.test(String(f.faultcode)) ? 'SECURITY_ERROR' : 'FAULT';
      throw new EsfSoapError(String(desc), code, sessionClosed);
    }
    const key = Object.keys(bodyEl)[0];
    return bodyEl[key];
  }

  // ── Аутентификация ──

  async createAuthTicket(iin: string, ttlInMinutes = 60): Promise<string> {
    const r = await this.call('AuthService', `<esf:createAuthTicketRequest><iin>${esc(iin)}</iin><ttlInMinutes>${ttlInMinutes}</ttlInMinutes></esf:createAuthTicketRequest>`);
    if (!r?.authTicketXml) throw new EsfSoapError('ИС ЭСФ не выдала тикет аутентификации', 'BAD_RESPONSE');
    return String(r.authTicketXml);
  }

  async createSessionSigned(tin: string, signedAuthTicket: string): Promise<string> {
    const r = await this.call('SessionService', `<esf:createSessionSignedRequest><tin>${esc(tin)}</tin><signedAuthTicket>${esc(signedAuthTicket)}</signedAuthTicket><sourceType>OTHER</sourceType></esf:createSessionSignedRequest>`);
    if (!r?.sessionId) throw new EsfSoapError('ИС ЭСФ не открыла сессию', 'BAD_RESPONSE');
    return String(r.sessionId);
  }

  async currentSessionStatus(sessionId: string): Promise<string> {
    const r = await this.call('SessionService', `<esf:currentSessionStatusRequest><sessionId>${esc(sessionId)}</sessionId></esf:currentSessionStatusRequest>`);
    return String(r?.status ?? '');
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.call('SessionService', `<esf:closeSessionRequest><sessionId>${esc(sessionId)}</sessionId></esf:closeSessionRequest>`);
  }

  async currentUserProfiles(sessionId: string): Promise<{ iin?: string; tin?: string; businessProfileType?: string; status?: string }[]> {
    const r = await this.call('SessionService', `<esf:currentUserProfilesRequest><sessionId>${esc(sessionId)}</sessionId></esf:currentUserProfilesRequest>`);
    return r?.profileInfoList?.profileInfo ?? [];
  }

  // ── Исходящие ЭСФ ──

  async syncInvoice(sessionId: string, certificate: string, items: { body: string; signature: string; signatureType: string; version: string }[]): Promise<{ accepted: StandardResponse[]; declined: StandardResponse[] }> {
    const infos = items
      .map((i) => `<invoiceUploadInfo><invoiceBody>${esc(i.body)}</invoiceBody><version>${esc(i.version)}</version><signature>${esc(i.signature)}</signature><signatureType>${esc(i.signatureType)}</signatureType></invoiceUploadInfo>`)
      .join('');
    const r = await this.call('UploadInvoiceService', `<esf:syncInvoiceRequest><sessionId>${esc(sessionId)}</sessionId><invoiceUploadInfoList>${infos}</invoiceUploadInfoList><x509Certificate>${esc(certificate)}</x509Certificate></esf:syncInvoiceRequest>`);
    const norm = (list: any[]): StandardResponse[] =>
      (list ?? []).map((s) => ({ id: s.id, num: String(s.num), date: String(s.date), errors: (s.errors?.error ?? []).map((e: any) => ({ property: e.property, errorCode: e.errorCode, text: e.text })) }));
    return { accepted: norm(r?.acceptedSet?.standardResponse), declined: norm(r?.declinedSet?.standardResponse) };
  }

  async queryInvoiceSummaryById(sessionId: string, ids: string[]): Promise<{ invoiceId: string; invoiceStatus?: string; registrationNumber?: string; cancelReason?: string; num?: string; date?: string; lastUpdateDate?: string }[]> {
    const r = await this.call('InvoiceService', `<esf:queryInvoiceSummaryByIdRequest><sessionId>${esc(sessionId)}</sessionId><idList>${ids.map((i) => `<id>${esc(i)}</id>`).join('')}</idList></esf:queryInvoiceSummaryByIdRequest>`);
    return r?.invoiceSummaryList?.invoiceSummary ?? [];
  }

  async queryInvoiceErrorById(sessionId: string, ids: string[]): Promise<{ invoiceId: string; errors: { property?: string; errorCode?: string; text?: string }[] }[]> {
    const r = await this.call('InvoiceService', `<esf:queryInvoiceErrorByIdRequest><sessionId>${esc(sessionId)}</sessionId><idList>${ids.map((i) => `<id>${esc(i)}</id>`).join('')}</idList></esf:queryInvoiceErrorByIdRequest>`);
    return (r?.invoiceErrorList?.invoiceError ?? []).map((e: any) => ({ invoiceId: String(e.invoiceId), errors: e.errors?.error ?? [] }));
  }

  /** Поиск по дате выписки и номеру учётной системы — для повторной сверки после сбоя связи. */
  async queryInvoiceSummaryByKey(sessionId: string, direction: 'INBOUND' | 'OUTBOUND', keys: { date: string; num: string }[]) {
    const r = await this.call('InvoiceService', `<esf:queryInvoiceSummaryByKeyRequest><sessionId>${esc(sessionId)}</sessionId><invoiceKeyList>${keys.map((k) => `<invoiceKey><date>${esc(k.date)}</date><num>${esc(k.num)}</num></invoiceKey>`).join('')}</invoiceKeyList><direction>${direction}</direction></esf:queryInvoiceSummaryByKeyRequest>`);
    return (r?.invoiceSummaryList?.invoiceSummary ?? []) as { invoiceId: string; invoiceStatus?: string; registrationNumber?: string; num?: string; date?: string }[];
  }

  // ── Входящие ЭСФ ──

  async queryUpdates(sessionId: string, direction: 'INBOUND' | 'OUTBOUND', lastEventDate: Date, lastInvoiceId?: string | null, limit = 100): Promise<{ lastEventDate: string; lastInvoiceId?: string; lastBlock: boolean; items: InvoiceInfoRaw[] }> {
    const r = await this.call(
      'InvoiceService',
      `<esf:queryUpdatesRequest><sessionId>${esc(sessionId)}</sessionId><lastEventDate>${lastEventDate.toISOString()}</lastEventDate>${lastInvoiceId ? `<lastInvoiceId>${esc(lastInvoiceId)}</lastInvoiceId>` : ''}<direction>${direction}</direction><limit>${limit}</limit><fullInfoOnStatusChange>true</fullInfoOnStatusChange></esf:queryUpdatesRequest>`,
    );
    return {
      lastEventDate: String(r?.lastEventDate ?? lastEventDate.toISOString()),
      lastInvoiceId: r?.lastInvoiceId,
      lastBlock: String(r?.lastBlock) !== 'false',
      items: r?.invoiceInfoList?.invoiceInfo ?? [],
    };
  }

  /** Отметка «получено» по входящим ЭСФ (статус DELIVERED). */
  async confirmInvoiceById(sessionId: string, ids: string[]) {
    const r = await this.call('InvoiceService', `<esf:confirmInvoiceByIdRequest><sessionId>${esc(sessionId)}</sessionId><idList>${ids.map((i) => `<id>${esc(i)}</id>`).join('')}</idList></esf:confirmInvoiceByIdRequest>`);
    return r?.invoiceSummaryList?.invoiceSummary ?? [];
  }
  // ── Смена статуса с подписью (отзыв, отклонение, подтверждение) ──

  private changeResults(r: any): ChangeStatusResult[] {
    return (r?.resultList?.changeStatusResult ?? []).map((c: any) => {
      const sm = Array.isArray(c.invoiceSummary) ? c.invoiceSummary[0] : c.invoiceSummary;
      return {
      invoiceId: String(sm?.invoiceId ?? ''),
      invoiceStatus: sm?.invoiceStatus,
      registrationNumber: sm?.registrationNumber,
      isChanged: String(c.isChanged) === 'true',
      errorCode: c.errorCode,
      errorText: c.errorText,
      };
    });
  }

  /** revokeInvoiceById / declineInvoiceById: подпись — над signableIdWithReasonList(items). */
  async changeWithReason(op: 'revokeInvoiceById' | 'declineInvoiceById' | 'unrevokeInvoiceById', sessionId: string, signature: string, certificate: string, items: { id: string; reason: string }[]): Promise<ChangeStatusResult[]> {
    const list = items.map((i) => `<invoiceIdWithReason><id>${esc(i.id)}</id><reason>${esc(i.reason)}</reason></invoiceIdWithReason>`).join('');
    const r = await this.call('InvoiceService', `<esf:${op}Request><sessionId>${esc(sessionId)}</sessionId><signature>${esc(signature)}</signature><x509Certificate>${esc(certificate)}</x509Certificate><idWithReasonList>${list}</idWithReasonList></esf:${op}Request>`);
    return this.changeResults(r);
  }

  /** approveInvoiceById / revokeConfirmInvoiceById: подпись — над signableIdList(ids). */
  async changeByIds(op: 'approveInvoiceById' | 'revokeConfirmInvoiceById', sessionId: string, signature: string, certificate: string, ids: string[]): Promise<ChangeStatusResult[]> {
    const r = await this.call('InvoiceService', `<esf:${op}Request><sessionId>${esc(sessionId)}</sessionId><signature>${esc(signature)}</signature><x509Certificate>${esc(certificate)}</x509Certificate><invoiceIdList><ids>${ids.map((i) => `<id>${esc(i)}</id>`).join('')}</ids></invoiceIdList></esf:${op}Request>`);
    return this.changeResults(r);
  }
}
