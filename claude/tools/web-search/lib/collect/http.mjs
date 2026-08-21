// mode=http 수집 — 요청한 산출물만, 원문 손실 없이, 파일로.
//
// 계획서 4-6. 이 계층이 지키는 것은 셋이다.
//   (1) **요청한 것만 만든다.** 안 시킨 파일이 생기면 그만큼 남의 서버를 더 두드렸다는 뜻이고,
//       장부에도 아무도 안 부른 산출물이 쌓인다.
//   (2) **원문을 잃지 않는다.** dom 은 받은 바이트 그대로 gzip 한다. 글자로 바꿔 저장하면
//       원래 인코딩이 사라지고, 나중에 "정말 이렇게 왔었나" 를 확인할 길이 없어진다.
//   (3) **원문은 파일에만 있다.** 돌려주는 값에는 개수와 경로뿐이다.
//
// 여기서 의미를 판정하지 않는다. 상태가 404 여도, 본문이 오류 화면이어도 기계 작업은 끝날 수 있다.
// 그 자료가 쓸 만한지는 에이전트가 report 로 말한다.

import zlib from 'node:zlib';
import { writeArtifact } from '../artifacts.mjs';
import { detectErrorPageText, isThinText } from '../errors.mjs';
import { fetchSafely } from '../http.mjs';
import { decodeHtml } from './html.mjs';
import { extractLinks, linksToJsonl } from './extract-links.mjs';
import { extractText } from './extract-text.mjs';
import { collectImages } from './images.mjs';

export class CollectError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CollectError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new CollectError(code, message); };

/** 이 수집기가 만들 수 있는 것. screenshot 은 브라우저(#29)만 만든다. */
export const HTTP_OUTPUTS = ['text', 'dom', 'links', 'images'];

const FILE_NAMES = { text: 'text.txt', dom: 'dom.html.gz', links: 'links.jsonl', images: 'images.jsonl' };
const ARTIFACT_KIND = { text: 'text', dom: 'dom', links: 'link_manifest', images: 'image_manifest' };

/**
 * 한 쪽을 받아 요청한 산출물을 만든다.
 *
 * @param {object} db
 * @param {{
 *   root:string, attemptId:string, url:string, outputs:string[],
 *   fetchPage?:Function, fetchOptions?:object, nowMs?:number
 * }} o
 *   fetchPage 는 기본이 fetchSafely 다. 속도 제한을 붙이는 것은 조정 계층(#28)의 몫이라,
 *   거기서 예약을 감싼 함수를 넣어 준다.
 *
 * @returns {Promise<{
 *   ok:boolean, requested_url:string, final_url:string|null, status:number|null,
 *   title:string|null, charset:string|null, redirected:boolean, truncated:boolean,
 *   outputs:object, produced:string[], missing:string[], warnings:string[],
 *   error_stage:string|null, error_code:string|null, error_message_short:string|null,
 *   hops:number, elapsed_ms:number
 * }>}
 */
export async function collectHttp(db, {
  root, attemptId, url, outputs, fetchPage = fetchSafely, fetchOptions = {},
  imageOptions = {}, nowMs = Date.now(),
}) {
  if (!Array.isArray(outputs) || outputs.length === 0) fail('no_outputs', '만들 산출물을 하나 이상 적어야 합니다');
  const unknown = outputs.filter((o) => !HTTP_OUTPUTS.includes(o));
  if (unknown.length) {
    fail('unsupported_output', `http 수집기가 만들 수 없는 산출물입니다: ${unknown.join('·')} (가능: ${HTTP_OUTPUTS.join('·')})`);
  }
  const want = new Set(outputs);

  const r = await fetchPage(url, fetchOptions);

  const base = {
    requested_url: url,
    final_url: r.final_url,
    status: r.status,
    title: null,
    charset: null,
    redirected: Boolean(r.redirected),
    truncated: Boolean(r.truncated),
    outputs: {},
    produced: [],
    missing: [...outputs],
    warnings: [],
    hops: r.hops?.length ?? 0,
    elapsed_ms: r.elapsed_ms ?? 0,
    // 정중하게 기다린 시간. 오래 걸린 이유가 상대 서버인지 우리 속도 정책인지 갈라 보라고 남긴다.
    waited_ms: r.waited_ms ?? 0,
  };

  if (!r.ok) {
    // 못 받았으면 아무 파일도 만들지 않는다. 빈 파일을 남기면 "받았는데 비어 있었다" 와
    // 구분되지 않는다.
    return {
      ...base, ok: false,
      error_stage: r.error_stage, error_code: r.error_code, error_message_short: r.error_message_short,
    };
  }

  const warnings = [];
  if (r.redirected) warnings.push('redirected');
  if (r.status >= 400) warnings.push('http_error_status');
  if (r.truncated) warnings.push('response_truncated');

  const decoded = decodeHtml(r.body, r.headers['content-type']);
  base.charset = decoded.charset;
  if (decoded.fallback) warnings.push('charset_unsupported');

  const results = {};

  // dom — 받은 바이트 그대로. 글자로 바꾸지 않는다.
  if (want.has('dom')) {
    const gz = zlib.gzipSync(r.body, { level: 9 });
    const a = await writeArtifact(db, {
      root, attemptId, kind: ARTIFACT_KIND.dom, name: FILE_NAMES.dom, data: gz, nowMs,
    });
    results.dom = { path: a.path, byte_size: a.byte_size, original_bytes: r.body.length, sha256: a.sha256 };
  }

  // text — 보이는 글자를 순서대로
  let textInfo = null;
  if (want.has('text')) {
    textInfo = extractText(decoded.text);
    base.title = textInfo.title;
    const a = await writeArtifact(db, {
      root, attemptId, kind: ARTIFACT_KIND.text, name: FILE_NAMES.text, data: `${textInfo.text}\n`, nowMs,
    });
    results.text = {
      path: a.path, byte_size: a.byte_size, chars: textInfo.chars, lines: textInfo.lines,
      skipped_hidden: textInfo.skipped_hidden, skipped_script_style: textInfo.skipped_script_style,
    };
    if (textInfo.chars === 0) warnings.push('empty_text');
    // 글자는 있는데 차림표뿐인 쪽. 자바스크립트로 그리는 사이트에서 http 모드로 받으면 이렇게 온다.
    else if (isThinText(textInfo.chars)) warnings.push('thin_text');
  }

  // links — 어디를 가리키는지, 뭐라고 적혀 있는지, 어디서 나왔는지
  if (want.has('links')) {
    const { links, counts, base_href: baseHref } = extractLinks(decoded.text, r.final_url);
    const a = await writeArtifact(db, {
      root, attemptId, kind: ARTIFACT_KIND.links, name: FILE_NAMES.links, data: linksToJsonl(links), nowMs,
    });
    results.links = { path: a.path, byte_size: a.byte_size, ...counts, base_href: baseHref };
  }

  // images — 참조를 모으고 한 장씩 받는다. 일부가 실패해도 나머지는 남는다.
  if (want.has('images')) {
    const img = await collectImages(db, {
      root, attemptId, html: decoded.text, pageUrl: r.final_url,
      fetchImage: fetchPage, fetchOptions,
      maxImages: imageOptions.maxImages, maxImageBytes: imageOptions.maxImageBytes,
      nowMs,
    });
    results.images = { path: img.manifest.path, byte_size: img.manifest.byte_size, ...img.counts };
    warnings.push(...img.warnings);
  }

  // 제목은 text 를 안 만들어도 알 수 있다. 응답에 한 줄 넣는 데는 파일이 필요 없다.
  const seen = textInfo ?? extractText(decoded.text);
  if (base.title === null) base.title = seen.title;

  // 상태 200 인데 화면은 오류인 경우가 있다. **관찰만 남긴다** — 이 표시가 성공 여부를 바꾸지 않고,
  // 그 자료가 쓸모없다는 뜻도 아니다. 무엇으로 걸렸는지까지 적어 사람이 되짚을 수 있게 한다.
  const errPage = detectErrorPageText(seen.text, seen.title);
  if (errPage.detected) {
    warnings.push('error_page_text_detected');
    base.error_page_phrase = { phrase: errPage.phrase, where: errPage.where };
  }

  const produced = HTTP_OUTPUTS.filter((o) => results[o] !== undefined);
  return {
    ...base,
    ok: true,
    title: base.title,
    outputs: results,
    produced,
    missing: outputs.filter((o) => !produced.includes(o)),
    warnings,
    error_stage: null, error_code: null, error_message_short: null,
  };
}
