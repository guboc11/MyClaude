// 링크를 나온 순서대로 — 무엇을 가리키는지, 뭐라고 적혀 있는지, 어디서 나왔는지.
//
// 계획서 4-6: "페이지의 링크 URL·보이는 문구·내부/외부 여부·발견 위치를 JSONL 로 저장".
//
// [버리지 않는다] mailto·tel·javascript 처럼 나갈 수 없는 링크도 줄로 남긴다. 다만 무엇인지
// 적어 둔다. 조용히 빼면 "이 쪽에 링크가 몇 개였나" 라는 물음에 아무도 답할 수 없게 된다.
// 마찬가지로 nav·footer 링크도 남긴다 — 군더더기인지 아닌지는 에이전트가 정한다.

import { LANDMARKS, decodeEntities, tokenize } from './html.mjs';
import { UrlError, normalizeUrl, sameHostIgnoringWww } from '../url.mjs';

/** 태그 안쪽 글자만 모으는 작은 훑기. 링크 문구를 만들 때 쓴다. */
const squash = (s) => decodeEntities(s).replace(/\s+/g, ' ').trim();

/**
 * @param {string} html
 * @param {string} pageUrl  이 문서가 실제로 도착한 주소. 상대 링크의 기준이자 내부·외부 판정 기준이다.
 * @returns {{
 *   links: object[], counts: {total, internal, external, non_http, unresolvable, fragment_only},
 *   base_href: string|null
 * }}
 */
export function extractLinks(html, pageUrl) {
  const links = [];
  const landmarks = [];
  let baseHref = null;
  let base = pageUrl;

  // 지금 열려 있는 <a>. 안에 또 <a> 가 나오면 앞의 것을 그 자리에서 닫는다(브라우저도 그렇게 한다).
  let open = null;
  let index = 0;

  const close = () => {
    if (!open) return;
    const text = squash(open.textParts.join(''));
    links.push(finishLink(open, text, base, pageUrl));
    open = null;
  };

  for (const t of tokenize(html)) {
    if (t.type === 'text' && open) { open.textParts.push(t.value); continue; }
    if (t.type === 'raw') continue;
    if (t.type === 'comment' || t.type === 'decl') continue;

    if (t.type === 'open') {
      if (t.name === 'base' && t.attrs.href && baseHref === null) {
        baseHref = t.attrs.href;
        try { base = new URL(baseHref, pageUrl).toString(); } catch { /* 읽을 수 없으면 원래 주소를 쓴다 */ }
        continue;
      }
      if (LANDMARKS.has(t.name) && !t.selfClosing) landmarks.push(t.name);
      // 링크 안의 그림에 붙은 alt 는 사람이 보는 문구를 대신한다.
      if (t.name === 'img' && open && t.attrs.alt) open.textParts.push(` ${t.attrs.alt} `);
      if (t.name !== 'a') continue;

      close();
      open = {
        index: index++,
        raw_href: t.attrs.href ?? null,
        rel: t.attrs.rel ?? null,
        title: t.attrs.title ?? null,
        where: landmarks.length ? landmarks[landmarks.length - 1] : 'body',
        textParts: [],
      };
      if (t.selfClosing) close();
      continue;
    }

    if (t.type === 'close') {
      if (t.name === 'a') { close(); continue; }
      if (LANDMARKS.has(t.name)) {
        for (let k = landmarks.length - 1; k >= 0; k--) if (landmarks[k] === t.name) { landmarks.length = k; break; }
      }
    }
  }
  close();

  const counts = {
    total: links.length,
    internal: links.filter((l) => l.internal === true).length,
    external: links.filter((l) => l.internal === false).length,
    non_http: links.filter((l) => l.kind === 'non_http').length,
    unresolvable: links.filter((l) => l.kind === 'unresolvable').length,
    fragment_only: links.filter((l) => l.fragment_only).length,
  };
  return { links, counts, base_href: baseHref };
}

function finishLink(a, text, base, pageUrl) {
  const row = {
    index: a.index,
    raw_href: a.raw_href,
    url: null,
    fragment: null,
    fragment_only: false,
    text,
    title: a.title,
    rel: a.rel,
    where: a.where,
    internal: null,
    kind: 'http',
  };

  if (a.raw_href === null || a.raw_href.trim() === '') {
    row.kind = 'no_href';
    return row;
  }

  const href = a.raw_href.trim();
  // 같은 쪽 안의 자리표. 새 주소가 아니라는 것을 표시해 둔다.
  row.fragment_only = href.startsWith('#');

  let absolute;
  try {
    absolute = new URL(href, base);
  } catch {
    row.kind = 'unresolvable';
    return row;
  }
  row.fragment = absolute.hash ? absolute.hash.slice(1) : null;

  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') {
    row.kind = 'non_http';
    row.url = `${absolute.protocol}${absolute.pathname || ''}`.slice(0, 300);
    return row;
  }

  try {
    const norm = normalizeUrl(absolute.toString());
    row.url = norm.canonical_url;
    row.internal = sameHostIgnoringWww(norm.domain, new URL(pageUrl).hostname);
  } catch (e) {
    if (!(e instanceof UrlError)) throw e;
    row.kind = 'unresolvable';
    row.url = absolute.toString().slice(0, 300);
  }
  return row;
}

/** 한 줄에 하나씩. 파일로만 나가고 MCP 응답에는 개수와 경로만 남는다. */
export const linksToJsonl = (links) => links.map((l) => JSON.stringify(l)).join('\n') + (links.length ? '\n' : '');
