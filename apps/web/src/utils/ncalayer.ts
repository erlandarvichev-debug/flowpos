// Клиент NCALayer (НУЦ РК) — подпись на компьютере владельца ЭЦП; ключ и пароль не покидают его компьютер.
// Параметры вызова kz.gov.pki.knca.basics.sign повторяют официальный веб-клиент ИС ЭСФ (esf.gov.kz):
//   вход   — format "xml", ключ аутентификации (EKU 1.3.6.1.5.5.7.3.2);
//   ЭСФ    — format "raw", ключ подписи (EKU 1.3.6.1.5.5.7.3.4), массив строк → массив подписей.

const URL = 'wss://127.0.0.1:13579/'
export const NCALAYER_DOWNLOAD = 'https://pki.gov.kz/ncalayer/'
const EKU_AUTH = '1.3.6.1.5.5.7.3.2'
const EKU_SIGN = '1.3.6.1.5.5.7.3.4'

export class NcaLayerError extends Error {
  constructor(message: string, public code: string) { super(message) }
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket
    try { ws = new WebSocket(URL) } catch { return reject(new NcaLayerError('NCALayer не запущен', 'NOT_RUNNING')) }
    const timer = setTimeout(() => { try { ws.close() } catch { /* */ } reject(new NcaLayerError('NCALayer не отвечает', 'NOT_RUNNING')) }, 5000)
    ws.onopen = () => { clearTimeout(timer); resolve(ws) }
    ws.onerror = () => { clearTimeout(timer); reject(new NcaLayerError('NCALayer не запущен', 'NOT_RUNNING')) }
  })
}

async function sign(format: 'xml' | 'raw', data: string | string[], eku: string, locale = 'ru'): Promise<any> {
  const ws = await connect()
  return new Promise((resolve, reject) => {
    ws.onmessage = (ev) => {
      let r: any
      try { r = JSON.parse(ev.data) } catch { return }
      if (r?.result?.version) return // приветствие с версией
      ws.close()
      if (r?.status && r?.body?.result) resolve(r.body.result)
      else if (r?.status === false && /canceled|cancelled|action\.canceled/i.test(String(r?.code ?? r?.message))) reject(new NcaLayerError('Подпись отменена', 'CANCELED'))
      else reject(new NcaLayerError(r?.message || r?.code || 'NCALayer вернул ошибку', String(r?.code ?? 'ERROR')))
    }
    ws.send(JSON.stringify({
      module: 'kz.gov.pki.knca.basics',
      method: 'sign',
      args: {
        format,
        data,
        signingParams: { decode: 'false', encapsulate: 'true', digested: 'false', tsaProfile: null, outputCert: 'true' },
        signerParams: { extKeyUsageOids: [eku], chain: [] },
        locale,
      },
    }))
  })
}

/** Подпись тикета входа в ИС ЭСФ (XMLDSig, ключ AUTH). */
export async function signAuthXml(xml: string): Promise<string> {
  const r = await sign('xml', xml, EKU_AUTH)
  return Array.isArray(r) ? r[0] : r
}

/** «Сырая» подпись строк (тела ЭСФ) ключом подписи. Возвращает подписи в том же порядке и сертификат. */
export async function signRaw(items: string[]): Promise<{ certificate: string; signatures: string[] }> {
  const r = await sign('raw', items, EKU_SIGN)
  const signatures: string[] = Array.isArray(r?.signatures) ? r.signatures : []
  if (signatures.length !== items.length) throw new NcaLayerError('NCALayer вернул не все подписи', 'PARTIAL')
  return { certificate: String(r?.certificate ?? ''), signatures }
}
