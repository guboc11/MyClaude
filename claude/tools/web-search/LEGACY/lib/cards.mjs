// web-search — 카드 자료 계약
// 계획서 2-11. 태스크 18.
//
// [원칙 1] 카드 ID 는 다시 훑어도 같아야 한다. 순서나 시간이 섞이면 같은 카드가 매번 새 카드가 된다.
// [원칙 2] 상세 주소가 있으면 크롤이 쓰는 정규화 ID 를 그대로 쓴다. 장부와 카드가 다른 잣대를 쓰면
//   "이 카드의 상세를 이미 봤는가"를 물을 수 없다.
// [원칙 3] 상세 주소가 없을 때만 대체 ID 를 만든다. 그 재료는 결정적인 것만 쓴다 —
//   도메인, 목록 주소, 그 목록 안에서의 자리, 이미지 주소.
// [원칙 4] 없는 것을 있는 척하지 않는다. 캡처나 좌표가 없거나 추출이 확정되지 않았으면
//   페이지 단위로 그 사실과 사유를 남긴다.

import crypto from 'node:crypto';
import { normalizeUrl } from './url.mjs';

// 밖으로 내보내는 상세 상태는 셋뿐이다. 장부의 속내를 그대로 흘리면 고르기 도구가
// 우리 내부 어휘에 매이고, 그 어휘가 바뀔 때마다 그쪽이 깨진다.
export const DETAIL_STATES = ['known_deferred', 'queued', 'fetched'];

const AS_QUEUED = new Set(['queued', 'leased']);
const AS_FETCHED = new Set(['fetched', 'content_validated', 'visual_validated',
  'needs_visual_review', 'invalid', 'blocked', 'failed_permanent']);

/** 장부의 속내를 바깥 어휘 셋으로 옮긴다. */
export function publicDetailState(ledgerState) {
  if (!ledgerState) return 'known_deferred';
  if (AS_QUEUED.has(ledgerState)) return 'queued';
  if (AS_FETCHED.has(ledgerState)) return 'fetched';
  return 'known_deferred';                 // known_deferred·excluded 등은 아직 안 본 것으로 본다
}

/**
 * 상세 주소가 없을 때 쓰는 결정적 ID.
 *
 * [가장 중요한 것] 같은 카드는 같은 ID 여야 한다. 자리(position)를 무조건 섞으면
 * 1쪽의 다섯째와 2쪽의 첫째가 같은 그림인데도 다른 카드가 된다.
 * 그래서 그림 주소가 있으면 그것만으로 만든다. 자리와 목록 주소는 근거로만 남긴다.
 * 그림 주소가 없거나 한 쪽에서 같은 그림이 여러 카드에 쓰여 부딪힐 때만 자리를 보태고,
 * 그때는 얼마나 믿을 수 있는지(id_confidence)와 이유를 함께 남긴다.
 */
export function fallbackCardId({ domain, sourceUrl, position, imgUrl, disambiguate = false }) {
  const src = (() => {
    try { const u = new URL(sourceUrl); return u.pathname + u.search; } catch { return String(sourceUrl || ''); }
  })();
  if (imgUrl && !disambiguate) {
    const basis = `${domain || ''}|img:${imgUrl}`;
    return {
      id: `fb-${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 18)}`,
      basis, confidence: 'image_url', why: null,
    };
  }
  const basis = `${domain || ''}|src:${src}|pos:${position}|img:${imgUrl || ''}`;
  return {
    id: `fb-${crypto.createHash('sha256').update(basis).digest('hex').slice(0, 18)}`,
    basis, confidence: 'position_fallback',
    why: imgUrl ? 'same_image_reused_on_page' : 'no_image_url',
  };
}

/**
 * judge 가 고른 카드와 브라우저가 잰 자리를 정규화 주소로 맞춘다.
 * @param {object[]} chosen  judge.findCardGroups 의 cards — [{href, img, text}]
 * @param {object[]} raw     browser 의 card_candidates — [{href, img, x,y,w,h}]
 * @param {object} normOpts  장부와 같은 정규화 설정
 */
export function matchBoxes(chosen, raw, normOpts, baseUrl) {
  const norm = (u) => { try { return u ? normalizeUrl(u, normOpts).url : null; } catch { return null; } };
  // 이미지 주소는 반드시 절대형으로 맞춘다. 상대 표기 그대로 쓰면 같은 그림이 다른 것이 된다.
  const absImg = (u) => { try { return u ? new URL(u, baseUrl).toString() : null; } catch { return null; } };

  const byHref = new Map();
  const byImg = new Map();
  for (const r of raw || []) {
    const k = norm(r.href);
    if (k && !byHref.has(k)) byHref.set(k, r);       // 같은 주소가 여럿이면 먼저 나온 자리를 쓴다
    const im = absImg(r.img);
    if (im && !byImg.has(im)) byImg.set(im, r);
  }
  const out = [];
  const used = new Set();
  for (let i = 0; i < (chosen || []).length; i++) {
    const c = chosen[i];
    const k = norm(c.href);
    const im = absImg(c.img);
    // 상세 주소가 있으면 그것으로, 없으면(덮개 창 목록) 이미지 주소로 자리를 찾는다
    let box = k ? byHref.get(k) : null;
    if (!box && im) box = byImg.get(im);
    if (box && used.has(box)) box = null;            // 한 자리를 두 카드가 나눠 갖지 않는다
    if (box) used.add(box);
    out.push({ position: i, href: c.href || null, norm_href: k, img_abs: im, text: c.text || '', box: box || null });
  }
  return out;
}

/**
 * 카드 한 장의 기록을 만든다. 자르기 결과는 나중에 붙인다.
 * @param {object} ctx { crawl, sourceUrl, domain, capturePath, cycle, normOpts, ledgerState }
 */
export function buildCard(m, ctx) {
  const detailUrl = m.norm_href || null;
  let id;
  let idBasis;
  let idConfidence = 'detail_url';
  let idWhy = null;
  if (detailUrl) {
    id = normalizeUrl(detailUrl, ctx.normOpts).id;
    idBasis = 'detail_url';
  } else {
    // 한 쪽에서 같은 그림이 여러 카드에 쓰였으면 그림만으로는 못 가린다 — 그때만 자리를 보탠다
    const reused = (ctx.imageCounts?.get(m.img_abs) || 0) > 1;
    const fb = fallbackCardId({
      domain: ctx.domain, sourceUrl: ctx.sourceUrl, position: m.position,
      imgUrl: m.img_abs, disambiguate: reused,
    });
    id = fb.id;
    idBasis = `fallback(${fb.basis})`;
    idConfidence = fb.confidence;
    idWhy = fb.why;
  }
  // 상세를 이미 아는지는 장부가 답한다. 모르면 "알지만 아직 안 깨움" 이다.
  const known = detailUrl ? ctx.ledgerState?.urls?.[id] : null;
  return {
    card_id: id,
    card_id_basis: idBasis,
    id_confidence: idConfidence,
    id_why: idWhy,
    source_url: ctx.sourceUrl,
    source_url_id: ctx.sourceUrlId || null,   // 이 카드를 실어 준 목록. 나중에 상세를 깨울 때 부모가 된다.
    domain: ctx.domain,
    position: m.position,
    detail_url: detailUrl,
    detail_state: publicDetailState(known?.state),
    image_url: m.img_abs || null,
    title: m.text || null,
    capture_path: ctx.capturePath || null,
    bbox: m.box ? { x: m.box.x, y: m.box.y, w: m.box.w, h: m.box.h } : null,
    crop_path: null,
    crop_why: m.box ? null : 'no_bbox',
    discovered_cycle: null,   // 장부에 처음 합쳐질 때 그 회차로 박힌다(재시도로 바뀌지 않는다)
  };
}
