// FP-022: маскирование секретов в логах, оповещениях и сообщениях об ошибках.
// Логи и вебхуки уходят за пределы БД (journald, мессенджер дежурного) — подписи, сертификаты, тикеты входа,
// токены, сессии ИС ЭСФ и пароли в адресах туда попадать не должны. Маскируется по форме значения, а не по
// месту вызова: так закрываются и чужие сообщения (ошибки Prisma с аргументами запроса, ответы SOAP).

const MASK = '[скрыто]';

const RULES: [RegExp, string | ((...m: string[]) => string)][] = [
  // PEM: сертификаты, ключи.
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g, `-----${MASK}-----`],
  // XMLDSig подписанного тикета/документа.
  [/<((?:\w+:)?(?:SignatureValue|X509Certificate|DigestValue))\b[^>]*>[\s\S]*?<\/\1>/g, (_m, tag) => `<${tag}>${MASK}</${tag}>`],
  // JWT.
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g, MASK],
  // Authorization: Bearer …
  [/\b(Bearer|Basic)\s+[\w\-.~+/=]{8,}/gi, `$1 ${MASK}`],
  // Пароль в адресе: scheme://user:pass@host.
  [/(\b[a-z][\w+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  // ключ=значение / "ключ": "значение" / <ключ>значение</ключ> для чувствительных имён.
  // Имена полей — в стиле кода (camelCase/snake_case); коды ошибок вида ESF_SIGNATURE_INVALID не трогаются.
  [/(["']?\b(?:[a-z][\w-]*)?(?:[Pp]assword|passwd|[Ss]ecret|[Tt]oken|apiKey|api_key|[Ss]essionId|session_id|[Ss]ignature|[Cc]ertificate|[Tt]icket|[Aa]uthorization|[Cc]ookie)\w*["']?\s*[:=]\s*)(\[скрыто\]|"[^"]*"|'[^']*'|[^\s,;&}\]]+)/g, `$1${MASK}`],
  // Переменные окружения: DB_PASSWORD=…, JWT_SECRET=…
  [/\b([A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY)=)\S+/g, `$1${MASK}`],
  [/<((?:\w+:)?(?:sessionId|signature|certificate|signedAuthTicket|authTicketXml|password|x509Certificate))>[\s\S]*?<\/\1>/gi, (_m, tag) => `<${tag}>${MASK}</${tag}>`],
  // Длинные base64-блоки (подписи, сертификаты без PEM, тела в base64).
  [/[A-Za-z0-9+/]{120,}={0,2}/g, MASK],
];

/** Строка без секретов. Идемпотентна. */
export function redact(input: unknown): string {
  let s = typeof input === 'string' ? input : input instanceof Error ? `${input.name}: ${input.message}` : safeJson(input);
  for (const [re, to] of RULES) s = s.replace(re, to as any);
  return s;
}

/** Объект для журнала/вебхука: строки маскируются, чувствительные ключи заменяются целиком. */
export function redactValue<T>(v: T, depth = 0): T {
  if (depth > 6) return MASK as any;
  if (typeof v === 'string') return redact(v) as any;
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1)) as any;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SENSITIVE_KEY.test(k) ? MASK : redactValue(x, depth + 1);
    return out as any;
  }
  return v;
}

const SENSITIVE_KEY = /password|passwd|secret|token|apikey|api_key|sessionid|session_id|signature|certificate|ticket|authorization|cookie/i;

function safeJson(v: unknown) {
  try {
    return typeof v === 'object' ? JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) : String(v);
  } catch {
    return String(v);
  }
}
