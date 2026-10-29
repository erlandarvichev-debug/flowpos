export type WellFormedResult = { ok: true } | { ok: false; error: string };

const NAME = /^[A-Za-z_][\w.\-]*(:[A-Za-z_][\w.\-]*)?$/;
const ATTR = /\s+([A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?)\s*=\s*("[^"<]*"|'[^'<]*')/y;

function checkAttributes(src: string): string | null {
  ATTR.lastIndex = 0;
  const seen = new Set<string>();
  let pos = 0;
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) return null;
    ATTR.lastIndex = pos;
    const m = ATTR.exec(src);
    if (!m) return `malformed attributes: ${src.slice(pos).trim().slice(0, 40)}`;
    if (seen.has(m[1])) return `duplicate attribute ${m[1]}`;
    seen.add(m[1]);
    pos = ATTR.lastIndex;
  }
  return null;
}

function findTagEnd(xml: string, from: number): number {
  let quote = '';
  for (let j = from; j < xml.length; j++) {
    const c = xml[j];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '<') {
      return -1;
    } else if (c === '>') {
      return j;
    }
  }
  return -1;
}

// DTDs are rejected outright: no XXE, no entity expansion.
export function checkWellFormed(xml: string): WellFormedResult {
  const stack: string[] = [];
  let roots = 0;
  const start = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  let i = start;

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt === -1 ? xml.length : lt);
    if (text.trim() && stack.length === 0) return { ok: false, error: 'text outside root element' };
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(text)) return { ok: false, error: 'unescaped or unknown entity' };
    if (lt === -1) break;

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) return { ok: false, error: 'unterminated comment' };
      i = end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      if (stack.length === 0) return { ok: false, error: 'CDATA outside root element' };
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) return { ok: false, error: 'unterminated CDATA' };
      i = end + 3;
    } else if (xml.startsWith('<!', lt)) {
      return { ok: false, error: 'DTD/DOCTYPE/ENTITY declarations are not allowed' };
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) return { ok: false, error: 'unterminated processing instruction' };
      if (/^<\?xml\s/.test(xml.slice(lt, lt + 6)) && lt !== start) {
        return { ok: false, error: 'XML declaration must be at the start' };
      }
      i = end + 2;
    } else {
      const gt = findTagEnd(xml, lt + 1);
      if (gt === -1) return { ok: false, error: 'unterminated tag' };
      const raw = xml.slice(lt + 1, gt);
      if (raw.startsWith('/')) {
        const name = raw.slice(1).trim();
        const open = stack.pop();
        if (open !== name) return { ok: false, error: `mismatched closing tag </${name}>, expected </${open ?? '(none)'}>` };
      } else {
        const selfClosing = raw.endsWith('/');
        const body = selfClosing ? raw.slice(0, -1) : raw;
        const name = body.match(/^[^\s]+/)?.[0] ?? '';
        if (!NAME.test(name)) return { ok: false, error: `invalid element name "${name}"` };
        const attrError = checkAttributes(body.slice(name.length));
        if (attrError) return { ok: false, error: attrError };
        if (stack.length === 0) {
          roots++;
          if (roots > 1) return { ok: false, error: 'multiple root elements' };
        }
        if (!selfClosing) stack.push(name);
      }
      i = gt + 1;
    }
  }

  if (stack.length) return { ok: false, error: `unclosed element <${stack[stack.length - 1]}>` };
  if (roots === 0) return { ok: false, error: 'no root element' };
  return { ok: true };
}
