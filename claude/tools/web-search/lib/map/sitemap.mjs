// sitemap 읽기 — 도메인이 **스스로 선언한** 주소를 펼친다.
//
// 태스크 #33. 여기서 하는 일은 읽는 것뿐이다. 무엇이 상품 쪽인지, 무엇이 쓸모 있는지는
// 판단하지 않는다 — 선언된 것을 그대로 세어 넘긴다.
//
// [상한에 닿은 것을 완료로 바꾸지 않는다] 파일 수·URL 수·깊이·크기 어느 하나에 걸리면
// 그 사실과 **그때까지의 수**를 함께 돌려준다. 조용히 멈추면 "이 도메인은 URL 이 이만큼이다" 라는
// 거짓말이 된다. 1차가 무너진 자리가 바로 이런 반쪽 숫자였다.
//
// [순환] 색인이 자기 자신이나 앞선 색인을 가리키는 일이 흔하다. 최종 URL 을 기준으로 본 것을 세어
// 두 번 읽지 않는다 — 요청 주소로만 세면 리다이렉트를 거쳐 같은 곳에 다시 닿는다.

import zlib from 'node:zlib';
import { UrlError, normalizeUrl } from '../url.mjs';

export class SitemapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SitemapError';
    this.code = code;
  }
}

export const SITEMAP_LIMITS = Object.freeze({
  max_files: 50,          // 한 도메인에서 열어 볼 sitemap 파일 수
  max_urls: 50_000,       // 모을 URL 수 (규격의 한 파일 상한과 같다)
  max_depth: 4,           // 색인이 색인을 가리키는 깊이
  max_bytes: 50 * 1024 * 1024,
});

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) => String(s ?? '')
  .replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });

/** gzip 인가. 파일 이름이 아니라 바이트 앞머리로 본다 — 이름은 거짓말할 수 있다. */
export const looksGzipped = (buf) => Buffer.isBuffer(buf) && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;

/**
 * sitemap 한 장을 읽는다.
 *
 * @param {Buffer|string} body
 * @param {{baseUrl:string}} o  상대 주소를 풀 기준. 규격은 절대 URL 을 요구하지만 상대로 적힌 곳이 많다.
 * @returns {{
 *   kind:'urlset'|'sitemapindex'|'unknown',
 *   entries:{loc:string|null, raw:string, lastmod:string|null, unresolvable?:boolean}[],
 *   gzipped:boolean, bytes:number, error:string|null
 * }}
 */
export function parseSitemap(body, { baseUrl }) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
  const bytes = buf.length;
  let gzipped = false;
  if (looksGzipped(buf)) {
    gzipped = true;
    try { buf = zlib.gunzipSync(buf); } catch (e) {
      return { kind: 'unknown', entries: [], gzipped, bytes, error: `gunzip_failed: ${e.message.slice(0, 80)}` };
    }
  }

  const text = stripComments(buf.toString('utf8'));
  const isIndex = /<sitemapindex[\s>]/i.test(text);
  const isUrlset = /<urlset[\s>]/i.test(text);
  if (!isIndex && !isUrlset) {
    // 상태 200 이어도 사이트맵이 아닐 수 있다. 상태만 보고 통과시키지 않는다.
    const head = text.trim().slice(0, 60).replace(/\s+/g, ' ');
    return { kind: 'unknown', entries: [], gzipped, bytes, error: `not_a_sitemap: ${head}` };
  }

  const block = isIndex ? /<sitemap\b[\s\S]*?<\/sitemap>/gi : /<url\b[\s\S]*?<\/url>/gi;
  const entries = [];
  for (const m of text.matchAll(block)) {
    const chunk = m[0];
    const locMatch = chunk.match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i);
    const raw = locMatch ? unescapeXml(locMatch[1]).trim() : '';
    const lastmodMatch = chunk.match(/<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i);
    const lastmod = lastmodMatch ? unescapeXml(lastmodMatch[1]).trim() : null;
    if (!raw) { entries.push({ loc: null, raw: '', lastmod, unresolvable: true }); continue; }
    try {
      entries.push({ loc: new URL(raw, baseUrl).toString(), raw, lastmod });
    } catch {
      entries.push({ loc: null, raw, lastmod, unresolvable: true });
    }
  }

  return { kind: isIndex ? 'sitemapindex' : 'urlset', entries, gzipped, bytes, error: null };
}

// ── 여러 장을 이어서 ──────────────────────────────────────────

/**
 * 선언된 sitemap 들을 따라가며 URL 을 모은다.
 *
 * @param {{url:string, origin:'robots'|'convention'}[]} seeds
 * @param {{
 *   fetchOne:(url:string)=>Promise<{ok, status, final_url, body, error_code}>,
 *   limits?:object
 * }} o
 * @returns {Promise<{
 *   urls:Map<string,{canonical, lastmod, from, source_kind, depth}>,
 *   files:object[], errors:object[], limits_hit:string[], partial:boolean, counts:object
 * }>}
 */
export async function crawlSitemaps(seeds, { fetchOne, limits = {} }) {
  const cfg = { ...SITEMAP_LIMITS, ...Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined)) };

  const urls = new Map();
  const files = [];
  const errors = [];
  const limitsHit = new Set();
  const seen = new Set();          // 요청 주소와 최종 주소를 모두 넣는다
  const queue = seeds.map((s) => ({ url: s.url, origin: s.origin, depth: 0, from: null }));

  while (queue.length) {
    if (files.length >= cfg.max_files) { limitsHit.add('max_files'); break; }
    if (urls.size >= cfg.max_urls) { limitsHit.add('max_urls'); break; }

    const job = queue.shift();
    if (seen.has(job.url)) { files.push({ url: job.url, depth: job.depth, skipped: 'already_seen', origin: job.origin }); continue; }
    seen.add(job.url);

    let got;
    try {
      got = await fetchOne(job.url);
    } catch (e) {
      errors.push({ url: job.url, depth: job.depth, code: 'fetch_threw', message_short: String(e.message).slice(0, 120) });
      continue;
    }

    // 리다이렉트로 이미 본 곳에 닿았으면 두 번 읽지 않는다.
    const finalUrl = got.final_url ?? job.url;
    if (finalUrl !== job.url && seen.has(finalUrl)) {
      files.push({ url: job.url, final_url: finalUrl, depth: job.depth, skipped: 'already_seen_after_redirect', origin: job.origin });
      continue;
    }
    seen.add(finalUrl);

    if (!got.ok || got.status >= 400) {
      errors.push({
        url: job.url, final_url: finalUrl, depth: job.depth,
        code: got.error_code ?? `http_${got.status}`, status: got.status ?? null,
      });
      continue;
    }
    if (got.body && got.body.length > cfg.max_bytes) {
      limitsHit.add('max_bytes');
      errors.push({ url: job.url, depth: job.depth, code: 'too_large', bytes: got.body.length });
      continue;
    }

    const parsed = parseSitemap(got.body, { baseUrl: finalUrl });
    const record = {
      url: job.url, final_url: finalUrl, depth: job.depth, origin: job.origin,
      kind: parsed.kind, gzipped: parsed.gzipped, bytes: parsed.bytes,
      entries: parsed.entries.length, error: parsed.error,
    };
    files.push(record);

    if (parsed.error) { errors.push({ url: job.url, final_url: finalUrl, depth: job.depth, code: 'unreadable', message_short: parsed.error }); continue; }

    if (parsed.kind === 'sitemapindex') {
      if (job.depth + 1 > cfg.max_depth) {
        limitsHit.add('max_depth');
        errors.push({ url: job.url, depth: job.depth, code: 'max_depth', message_short: `깊이 상한 ${cfg.max_depth} 에 닿아 아래를 안 열었습니다` });
        continue;
      }
      for (const e of parsed.entries) {
        if (!e.loc) { errors.push({ url: job.url, depth: job.depth, code: 'bad_loc', message_short: e.raw.slice(0, 80) }); continue; }
        queue.push({ url: e.loc, origin: job.origin, depth: job.depth + 1, from: finalUrl });
      }
      continue;
    }

    // urlset — 여기서만 URL 이 는다.
    for (const e of parsed.entries) {
      if (!e.loc) { errors.push({ url: job.url, depth: job.depth, code: 'bad_loc', message_short: e.raw.slice(0, 80) }); continue; }
      if (urls.size >= cfg.max_urls) { limitsHit.add('max_urls'); break; }
      let canonical;
      try {
        canonical = normalizeUrl(e.loc).canonical_url;
      } catch (err) {
        if (!(err instanceof UrlError)) throw err;
        errors.push({ url: job.url, depth: job.depth, code: `url_${err.code}`, message_short: e.loc.slice(0, 80) });
        continue;
      }
      const already = urls.get(canonical);
      if (already) {
        // 같은 주소가 여러 sitemap 에 있는 것은 흔하다. 늦게 온 lastmod 도 비어 있지 않으면 채운다.
        already.seen_times += 1;
        if (already.lastmod === null && e.lastmod) already.lastmod = e.lastmod;
        continue;
      }
      urls.set(canonical, {
        canonical,
        raw: e.raw,
        lastmod: e.lastmod,
        from: finalUrl,
        // robots.txt 가 선언한 sitemap 에서 나왔는지, 관례로 찾은 sitemap 에서 나왔는지 구분한다.
        source_kind: job.origin === 'robots' ? 'robots' : 'sitemap',
        depth: job.depth,
        seen_times: 1,
      });
    }
  }

  const partial = limitsHit.size > 0 || errors.length > 0;
  return {
    urls,
    files,
    errors,
    limits_hit: [...limitsHit],
    // 상한에 닿았거나 못 읽은 파일이 있으면 "이만큼이 전부" 라고 말하지 않는다.
    partial,
    counts: {
      files_opened: files.filter((f) => !f.skipped).length,
      files_skipped: files.filter((f) => f.skipped).length,
      indexes: files.filter((f) => f.kind === 'sitemapindex').length,
      urlsets: files.filter((f) => f.kind === 'urlset').length,
      unreadable: files.filter((f) => f.error).length,
      urls: urls.size,
      duplicates: [...urls.values()].reduce((n, u) => n + (u.seen_times - 1), 0),
      errors: errors.length,
      max_depth_seen: files.reduce((m, f) => Math.max(m, f.depth), 0),
    },
  };
}
