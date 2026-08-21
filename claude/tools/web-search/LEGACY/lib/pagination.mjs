// web-search — 쪽 나눔 판정
// 계획서 2-7 "새 카드가 안 나오는 연속 페이지 감지". 태스크 17.
//
// [원칙 1] 도착 순서를 보지 않는다. 워커가 3·1·2 순서로 보고해도 같은 답이 나와야 한다.
//   그래서 "보고 시점에 새로웠던 수"를 저장하지 않는다 — 그 값은 순서에 따라 달라진다.
//   각 쪽이 실제로 내놓은 상세 주소 집합을 그대로 저장하고, 셀 때마다 앞선 쪽들의 합집합을 빼서
//   그 자리에서 다시 센다.
// [원칙 2] 제대로 본 쪽에만 0 을 적는다. 못 가져왔거나 화면을 못 봤거나 추출이 미심쩍은 쪽은
//   "모름"이고, 모름은 연속을 끊는다. 실패를 0 으로 세면 사이트가 마른 것으로 착각한다.
// [원칙 3] 경로 끝 숫자를 함부로 쪽 번호로 읽지 않는다. 상세 주소의 상품 번호가 쪽 번호로 둔갑하면
//   서로 다른 상품이 한 묶음의 여러 쪽이 된다.

// 쪽 번호가 담기는 흔한 파라미터.
// offset·start 는 "몇 쪽"이 아니라 "몇 번째부터"라, 한 쪽에 몇 개인지 모르면 이어짐을 잴 수 없다.
// 그래서 기본에서 뺀다. 보폭을 아는 사이트에만 opts.offsetStep 으로 켠다.
const PAGE_KEYS = ['page', 'p', 'pageno', 'page_no', 'pagenum', 'pageindex'];
const OFFSET_KEYS = ['offset', 'start'];
// 경로로 쪽을 나누는 흔한 모양 — /list/page/3, /list/p/3, /list/3 은 앞이 목록일 때만 인정한다
const PATH_PAGE = /\/(page|p|pg|pages)\/(\d+)$/i;

/**
 * 이 주소가 어떤 목록 묶음의 몇 쪽인가.
 * @param {string} url  정규화된 주소
 * @param {object} opts { kind, kindSource }  장부가 아는 이 주소의 종류
 * @returns {{series:string, index:number}|null}  쪽으로 볼 수 없으면 null
 */
export function pageOf(url, opts = {}) {
  let u;
  try { u = new URL(url); } catch { return null; }

  // [목록만] 쪽 나눔은 목록의 성질이다. 상세 주소에 ?p=상품번호 가 붙어 있다고 쪽으로 읽으면
  // 서로 다른 상품이 한 묶음의 여러 쪽으로 둔갑한다. 장부가 목록이라고 확정했을 때만 본다.
  const confirmedListing = opts.kind === 'listing' && !!opts.kindSource && opts.kindSource !== 'default';
  if (!confirmedListing) return null;

  const seriesOf = (mut) => {
    const rest = new URL(u.toString());
    mut(rest);
    rest.hash = '';
    return rest.toString();
  };

  // (가) 쿼리로 쪽을 나누는 경우
  for (const key of PAGE_KEYS) {
    for (const [k, v] of u.searchParams.entries()) {
      if (k.toLowerCase() !== key) continue;
      if (!/^\d+$/.test(v)) continue;
      // 쪽 번호만 뺀 나머지가 묶음 열쇠다 — 정렬·분류가 다르면 다른 묶음이다
      return {
        series: seriesOf((r) => {
          for (const kk of [...r.searchParams.keys()]) if (kk.toLowerCase() === k.toLowerCase()) r.searchParams.delete(kk);
        }),
        index: Number(v),
      };
    }
  }

  // (가-2) 위치로 나누는 경우 — 보폭을 알 때만 쪽 번호로 옮긴다
  if (Number.isInteger(opts.offsetStep) && opts.offsetStep > 0) {
    for (const key of OFFSET_KEYS) {
      for (const [k, v] of u.searchParams.entries()) {
        if (k.toLowerCase() !== key) continue;
        if (!/^\d+$/.test(v)) continue;
        if (Number(v) % opts.offsetStep !== 0) continue;      // 보폭과 안 맞으면 쪽이 아니다
        return {
          series: seriesOf((r) => {
            for (const kk of [...r.searchParams.keys()]) if (kk.toLowerCase() === k.toLowerCase()) r.searchParams.delete(kk);
          }),
          index: Number(v) / opts.offsetStep + 1,
        };
      }
    }
  }

  // (나) 경로로 쪽을 나누는 경우 — /…/page/3 처럼 쪽이라는 말이 경로에 있을 때만
  const m = u.pathname.match(PATH_PAGE);
  if (m) return { series: seriesOf((r) => { r.pathname = u.pathname.slice(0, m.index) || '/'; }), index: Number(m[2]) };

  // (다) 경로 끝이 그냥 숫자인 경우 — 목록으로 확정된 주소에서만 쪽으로 읽는다
  const tail = u.pathname.match(/^(.*)\/(\d+)$/);
  if (tail) return { series: seriesOf((r) => { r.pathname = tail[1] || '/'; }), index: Number(tail[2]) };
  return null;
}

/**
 * 이 쪽에서 무엇을 얻었는지 한 칸으로 만든다.
 * 정상으로 본 쪽만 emitted 를 담고, 나머지는 unknown 이다.
 */
export function pageObservation({ pageValidity, visual, extractionStatus, detailIds }) {
  // 확정된 것만 0 으로 셀 수 있다. incomplete·uncertain 은 "모른다"이지 "없다"가 아니다.
  const EXTRACT_OK = ['complete', 'ok', 'extracted'];
  const contentOk = pageValidity === 'content_validated' || pageValidity === 'visual_validated';
  const visualOk = visual !== 'visual_unverified';
  const extractOk = !extractionStatus || EXTRACT_OK.includes(extractionStatus);
  if (!contentOk || !visualOk || !extractOk) {
    return {
      unknown: true,
      why: !contentOk ? `page_validity:${pageValidity || 'none'}`
        : !visualOk ? 'visual_unverified' : `extraction:${extractionStatus}`,
      emitted: [],
    };
  }
  return { unknown: false, emitted: [...new Set(detailIds || [])] };
}

/**
 * 한 묶음의 마름을 잰다. 쪽 번호 오름차순으로 훑으며 앞선 쪽들의 합집합을 빼서 매번 다시 센다.
 * @param {object} series  { pages: { [index]: { emitted:[], unknown:bool, why } } }
 * @param {number} needed  몇 쪽 연속이면 말랐다고 볼 것인가
 */
export function seriesDryness(series, needed = 3) {
  const idxs = Object.keys(series.pages || {}).map(Number).sort((a, b) => a - b);
  const seen = new Set();
  let streak = 0, best = 0, dryFrom = null, brokenBy = null, prev = null;
  const perPage = [];
  const gaps = [];

  for (const i of idxs) {
    // [이어짐] 1·100·101 을 세 쪽 연속으로 세면 안 된다. 사이가 비었으면 그 사이에
    // 무엇이 있었는지 모르는 것이므로 연속을 끊고 빈 구간을 근거로 남긴다.
    if (prev !== null && i !== prev + 1) {
      gaps.push({ from: prev, to: i, missing: i - prev - 1 });
      streak = 0; dryFrom = null; brokenBy = { index: i, why: `gap_after_${prev}` };
    }
    prev = i;
    const rec = series.pages[i];
    if (rec.unknown) {
      // 모르는 쪽은 0 이 아니다. 연속을 끊고 왜 몰랐는지 남긴다.
      perPage.push({ index: i, novelty: null, unknown: true, why: rec.why });
      streak = 0; dryFrom = null; brokenBy = { index: i, why: rec.why };
      continue;
    }
    const fresh = (rec.emitted || []).filter((id) => !seen.has(id));
    perPage.push({ index: i, novelty: fresh.length, unknown: false });
    for (const id of rec.emitted || []) seen.add(id);
    if (fresh.length === 0) {
      streak += 1;
      if (dryFrom === null) dryFrom = i;
      if (streak > best) best = streak;
    } else {
      streak = 0; dryFrom = null;
    }
  }
  return {
    pages: idxs.length,
    per_page: perPage,
    unique_details: seen.size,
    dry_streak: streak,
    longest_dry_streak: best,
    dry_from: streak >= needed ? dryFrom : null,
    dry: streak >= needed,
    broken_by: brokenBy,
    gaps,
  };
}
