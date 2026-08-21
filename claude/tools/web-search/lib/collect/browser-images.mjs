// 브라우저가 실제로 쓴 그림 — DOM 참조와 네트워크 응답을 한 장부로.
//
// 태스크 #30. http 모드(#27)와 무엇이 다른가:
//   - **currentSrc** — srcset·picture 중 브라우저가 실제로 고른 판이 무엇인지는 렌더해 봐야 안다.
//   - **CSS 배경** — 마크업에 <img> 가 없어서 HTML 을 훑어서는 영영 못 찾는다.
//   - **표시 크기** — 속성에 적힌 값이 아니라 화면에 실제로 놓인 크기.
//   - **다시 받지 않는다** — 브라우저가 이미 받은 응답의 바이트를 그대로 쓴다.
//     또 받으면 남의 서버를 두 번 두드리는 것이고, 그때 받은 것과 지금 받은 것이 다를 수도 있다.
//
// [의미로 거르지 않는다] 로고·아이콘·1픽셀 추적 그림도 그대로 남긴다. 크기로도 이름으로도 빼지 않는다.
//
// [받지 못한 것도 줄로 남긴다] 화면 밖 lazy 그림, 브라우저가 안 고른 srcset 후보는 응답이 없다.
// 그 사실을 이유와 함께 적는다 — 조용히 빼면 "이 쪽에 그림이 몇 장이었나" 에 아무도 답할 수 없다.

import { writeArtifact } from '../artifacts.mjs';
import { UrlError, normalizeUrl } from '../url.mjs';
import { sniffImageMime } from './images.mjs';

export const BROWSER_IMAGE_DEFAULTS = Object.freeze({
  max_images: 200,
  max_image_bytes: 2 * 1024 * 1024,
  max_total_bytes: 64 * 1024 * 1024,
  max_scanned_elements: 5000,
});

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/avif': 'avif', 'image/heic': 'heic', 'image/x-icon': 'ico',
  'image/svg+xml': 'svg',
};
const baseMime = (v) => String(v ?? '').split(';')[0].trim().toLowerCase();

/**
 * 로딩 중 지나가는 그림 응답을 받아 둔다. 페이지가 끝난 뒤에는 본문을 못 읽을 수 있어
 * 그 자리에서 바로 읽는다.
 *
 * @returns {{stop:()=>Promise<Map>, stats:object}}
 */
export function attachImageObserver(page, {
  maxImageBytes = BROWSER_IMAGE_DEFAULTS.max_image_bytes,
  maxTotalBytes = BROWSER_IMAGE_DEFAULTS.max_total_bytes,
} = {}) {
  const seen = new Map();
  const pending = [];
  const stats = { responses: 0, kept: 0, too_large: 0, unreadable: 0, total_bytes: 0 };

  const onResponse = (res) => {
    const req = res.request();
    const ctype = baseMime(res.headers()['content-type']);
    const isImage = req.resourceType() === 'image' || ctype.startsWith('image/');
    if (!isImage) return;
    // 3xx 는 그림이 아니라 그림으로 가는 길이다. 이걸 그림으로 잡으면 리다이렉트를 탄 참조가
    // "받긴 받았는데 형식이 HTML" 인 이상한 줄이 된다. 최종 응답만 센다.
    if (res.status() >= 300 && res.status() < 400) return;
    stats.responses++;

    pending.push((async () => {
      const url = res.url();
      let canonical = url;
      try { canonical = normalizeUrl(url).canonical_url; } catch (e) { if (!(e instanceof UrlError)) throw e; }

      // 리다이렉트를 탔다면 처음 주소가 무엇이었는지도 남긴다.
      const chain = [];
      for (let r = req.redirectedFrom(); r; r = r.redirectedFrom()) chain.unshift(r.url());

      const row = {
        final_url: url,
        requested_url: chain.length ? chain[0] : url,
        redirected: chain.length > 0,
        status: res.status(),
        declared_mime: ctype || null,
        body: null,
        reason: null,
      };

      if (res.status() >= 400) row.reason = 'http_error';
      else if (stats.total_bytes >= maxTotalBytes) row.reason = 'total_budget_exceeded';
      else {
        try {
          const buf = await res.body();
          if (buf.length > maxImageBytes) { row.reason = 'too_large'; row.byte_size = buf.length; stats.too_large++; }
          else { row.body = buf; stats.total_bytes += buf.length; stats.kept++; }
        } catch (e) {
          // 취소된 요청·캐시된 응답은 본문을 못 읽는다. 그 사실을 그대로 적는다.
          row.reason = 'body_unreadable';
          row.error_message_short = String(e.message).split('\n')[0].slice(0, 120);
          stats.unreadable++;
        }
      }

      // 리다이렉트를 탔으면 **처음 주소로도** 찾을 수 있어야 한다. 문서에 적힌 것은 처음 주소이고
      // 실제 바이트는 마지막 주소로 왔기 때문이다. 체인의 모든 이름에 같은 줄을 걸어 둔다.
      const keys = [canonical];
      for (const u of chain) {
        try { keys.push(normalizeUrl(u).canonical_url); } catch (e) { if (!(e instanceof UrlError)) throw e; }
      }
      for (const key of keys) {
        // 같은 주소를 여러 번 받으면 처음 것을 남긴다(둘째부터는 캐시일 가능성이 높다).
        if (!seen.has(key)) seen.set(key, row);
        // 처음 것이 본문을 못 읽었고 나중 것이 읽혔다면 나중 것으로 채운다.
        else if (seen.get(key).body === null && row.body !== null) seen.set(key, row);
      }
    })());
  };

  page.on('response', onResponse);

  return {
    stats,
    async stop() {
      page.off('response', onResponse);
      await Promise.allSettled(pending);
      return seen;
    },
  };
}

/** 렌더가 끝난 문서에서 그림 참조를 걷는다. 페이지 안에서 도는 코드다. */
export const DOM_IMAGE_SNAPSHOT = ({ maxScanned }) => {
  const LANDMARKS = new Set(['NAV', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'ARTICLE', 'FORM']);
  const landmarkOf = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (LANDMARKS.has(n.tagName)) return n.tagName.toLowerCase();
    }
    return 'body';
  };
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
  const refs = [];
  let i = 0;

  for (const el of document.querySelectorAll('img')) {
    const box = el.getBoundingClientRect();
    const common = {
      dom_index: i++,
      where: landmarkOf(el),
      alt: el.getAttribute('alt'),
      loading: el.getAttribute('loading'),
      displayed: { width: Math.round(box.width), height: Math.round(box.height) },
      natural: { width: el.naturalWidth, height: el.naturalHeight },
      complete: el.complete,
    };
    const chosen = el.currentSrc ? abs(el.currentSrc) : null;
    if (chosen) refs.push({ ...common, from: 'img.currentSrc', url: chosen, current: true });
    const src = el.getAttribute('src');
    if (src) {
      const a = abs(src);
      if (a && a !== chosen) refs.push({ ...common, from: 'img.src', url: a, current: false });
      if (!a) refs.push({ ...common, from: 'img.src', url: null, raw: src, current: false });
    }
    for (const part of String(el.getAttribute('srcset') ?? '').split(',')) {
      const candidate = part.trim().split(/\s+/)[0];
      if (!candidate) continue;
      const a = abs(candidate);
      if (a && a !== chosen) refs.push({ ...common, from: 'img.srcset', url: a, current: false });
    }
    if (!src && !el.getAttribute('srcset') && !chosen) refs.push({ ...common, from: 'img.src', url: null, raw: null, current: false });
  }

  for (const el of document.querySelectorAll('picture source')) {
    for (const part of String(el.getAttribute('srcset') ?? '').split(',')) {
      const candidate = part.trim().split(/\s+/)[0];
      if (!candidate) continue;
      const a = abs(candidate);
      if (a) refs.push({ dom_index: i++, from: 'picture.source.srcset', url: a, current: false, where: landmarkOf(el), type: el.getAttribute('type') });
    }
  }

  for (const el of document.querySelectorAll('meta[property^="og:image"], meta[name="twitter:image"]')) {
    const a = abs(el.getAttribute('content') ?? '');
    if (a) refs.push({ dom_index: i++, from: el.getAttribute('property') ?? el.getAttribute('name'), url: a, current: false, where: 'head' });
  }

  // CSS 배경 — 마크업에 <img> 가 없어서 HTML 만 훑어서는 못 찾는 자리다.
  let scanned = 0;
  let capped = false;
  for (const el of document.querySelectorAll('*')) {
    if (++scanned > maxScanned) { capped = true; break; }
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') continue;
    for (const m of bg.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
      const a = abs(m[2]);
      if (a) refs.push({ dom_index: i++, from: 'css.background-image', url: a, current: false, where: landmarkOf(el) });
    }
  }

  return { refs, scanned, capped, page_url: location.href };
};

// ── 합치기 ────────────────────────────────────────────────────

/**
 * DOM 참조와 관측된 응답을 한 장부로 합친다.
 *
 * @returns {Promise<{manifest, counts, warnings, rows}>}
 */
export async function collectBrowserImages(db, {
  root, attemptId, snapshot, responses,
  maxImages = BROWSER_IMAGE_DEFAULTS.max_images,
  maxImageBytes = BROWSER_IMAGE_DEFAULTS.max_image_bytes,
  nowMs = Date.now(),
}) {
  const byUrl = new Map();
  const loose = [];

  const kindOf = (u) => {
    if (u === null) return 'no_src';
    if (/^data:/i.test(u)) return 'data_uri';
    if (/^blob:/i.test(u)) return 'blob_uri';
    if (/^https?:/i.test(u)) return 'http';
    return 'other_scheme';
  };

  for (const ref of snapshot.refs) {
    const kind = kindOf(ref.url);
    if (kind !== 'http') { loose.push({ kind, url: ref.url, references: [ref] }); continue; }
    let canonical = ref.url;
    try { canonical = normalizeUrl(ref.url).canonical_url; } catch (e) { if (!(e instanceof UrlError)) throw e; }
    const row = byUrl.get(canonical);
    if (row) { row.references.push(ref); continue; }
    byUrl.set(canonical, { kind: 'http', url: canonical, references: [ref] });
  }

  // 참조는 없는데 응답만 있는 것도 있다 — JS 가 만든 그림, 훑기 상한 너머의 CSS 배경.
  for (const [canonical, got] of responses) {
    if (byUrl.has(canonical)) continue;
    byUrl.set(canonical, { kind: 'http', url: canonical, references: [], observed_only: true });
  }

  const rows = [];
  let saved = 0;
  let index = 0;

  for (const item of [...byUrl.values(), ...loose]) {
    const row = {
      index: index++,
      url: item.url,
      kind: item.kind,
      observed_only: Boolean(item.observed_only),
      references: item.references,
      // 브라우저가 실제로 고른 판인가. srcset·picture 에서 이것 하나만 화면에 뜬다.
      is_current_src: item.references.some((r) => r.current === true),
      displayed: item.references.find((r) => r.displayed)?.displayed ?? null,
      natural: item.references.find((r) => r.natural)?.natural ?? null,
      requested_url: null,
      final_url: null,
      redirected: false,
      http_status: null,
      declared_mime: null,
      sniffed_mime: null,
      mime_mismatch: false,
      byte_size: null,
      sha256: null,
      path: null,
      artifact_id: null,
      ok: false,
      reason: null,
    };

    // data:·blob: 은 규칙이 분명하다 — 바깥 파일처럼 저장하지 않는다.
    // data: 의 바이트는 이미 dom.html.gz 안에 있고, blob: 은 그 페이지 안에서만 뜻이 있는 이름이다.
    if (item.kind !== 'http') { row.reason = item.kind; rows.push(row); continue; }

    const got = responses.get(item.url);
    if (!got) {
      // 브라우저가 이 주소를 아예 안 불렀다. 화면 밖 lazy 그림이거나 안 고른 후보다.
      row.reason = 'not_requested_by_browser';
      rows.push(row);
      continue;
    }

    row.requested_url = got.requested_url;
    row.final_url = got.final_url;
    row.redirected = got.redirected;
    row.http_status = got.status;
    row.declared_mime = got.declared_mime;

    if (got.reason) { row.reason = got.reason; if (got.byte_size) row.byte_size = got.byte_size; rows.push(row); continue; }
    if (got.body === null) { row.reason = 'body_unreadable'; rows.push(row); continue; }

    row.sniffed_mime = sniffImageMime(got.body);
    row.mime_mismatch = Boolean(row.declared_mime && row.sniffed_mime && row.declared_mime !== row.sniffed_mime);
    const declaredIsImage = String(row.declared_mime ?? '').startsWith('image/');
    if (!row.sniffed_mime && !declaredIsImage) { row.reason = 'not_an_image'; rows.push(row); continue; }
    if (got.body.length > maxImageBytes) { row.byte_size = got.body.length; row.reason = 'too_large'; rows.push(row); continue; }
    if (saved >= maxImages) { row.reason = 'over_limit'; rows.push(row); continue; }

    const mime = row.sniffed_mime ?? row.declared_mime;
    const ext = EXT_BY_MIME[mime] ?? 'bin';
    const short = (await import('node:crypto')).createHash('sha256').update(row.url).digest('hex').slice(0, 8);
    const a = await writeArtifact(db, {
      root, attemptId, kind: 'image', subdir: 'images',
      name: `i${String(row.index).padStart(3, '0')}-${short}.${ext}`,
      data: got.body, mime, nowMs,
    });
    row.byte_size = a.byte_size;
    row.sha256 = a.sha256;
    row.path = a.path;
    row.artifact_id = a.artifact_id;
    row.ok = true;
    if (!row.sniffed_mime) row.reason = 'mime_unverified';
    saved++;
    rows.push(row);
  }

  const jsonl = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  const manifest = await writeArtifact(db, {
    root, attemptId, kind: 'image_manifest', name: 'images.jsonl', data: jsonl, nowMs,
  });

  const ok = rows.filter((r) => r.ok);
  const NOT_A_FAILURE = new Set(['data_uri', 'blob_uri', 'no_src', 'other_scheme', 'over_limit', 'not_requested_by_browser']);
  const failed = rows.filter((r) => !r.ok && !NOT_A_FAILURE.has(r.reason));

  const counts = {
    rows: rows.length,
    downloaded: ok.length,
    failed: failed.length,
    bytes: ok.reduce((n, r) => n + r.byte_size, 0),
    current_src: rows.filter((r) => r.is_current_src).length,
    observed_only: rows.filter((r) => r.observed_only).length,
    not_requested: rows.filter((r) => r.reason === 'not_requested_by_browser').length,
    data_uri: rows.filter((r) => r.kind === 'data_uri').length,
    blob_uri: rows.filter((r) => r.kind === 'blob_uri').length,
    http_error: rows.filter((r) => r.reason === 'http_error').length,
    not_an_image: rows.filter((r) => r.reason === 'not_an_image').length,
    too_large: rows.filter((r) => r.reason === 'too_large').length,
    over_limit: rows.filter((r) => r.reason === 'over_limit').length,
    redirected: rows.filter((r) => r.redirected).length,
    mime_mismatch: rows.filter((r) => r.mime_mismatch).length,
    css_background: rows.filter((r) => r.references.some((x) => x.from === 'css.background-image')).length,
    scanned_elements: snapshot.scanned,
    scan_capped: Boolean(snapshot.capped),
  };

  const warnings = [];
  if (ok.length > 0 && failed.length > 0) warnings.push('image_fetch_partial');
  if (ok.length === 0 && failed.length > 0) warnings.push('image_fetch_none');
  if (counts.over_limit > 0) warnings.push('images_over_limit');
  if (counts.mime_mismatch > 0) warnings.push('image_mime_mismatch');
  if (counts.not_requested > 0) warnings.push('images_not_requested_by_browser');
  if (counts.scan_capped) warnings.push('image_scan_capped');

  return { manifest: { path: manifest.path, byte_size: manifest.byte_size }, counts, warnings, rows };
}
