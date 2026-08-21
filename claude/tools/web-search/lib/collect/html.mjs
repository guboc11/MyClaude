// HTML 을 조각으로 훑는다 — 텍스트와 링크가 함께 쓰는 바닥.
//
// 왜 직접 쓰는가: 이 도구에는 바깥 꾸러미가 없다(package.json 도 node_modules 도 없다).
// 그리고 필요한 것은 완전한 DOM 이 아니라 **문서에 나온 순서대로 훑기** 다.
// 텍스트도 링크도 "순서" 가 계약이므로 조각 흐름 하나면 족하다.
//
// [지우지 않는다] 계획서 4-6: "주 내용을 추측해 삭제하지 않음".
// nav·footer 를 군더더기로 보고 버리는 판단은 여기서 하지 않는다. 어디서 나왔는지만 적어 두고,
// 무엇이 본문인지는 에이전트가 정한다.

/** 닫는 태그가 없는 것들. */
export const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** 안쪽을 태그로 읽지 않는 것들. 여기 들어가면 닫는 태그를 만날 때까지 통째로 글자다. */
export const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

/** 줄이 갈리는 자리. 이 태그를 만나면 텍스트에 경계를 넣는다. */
export const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
  'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'ul',
]);

/** 어디서 나온 링크인지 적을 때 쓰는 자리 이름. */
export const LANDMARKS = new Set(['nav', 'header', 'footer', 'main', 'aside', 'article', 'form']);

// ── 엔티티 ────────────────────────────────────────────────────

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  thinsp: ' ', shy: '­', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', deg: '°',
  laquo: '«', raquo: '»', times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§',
  para: '¶', dagger: '†', permil: '‰', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
};

/** 실체 참조를 글자로. 모르는 것은 건드리지 않고 그대로 둔다 — 지어내지 않는다. */
export function decodeEntities(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const named = NAMED[body] ?? NAMED[body.toLowerCase()];
    return named ?? whole;
  });
}

// ── 조각 훑기 ─────────────────────────────────────────────────

const ATTR_RE = /([^\s/=>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(source) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(source)) !== null) {
    const name = m[1].toLowerCase();
    if (name === '/' || !name) continue;
    const raw = m[2] ?? m[3] ?? m[4] ?? '';
    out[name] = decodeEntities(raw);
  }
  return out;
}

/**
 * 문서를 나온 순서대로 조각으로 낸다.
 *
 * 조각 종류: `text`(글자) · `open`(여는 태그) · `close`(닫는 태그) · `raw`(script·style 안쪽) ·
 * `comment`(주석) · `decl`(doctype 같은 선언)
 *
 * @param {string} html
 */
export function* tokenize(html) {
  const src = String(html ?? '');
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      if (i < src.length) yield { type: 'text', value: src.slice(i) };
      return;
    }
    if (lt > i) yield { type: 'text', value: src.slice(i, lt) };

    // 주석
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      const stop = end === -1 ? src.length : end + 3;
      yield { type: 'comment', value: src.slice(lt + 4, end === -1 ? src.length : end) };
      i = stop;
      continue;
    }
    // 선언·처리 지시
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt);
      const stop = end === -1 ? src.length : end + 1;
      yield { type: 'decl', value: src.slice(lt, stop) };
      i = stop;
      continue;
    }
    // 닫는 태그
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt);
      const stop = end === -1 ? src.length : end + 1;
      const name = src.slice(lt + 2, end === -1 ? src.length : end).trim().toLowerCase();
      if (name) yield { type: 'close', name };
      i = stop;
      continue;
    }
    // 태그가 아니라 그냥 '<' 인 경우
    if (!/[a-zA-Z]/.test(src[lt + 1] ?? '')) {
      yield { type: 'text', value: '<' };
      i = lt + 1;
      continue;
    }

    // 여는 태그
    const end = src.indexOf('>', lt);
    const stop = end === -1 ? src.length : end + 1;
    const inner = src.slice(lt + 1, end === -1 ? src.length : end);
    const nameMatch = inner.match(/^([a-zA-Z][^\s/>]*)/);
    const name = (nameMatch ? nameMatch[1] : '').toLowerCase();
    const selfClosing = inner.trimEnd().endsWith('/') || VOID_ELEMENTS.has(name);
    yield { type: 'open', name, attrs: parseAttrs(inner.slice(name.length)), selfClosing };
    i = stop;

    // script·style 안쪽은 태그로 읽지 않는다
    if (!selfClosing && RAW_TEXT_ELEMENTS.has(name)) {
      const closeAt = src.toLowerCase().indexOf(`</${name}`, i);
      const rawEnd = closeAt === -1 ? src.length : closeAt;
      yield { type: 'raw', name, value: src.slice(i, rawEnd) };
      if (closeAt === -1) return;
      const gt = src.indexOf('>', closeAt);
      yield { type: 'close', name };
      i = gt === -1 ? src.length : gt + 1;
    }
  }
}

// ── 인코딩 ────────────────────────────────────────────────────

/** Content-Type 에 적힌 charset. 없으면 null. */
export function charsetFromContentType(contentType) {
  const m = String(contentType ?? '').match(/charset\s*=\s*"?([\w-]+)"?/i);
  return m ? m[1].toLowerCase() : null;
}

/** 문서 앞부분의 <meta charset> 또는 <meta http-equiv="content-type">. */
export function charsetFromMeta(buf) {
  // 앞 2KB 만 본다. 규격도 그쯤에서 선언하라고 하고, 더 뒤에 있으면 브라우저도 못 본다.
  const head = buf.subarray(0, 2048).toString('latin1');
  const direct = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i);
  if (direct) return direct[1].toLowerCase();
  const equiv = head.match(/<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i);
  return equiv ? equiv[1].toLowerCase() : null;
}

/**
 * 바이트를 글자로. Content-Type → meta → utf-8 순으로 본다.
 * 모르는 이름이면 utf-8 로 읽고 무엇을 시도했는지 남긴다 — 조용히 깨진 글자를 내지 않는다.
 *
 * @returns {{text:string, charset:string, declared:string|null, source:'header'|'meta'|'default', fallback:boolean}}
 */
export function decodeHtml(buf, contentType) {
  const fromHeader = charsetFromContentType(contentType);
  const fromMeta = fromHeader ? null : charsetFromMeta(buf);
  const declared = fromHeader ?? fromMeta;
  const source = fromHeader ? 'header' : (fromMeta ? 'meta' : 'default');
  const wanted = declared ?? 'utf-8';

  try {
    const text = new TextDecoder(wanted, { fatal: false }).decode(buf);
    return { text, charset: wanted, declared, source, fallback: false };
  } catch {
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(buf), charset: 'utf-8', declared, source, fallback: true };
  }
}
