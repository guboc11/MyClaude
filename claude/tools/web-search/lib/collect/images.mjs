// 그림 내려받기 — 참조와 파일이 끊기지 않게.
//
// 태스크 #27. 지키는 것 셋.
//   (1) **일부 실패는 전체 실패가 아니다.** 열 장 중 셋을 못 받아도 나머지 일곱은 남는다.
//       못 받은 것은 왜 못 받았는지와 함께 줄로 남는다 — 조용히 사라지지 않는다.
//   (2) **성공한 줄과 실제 파일이 1:1.** 같은 주소가 여러 번 나와도 줄은 하나, 파일도 하나다.
//   (3) **의미로 거르지 않는다.** 로고·아이콘·광고처럼 보인다고 빼지 않는다.
//
// 형식 검사는 판정이 아니라 관찰이다. 머리에 적힌 형식(declared)과 바이트가 말하는 형식(sniffed)을
// 둘 다 적고, 어긋나면 어긋났다고 표시한다. 다만 **그림이 아닌 것은 그림 파일로 저장하지 않는다** —
// 그건 의미 판단이 아니라 기계적 사실이다.

import { createHash } from 'node:crypto';
import { writeArtifact } from '../artifacts.mjs';
import { fetchSafely } from '../http.mjs';
import { extractImageRefs } from './extract-images.mjs';

export const IMAGE_DEFAULTS = Object.freeze({
  max_images: 200,
  max_image_bytes: 2 * 1024 * 1024,
});

/** 바이트 앞머리로 형식을 알아본다. 머리에 적힌 말을 그대로 믿지 않기 위해서다. */
export function sniffImageMime(buf) {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'image/heic';
  }
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';
  const head = b.subarray(0, 300).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/avif': 'avif', 'image/heic': 'heic', 'image/x-icon': 'ico',
  'image/svg+xml': 'svg',
};

const baseMime = (v) => String(v ?? '').split(';')[0].trim().toLowerCase();

/**
 * 이 쪽의 그림을 모두 받아 images.jsonl 과 파일로 남긴다.
 *
 * @param {{
 *   root:string, attemptId:string, html:string, pageUrl:string,
 *   fetchImage?:Function, fetchOptions?:object,
 *   maxImages?:number, maxImageBytes?:number, nowMs?:number
 * }} o
 *   fetchImage 는 기본이 fetchSafely 다. 속도 제한을 씌우는 것은 조정 계층(#28)의 몫이라
 *   거기서 예약을 감싼 함수를 넣어 준다 — 그림 한 장도 한 번의 요청이다.
 *
 * @returns {Promise<{
 *   manifest:{path, byte_size}, counts:object, warnings:string[], rows:object[]
 * }>}
 */
export async function collectImages(db, {
  root, attemptId, html, pageUrl,
  fetchImage = fetchSafely, fetchOptions = {},
  maxImages = IMAGE_DEFAULTS.max_images, maxImageBytes = IMAGE_DEFAULTS.max_image_bytes,
  nowMs = Date.now(),
}) {
  const found = extractImageRefs(html, pageUrl);
  const rows = [];
  let downloaded = 0;

  for (const ref of found.images) {
    const row = {
      index: ref.index,
      url: ref.url,
      raw: ref.raw,
      references: ref.references,
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

    // 받을 수 없는 참조는 왜 그런지만 적고 넘어간다.
    if (ref.kind !== 'http') { row.reason = ref.kind; rows.push(row); continue; }

    // 상한을 넘으면 여기서 멈추되, 남은 것도 줄로는 남긴다 — 조용히 사라지게 두지 않는다.
    if (downloaded >= maxImages) { row.reason = 'over_limit'; rows.push(row); continue; }
    downloaded++;

    let got;
    try {
      got = await fetchImage(row.url, { ...fetchOptions, maxBytes: maxImageBytes + 1 });
    } catch (e) {
      row.reason = 'fetch_threw';
      row.error_message_short = String(e.message).slice(0, 160);
      rows.push(row);
      continue;
    }

    row.final_url = got.final_url;
    row.redirected = Boolean(got.redirected);
    row.http_status = got.status;

    if (!got.ok) {
      row.reason = got.error_code ?? 'fetch_failed';
      row.error_stage = got.error_stage ?? null;
      rows.push(row);
      continue;
    }
    if (got.status >= 400) { row.reason = 'http_error'; rows.push(row); continue; }

    row.declared_mime = baseMime(got.headers['content-type']) || null;
    row.sniffed_mime = sniffImageMime(got.body);
    row.mime_mismatch = Boolean(row.declared_mime && row.sniffed_mime && row.declared_mime !== row.sniffed_mime);

    // 그림이 아니면 그림 파일로 저장하지 않는다. 기계적 사실이지 의미 판단이 아니다.
    const declaredIsImage = String(row.declared_mime ?? '').startsWith('image/');
    if (!row.sniffed_mime && !declaredIsImage) { row.reason = 'not_an_image'; rows.push(row); continue; }

    if (got.body.length > maxImageBytes || got.truncated) {
      row.byte_size = got.body.length;
      row.reason = 'too_large';
      rows.push(row);
      continue;
    }

    const mime = row.sniffed_mime ?? row.declared_mime;
    const ext = EXT_BY_MIME[mime] ?? 'bin';
    const short = createHash('sha256').update(row.url).digest('hex').slice(0, 8);
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
    if (!row.sniffed_mime) row.reason = 'mime_unverified';   // 받긴 했는데 바이트로 확인은 못 했다
    rows.push(row);
  }

  const jsonl = rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
  const manifest = await writeArtifact(db, {
    root, attemptId, kind: 'image_manifest', name: 'images.jsonl', data: jsonl, nowMs,
  });

  const ok = rows.filter((r) => r.ok);
  // "받으려다 못 받은 것" 만 실패로 센다. 받을 수 없는 참조(data URI·주소 없음)와
  // 아예 시도하지 않은 것(상한 초과)은 다른 이야기이고, 각자 자기 경고를 가진다.
  const NOT_A_FAILURE = new Set(['data_uri', 'no_src', 'over_limit']);
  const failed = rows.filter((r) => !r.ok && !NOT_A_FAILURE.has(r.reason));
  const counts = {
    ...found.counts,
    rows: rows.length,
    downloaded: ok.length,
    failed: failed.length,
    bytes: ok.reduce((n, r) => n + r.byte_size, 0),
    http_error: rows.filter((r) => r.reason === 'http_error').length,
    not_an_image: rows.filter((r) => r.reason === 'not_an_image').length,
    too_large: rows.filter((r) => r.reason === 'too_large').length,
    over_limit: rows.filter((r) => r.reason === 'over_limit').length,
    redirected: rows.filter((r) => r.redirected).length,
    mime_mismatch: rows.filter((r) => r.mime_mismatch).length,
  };

  const warnings = [];
  if (ok.length > 0 && failed.length > 0) warnings.push('image_fetch_partial');
  if (ok.length === 0 && failed.length > 0) warnings.push('image_fetch_none');
  if (counts.over_limit > 0) warnings.push('images_over_limit');
  if (counts.mime_mismatch > 0) warnings.push('image_mime_mismatch');

  return { manifest: { path: manifest.path, byte_size: manifest.byte_size }, counts, warnings, rows };
}
