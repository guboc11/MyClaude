// map_domain — 한 도메인에서 **확인한 범위만** 지도로 만든다.
//
// 태스크 #34. 네 곳을 본다.
//   1. robots.txt 가 선언한 sitemap
//   2. 관례 자리(/sitemap.xml) — 선언이 없을 때만
//   3. 대표 페이지 **한 장**의 내부 링크
//   4. 이 workspace 가 앞서 수집해 둔 links.jsonl 의 내부 URL
//
// [자동으로 따라가지 않는다] 찾은 쪽을 collect 하지 않는다. queued 로 넣어 둘 뿐이고,
// 무엇을 볼지는 에이전트가 next·collect 로 정한다. 1차는 발견한 링크를 스스로 재투입해서
// 무엇을 왜 봤는지 아무도 설명할 수 없게 됐다.
//
// [확인한 것과 못 본 것을 갈라 적는다] 못 연 sitemap, 상한에 걸려 안 본 가지, 대표 페이지 한 장
// 너머는 **미확인 범위**로 지도에 남긴다. 지도에 없는 것을 "없다" 로 읽으면 안 되기 때문이다.

import fs from 'node:fs';
import path from 'node:path';

import { writeArtifact, writeManifest } from '../artifacts.mjs';
import { finishAttempt, startAttempt } from '../attempts.mjs';
import { addUrls } from '../items.mjs';
import { checkTarget } from '../network-policy.mjs';
import { extractLinks } from '../collect/extract-links.mjs';
import { decodeHtml } from '../collect/html.mjs';
import { normalizeUrl, sameHostIgnoringWww, UrlError } from '../url.mjs';
import { sitemapSeeds } from './robots.mjs';
import { crawlSitemaps, SITEMAP_LIMITS } from './sitemap.mjs';

export class MapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MapError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new MapError(code, message); };

export const MAP_LIMITS = Object.freeze({
  ...SITEMAP_LIMITS,
  max_links_from_page: 2_000,     // 대표 페이지 한 장에서 거둘 내부 링크 수
  max_from_manifests: 10_000,     // 앞서 모은 links.jsonl 에서 가져올 내부 URL 수
});

/** 지도를 그릴 자리. domain 이든 대표 URL 이든 결국 origin 하나로 모은다. */
export function resolveTarget({ domain, url }) {
  if (!domain && !url) fail('need_domain_or_url', 'domain 또는 url 중 하나는 있어야 합니다');
  const raw = url ?? `https://${String(domain).trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')}/`;
  let norm;
  try {
    norm = normalizeUrl(raw);
  } catch (e) {
    if (!(e instanceof UrlError)) throw e;
    fail(`url_${e.code}`, `지도를 그릴 주소를 읽을 수 없습니다: ${String(raw).slice(0, 80)}`);
  }
  const u = new URL(norm.canonical_url);
  return {
    origin: `${u.protocol}//${u.host}`,
    hostname: norm.domain,
    entry_url: url ? norm.canonical_url : `${u.protocol}//${u.host}/`,
    from: url ? 'url' : 'domain',
  };
}

/** 이 workspace 가 앞서 남긴 links.jsonl 에서 같은 도메인 URL 을 거둔다. 네트워크를 쓰지 않는다. */
export function internalUrlsFromManifests(db, root, hostname, { limit = MAP_LIMITS.max_from_manifests } = {}) {
  const rows = db.prepare("SELECT path FROM artifacts WHERE kind = 'link_manifest' ORDER BY artifact_id").all();
  const out = new Map();
  let scannedFiles = 0;
  let capped = false;
  for (const r of rows) {
    const abs = path.join(root, r.path);
    if (!fs.existsSync(abs)) continue;
    scannedFiles++;
    for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
      if (!line) continue;
      let l;
      try { l = JSON.parse(line); } catch { continue; }
      if (!l.url || l.kind !== 'http') continue;
      if (!sameHostIgnoringWww(new URL(l.url).hostname, hostname)) continue;
      if (out.size >= limit) { capped = true; break; }
      if (!out.has(l.url)) out.set(l.url, { url: l.url, from: r.path });
    }
    if (capped) break;
  }
  return { urls: [...out.values()], files: scannedFiles, capped };
}

/**
 * 지도를 그린다.
 *
 * @returns {{
 *   sources:object[], discovered:number, new_urls:number, map_path:string,
 *   limits:object, needs_review:string[], attempt_id:string
 * }}
 */
export async function runMap(db, {
  root, domain, url, fetchPage, fetchOptions = {}, limits = {}, nowMs = Date.now(), clock = Date.now,
}) {
  const target = resolveTarget({ domain, url });
  const cfg = { ...MAP_LIMITS, ...Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined)) };

  // (5) 나가도 되는 곳인지 먼저 본다. 브라우저도 수집도 아니지만 같은 문을 쓴다.
  const gate = await checkTarget(target.entry_url, { ...fetchOptions });
  if (!gate.allow) {
    const stage = String(gate.reason).startsWith('url_') ? 'url' : String(gate.reason).startsWith('dns_') ? 'dns' : 'policy';
    fail(gate.reason, `${target.hostname} 로는 나가지 않습니다 (${stage}/${gate.reason})`);
  }

  const started = clock();
  const { attempt_id: attemptId } = startAttempt(db, {
    operation: 'map', collector: 'http', requestedUrl: target.entry_url, nowMs: started,
  });

  const sources = [];
  const needsReview = [];
  const found = new Map();      // canonical → {source_kind, source_value, lastmod}
  const limitsHit = new Set();

  const remember = (canonical, sourceKind, sourceValue, extra = {}) => {
    if (found.has(canonical)) { found.get(canonical).also.push(sourceKind); return false; }
    found.set(canonical, { url: canonical, source_kind: sourceKind, source_value: sourceValue, also: [], ...extra });
    return true;
  };

  const fetchOne = async (u) => {
    const r = await fetchPage(u, fetchOptions);
    return { ok: r.ok, status: r.status, final_url: r.final_url, body: r.body, error_code: r.error_code };
  };

  // ── 1·2. robots 선언 sitemap 과 관례 자리 ──────────────────
  let robotsText = null;
  let robotsState = 'unknown';
  {
    const r = await fetchPage(`${target.origin}/robots.txt`, fetchOptions);
    if (r.ok && r.status === 200 && r.body) { robotsText = r.body.toString('utf8'); robotsState = 'read'; }
    else if (r.ok && (r.status === 404 || r.status === 410)) robotsState = 'absent';
    else robotsState = 'unreadable';
    sources.push({
      kind: 'robots', url: `${target.origin}/robots.txt`, state: robotsState,
      status: r.status ?? null, error: r.ok ? null : (r.error_code ?? 'fetch_failed'),
    });
    if (robotsState === 'unreadable') needsReview.push('robots.txt 를 못 읽었습니다 — 선언된 sitemap 이 더 있을 수 있습니다');
  }

  const seeds = sitemapSeeds({ robotsText, robotsState, origin: target.origin });
  const sitemap = await crawlSitemaps(seeds.seeds, { fetchOne, limits: cfg });
  for (const f of sitemap.files) {
    sources.push({
      kind: f.origin === 'robots' ? 'sitemap_declared' : 'sitemap_guessed',
      url: f.url, final_url: f.final_url ?? null, state: f.skipped ?? (f.error ? 'unreadable' : 'read'),
      entries: f.entries ?? 0, depth: f.depth, gzipped: Boolean(f.gzipped), error: f.error ?? null,
    });
  }
  for (const e of sitemap.errors) {
    sources.push({ kind: 'sitemap_error', url: e.url, state: 'failed', error: e.code, message_short: e.message_short ?? null });
  }
  for (const [canonical, u] of sitemap.urls) remember(canonical, u.source_kind, u.from, { lastmod: u.lastmod });
  for (const l of sitemap.limits_hit) limitsHit.add(l);
  if (sitemap.partial) {
    needsReview.push(`sitemap 을 다 못 읽었습니다 — 못 연 파일 ${sitemap.counts.unreadable}장 · 오류 ${sitemap.errors.length}건`);
  }

  // ── 3. 대표 페이지 한 장 ───────────────────────────────────
  {
    const r = await fetchPage(target.entry_url, fetchOptions);
    if (!r.ok || r.status >= 400 || !r.body) {
      sources.push({
        kind: 'entry_page', url: target.entry_url, state: 'failed',
        status: r.status ?? null, error: r.error_code ?? `http_${r.status}`,
      });
      needsReview.push('대표 페이지를 못 읽었습니다 — 내부 링크는 지도에 없습니다');
    } else {
      const html = decodeHtml(r.body, r.headers['content-type']).text;
      const { links } = extractLinks(html, r.final_url);
      const internal = links.filter((l) => l.internal === true && l.url);
      let added = 0;
      for (const l of internal) {
        if (added >= cfg.max_links_from_page) { limitsHit.add('max_links_from_page'); break; }
        if (remember(l.url, 'internal_link', r.final_url)) added++;
      }
      sources.push({
        kind: 'entry_page', url: target.entry_url, final_url: r.final_url, state: 'read',
        status: r.status, links_total: links.length, links_internal: internal.length, new_from_here: added,
      });
      // 한 장만 본다. 그 너머는 안 본 것이다.
      needsReview.push(`대표 페이지 한 장만 봤습니다 — 그 쪽이 가리키는 ${internal.length}곳의 내부는 안 봤습니다`);
    }
  }

  // ── 4. 앞서 모아 둔 links.jsonl ────────────────────────────
  {
    const prior = internalUrlsFromManifests(db, root, target.hostname, { limit: cfg.max_from_manifests });
    let added = 0;
    for (const p of prior.urls) if (remember(p.url, 'internal_link', p.from)) added++;
    if (prior.capped) limitsHit.add('max_from_manifests');
    sources.push({
      kind: 'prior_link_manifests', state: 'read', files: prior.files,
      urls_seen: prior.urls.length, new_from_here: added,
    });
  }

  // ── 장부에 넣는다. 출처별로 나눠 add_urls 공통 경로를 탄다 ──
  const groups = new Map();
  for (const f of found.values()) {
    const key = `${f.source_kind} ${f.source_value}`;
    if (!groups.has(key)) groups.set(key, { source_kind: f.source_kind, source_value: f.source_value, urls: [] });
    groups.get(key).urls.push(f.url);
  }
  let newUrls = 0;
  let duplicates = 0;
  for (const g of groups.values()) {
    const r = addUrls(db, g.urls.map((u, i) => ({ url: u, line: i + 1 })), {
      source_kind: g.source_kind, source_value: String(g.source_value ?? '').slice(0, 300), nowMs: clock(),
    });
    newUrls += r.added;
    duplicates += r.duplicates;
  }

  // ── 지도 파일 ──────────────────────────────────────────────
  const doc = {
    schema: 'web-search-v2-domain-map/1',
    workspace_id: db.prepare("SELECT value FROM meta WHERE key = 'workspace_id'").get()?.value ?? null,
    attempt_id: attemptId,
    target,
    robots_state: robotsState,
    sitemap_seed_origin: seeds.declared ? 'robots' : 'convention',
    // 확인한 곳과 못 본 곳을 나란히 둔다. 지도에 없는 것을 "없다" 로 읽으면 안 된다.
    sources,
    counts: {
      discovered: found.size,
      new_urls: newUrls,
      duplicates,
      by_source_kind: Object.fromEntries([...found.values()].reduce((m, f) => m.set(f.source_kind, (m.get(f.source_kind) ?? 0) + 1), new Map())),
      sitemap_files_opened: sitemap.counts.files_opened,
      sitemap_urls: sitemap.counts.urls,
    },
    limits: { ...cfg, hit: [...limitsHit, ...sitemap.limits_hit].filter((v, i, a) => a.indexOf(v) === i) },
    unchecked: needsReview,
    urls: [...found.values()].map((f) => ({
      url: f.url, source_kind: f.source_kind, source_value: f.source_value,
      lastmod: f.lastmod ?? null, also_from: [...new Set(f.also)],
    })),
    made_at: nowMs,
  };
  const a = await writeArtifact(db, {
    root, attemptId, kind: 'map', name: 'map.json', data: `${JSON.stringify(doc, null, 2)}\n`, nowMs,
  });

  const anyFailure = sources.some((s) => s.state === 'failed' || s.state === 'unreadable');
  finishAttempt(db, {
    attemptId,
    result: found.size === 0 && anyFailure ? 'failed' : (anyFailure || limitsHit.size ? 'partial' : 'success'),
    finalUrl: target.entry_url, httpStatus: null,
    warningCodes: null,
    errorStage: found.size === 0 && anyFailure ? 'map' : null,
    errorCode: found.size === 0 && anyFailure ? 'no_sources_readable' : null,
    errorMessageShort: found.size === 0 && anyFailure ? '읽을 수 있는 출처가 하나도 없었습니다' : null,
    nowMs: clock(),
  });
  await writeManifest(db, root, attemptId, { nowMs: clock() });

  return {
    sources,
    discovered: found.size,
    new_urls: newUrls,
    map_path: a.path,
    limits: doc.limits,
    needs_review: needsReview,
    attempt_id: attemptId,
  };
}
