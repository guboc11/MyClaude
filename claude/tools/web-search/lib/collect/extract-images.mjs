// 그림 참조를 나온 순서대로 — 어디에 적혀 있었는지까지.
//
// 계획서 4-6·태스크 #27. 모으는 것은 넷이다.
//   img 의 src · img 의 srcset · picture 안 source 의 srcset · OpenGraph 대표 그림
//
// [의미로 거르지 않는다] 로고·아이콘·광고처럼 보인다고 빼지 않는다. 크기가 작다고도 빼지 않는다.
// 무엇이 쓸모 있는 그림인지는 에이전트가 정한다. 여기서는 문서에 적힌 것을 그대로 모은다.
//
// 같은 주소가 여러 번 나오면 **줄은 하나**이고 참조가 여러 개다. 그래야 나중에
// "성공한 줄 = 실제 파일" 이 1:1 로 맞는다.

import { LANDMARKS, tokenize } from './html.mjs';
import { UrlError, normalizeUrl } from '../url.mjs';

/**
 * srcset 을 후보로 가른다.
 *
 * `"a.png 1x, b.png 2x"` 또는 `"a.png 300w, b.png 600w"`.
 * data: URI 는 안에 쉼표가 있어서 단순히 쉼표로 자르면 깨진다 — 그 경우만 따로 본다.
 */
export function parseSrcset(value) {
  const out = [];
  const s = String(value ?? '').trim();
  if (!s) return out;

  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;

    let url;
    if (s.startsWith('data:', i)) {
      // data: 는 쉼표 뒤가 본문이다. 공백이 나올 때까지가 주소다.
      let j = i;
      while (j < s.length && !/\s/.test(s[j])) j++;
      url = s.slice(i, j);
      i = j;
    } else {
      let j = i;
      while (j < s.length && !/[\s,]/.test(s[j])) j++;
      url = s.slice(i, j);
      i = j;
    }
    // 뒤에 붙은 크기표(1x·300w)는 건너뛴다
    while (i < s.length && s[i] !== ',') i++;
    i++;
    if (url) out.push(url);
  }
  return out;
}

/**
 * @param {string} html
 * @param {string} pageUrl  이 문서가 실제로 도착한 주소. 상대 주소의 기준이다.
 * @returns {{
 *   images: {url, raw, references, kind}[],
 *   counts: {unique, references, from_src, from_srcset, from_source, from_og, data_uri, unresolvable, no_src},
 *   base_href: string|null
 * }}
 */
export function extractImageRefs(html, pageUrl) {
  const byUrl = new Map();          // canonical_url → 줄
  const loose = [];                 // 주소를 못 읽었거나 아예 없는 것들
  const landmarks = [];
  let baseHref = null;
  let base = pageUrl;
  let domIndex = 0;
  let inPicture = 0;

  const add = (rawHref, ref) => {
    const raw = String(rawHref ?? '').trim();
    if (!raw) { loose.push({ url: null, raw: null, kind: 'no_src', references: [ref] }); return; }

    if (/^data:/i.test(raw)) {
      // 문서 안에 든 그림이다. 이미 dom.html.gz 에 바이트가 들어 있으므로 따로 받지 않는다.
      loose.push({ url: null, raw, kind: 'data_uri', references: [ref] });
      return;
    }

    let canonical;
    try {
      canonical = normalizeUrl(new URL(raw, base).toString()).canonical_url;
    } catch (e) {
      if (!(e instanceof UrlError) && !(e instanceof TypeError)) throw e;
      loose.push({ url: null, raw, kind: 'unresolvable', references: [ref] });
      return;
    }

    const row = byUrl.get(canonical);
    if (row) { row.references.push(ref); if (!row.raw.includes(raw)) row.raw.push(raw); return; }
    byUrl.set(canonical, { url: canonical, raw: [raw], kind: 'http', references: [ref] });
  };

  for (const t of tokenize(html)) {
    if (t.type !== 'open') {
      if (t.type === 'close') {
        if (t.name === 'picture' && inPicture > 0) inPicture--;
        if (LANDMARKS.has(t.name)) {
          for (let k = landmarks.length - 1; k >= 0; k--) if (landmarks[k] === t.name) { landmarks.length = k; break; }
        }
      }
      continue;
    }
    if (LANDMARKS.has(t.name) && !t.selfClosing) landmarks.push(t.name);
    if (t.name === 'picture') { inPicture++; continue; }
    if (t.name === 'base' && t.attrs.href && baseHref === null) {
      baseHref = t.attrs.href;
      try { base = new URL(baseHref, pageUrl).toString(); } catch { /* 못 읽으면 원래 주소 */ }
      continue;
    }

    const where = landmarks.length ? landmarks[landmarks.length - 1] : 'body';

    if (t.name === 'meta') {
      const prop = String(t.attrs.property ?? t.attrs.name ?? '').toLowerCase();
      if (prop === 'og:image' || prop === 'og:image:url' || prop === 'twitter:image') {
        add(t.attrs.content, { from: prop, dom_index: domIndex++, where: 'head', alt: null, width: null, height: null });
      }
      continue;
    }

    if (t.name === 'source' && inPicture > 0) {
      const idx = domIndex++;
      for (const u of parseSrcset(t.attrs.srcset)) {
        add(u, { from: 'picture.source.srcset', dom_index: idx, where, alt: null, width: null, height: null, type: t.attrs.type ?? null });
      }
      if (t.attrs.src) add(t.attrs.src, { from: 'picture.source.src', dom_index: idx, where, alt: null, width: null, height: null });
      continue;
    }

    if (t.name !== 'img') continue;
    const idx = domIndex++;
    const meta = { dom_index: idx, where, alt: t.attrs.alt ?? null, width: t.attrs.width ?? null, height: t.attrs.height ?? null };
    if (t.attrs.src === undefined && t.attrs.srcset === undefined) {
      add(null, { from: 'img.src', ...meta });
      continue;
    }
    if (t.attrs.src !== undefined) add(t.attrs.src, { from: 'img.src', ...meta });
    for (const u of parseSrcset(t.attrs.srcset)) add(u, { from: 'img.srcset', ...meta });
  }

  const images = [...byUrl.values(), ...loose].map((r, i) => ({ ...r, index: i }));
  const refs = images.flatMap((r) => r.references);
  const countFrom = (name) => refs.filter((x) => x.from === name).length;

  return {
    images,
    counts: {
      unique: byUrl.size,
      references: refs.length,
      from_src: countFrom('img.src'),
      from_srcset: countFrom('img.srcset'),
      from_source: refs.filter((x) => String(x.from).startsWith('picture.source')).length,
      from_og: refs.filter((x) => String(x.from).startsWith('og:') || x.from === 'twitter:image').length,
      data_uri: images.filter((r) => r.kind === 'data_uri').length,
      unresolvable: images.filter((r) => r.kind === 'unresolvable').length,
      no_src: images.filter((r) => r.kind === 'no_src').length,
    },
    base_href: baseHref,
  };
}
