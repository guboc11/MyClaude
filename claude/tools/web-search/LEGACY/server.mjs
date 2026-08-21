#!/usr/bin/env node
// web-search — 무의존성 MCP stdio 서버 (레퍼런스 대량 수집용 크롤러)
//
// 계획서: <project>/_PLAN/2026-08-11-web-search-mcp/PLAN.md
// 저장:   <project>/.claude/web-search/{크롤}/…  (전역 pace 만 global/ 아래)
// project 경로: CLAUDE_PROJECT_DIR > process.cwd()
// stdout 에는 JSON-RPC 만, 로그는 stderr 로. 긴 결과는 파일에 쓰고 응답은 짧게.
//
// 이 파일은 1~5 단계(뼈대·잠금·장부·임대·pace)까지만 담는다.
// discover/fetch/판정기는 게이트 1 통과 뒤 8번 태스크부터 붙인다.

import path from 'node:path';
import { listCrawls, crawlPaths, root } from './lib/paths.mjs';
import * as store from './lib/store.mjs';
import * as pace from './lib/pace.mjs';
import { repairLock, lockStatus } from './lib/lock.mjs';
import { normalizeUrl } from './lib/url.mjs';

const log = (...a) => process.stderr.write(`[web-search] ${a.join(' ')}\n`);

// ---- 도구 구현 ----

function toolCrawlNew({ crawl, seeds = [], policy = {} }) {
  const r = store.createCrawl(crawl, { seeds, policy });
  return `크롤 생성: ${crawl}\n- mode=${r.policy.mode}, 씨앗 ${r.seeds_added}개(중복 ${r.duplicates})\n- ${crawlPaths(crawl).dir}`;
}

function toolAddUrls({ crawl, urls = [], kind = 'unknown', depth = 0, via = 'manual', from_url_id = null, discovered_by = 'manual', base }) {
  const items = urls.map((u) => ({ url: u, kind, depth, via, from_url_id, discovered_by, base }));
  const r = store.addUrls(crawl, items);
  const why = [...new Set((r.rejects || []).map((x) => x.why))];
  return `추가 ${r.added} · 중복 ${r.duplicates} · 거절 ${r.rejected}${why.length ? ` (${why.join(', ')})` : ''}`;
}

// 경계를 넓힌다. 누가·왜가 없으면 받지 않는다 — 나중에 왜 넓혔는지 알 길이 없어진다.
function toolUpdatePolicy({ crawl, patch, who, reason }) {
  const r = store.updatePolicy(crawl, patch, { who, reason });
  const ch = Object.entries(patch).map(([k, v]) => `${k} ${store.loadPolicy(crawl)[k] === v ? '→' : '→'} ${v}`).join(', ');
  return [
    `정책 갱신(${who}): ${ch}`,
    `사유: ${reason}`,
    `세워 뒀던 후보 중 ${r.readmitted_count}건이 큐로 돌아갔고 ${r.still_waiting}건이 남았습니다.`,
    r.boundary_review_cleared.length ? `검토 내림: ${r.boundary_review_cleared.join(', ')}` : '검토 남음(남은 후보가 있습니다)',
  ].join('\n');
}

// 근거만 읽는 통로. 아무것도 바꾸지 않는다 — 판단은 사람이 한다.
function toolEvidence({ crawl, what, limit = 20 }) {
  if (what === 'content_groups') {
    const gs = store.listContentGroups(crawl);
    if (!gs.length) return '내용이 같아 보이는 묶음이 없습니다.';
    return [`같아 보이는 묶음 ${gs.length}개 (아무것도 지우지 않았습니다)`,
      ...gs.slice(0, limit).map((g) => `- ${g.hash.slice(0, 12)} · ${g.url_ids.length}칸 · ${g.urls.slice(0, 3).join(' , ')}`),
    ].join('\n');
  }
  if (what === 'page_series') {
    const ss = store.listPageSeries(crawl);
    if (!ss.length) return '쪽 나눈 묶음이 아직 없습니다.';
    return [`쪽 묶음 ${ss.length}개 (마름은 검토 표시일 뿐, 주소를 버리지 않습니다)`,
      ...ss.slice(0, limit).map((s) => `- ${s.series} · ${s.pages}쪽 · 고유 상세 ${s.unique_details}개 · `
        + `마름=${s.dry}${s.dry_from ? `(${s.dry_from}쪽부터)` : ''}`
        + `${s.gaps.length ? ` · 빈 구간 ${s.gaps.length}곳` : ''}`
        + `${s.broken_by ? ` · 끊김 ${s.broken_by.index}쪽(${s.broken_by.why})` : ''}`),
    ].join('\n');
  }
  if (what === 'excluded') {
    const e = store.listExcluded(crawl);
    return [`안 들인 것 ${e.active.length}건 · 나중에 풀린 것 ${e.resolved.length}건`,
      ...e.active.slice(0, limit).map((x) => `- ${x.url} · ${x.why} · ${JSON.stringify(x.evidence || {})} · ${x.seen_count}번 만남`),
    ].join('\n');
  }
  const s = store.status(crawl);
  return [`경계 검토 대기 도메인 ${s.boundary_review_domains.length}곳 · 세워 둔 후보 ${s.boundary_candidates}건`,
    ...s.excluded_by.slice(0, limit).map((x) => `- ${x.domain} · ${x.rule} · ${x.count}건`),
  ].join('\n');
}

// 고른 카드의 상세만 깨운다. 판정은 addUrls 한 길만 지난다.
function toolWakeDetails({ crawl, card_ids, who, reason }) {
  const r = store.wakeDetails(crawl, card_ids, { who, reason });
  const bySkip = {};
  for (const s of r.skipped) bySkip[s.why] = (bySkip[s.why] || 0) + 1;
  return [
    `깨움 ${r.queued}건 / 요청 ${r.requested}건`,
    Object.keys(bySkip).length ? `건너뜀: ${Object.entries(bySkip).map(([k, v]) => `${k} ${v}건`).join(' · ')}` : '건너뛴 것 없음',
    r.rejected.length ? `경계에서 거절 ${r.rejected.length}건: ${[...new Set(r.rejected.map((x) => x.why))].join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function toolSnapshot({ crawl, who, reason, force = false, list = false }) {
  if (list) {
    const xs = store.listSnapshots(crawl);
    return xs.length
      ? xs.map((s) => `#${s.snapshot} · 카드 ${s.cards}장 · v${s.state_version} · ${s.at_iso}${s.forced ? ' (억지로 뜸)' : ''}`).join('\n')
      : '뜬 고정판이 없습니다.';
  }
  const m = store.snapshotNew(crawl, { who, reason, force });
  return [
    `고정판 #${m.snapshot} 떴습니다 — 카드 ${m.cards}장 · 잘린 그림 ${m.crops}개`,
    `장부 판 v${m.state_version} · 지문 ${m.cards_sha256.slice(0, 16)}`,
    `${m.dir}`,
  ].join('\n');
}

function toolCycleReport({ crawl, who, reason }) {
  const r = store.writeCycleReport(crawl, { who, reason });
  if (r.unchanged) return `장부가 그대로라 새 회차를 열지 않았습니다. 지난 보고서: ${r.path}`;
  return `${r.cycle}회차 보고서를 썼습니다 → ${r.path}\n다음 회차는 ${r.next_cycle} 입니다.`;
}

function toolLease({ crawl, n = 10, worker = '' }) {
  const r = store.lease(crawl, n, worker || process.env.CMUX_SURFACE_ID || '');
  if (!r.leased.length) return `빌려줄 것이 없습니다. (대기 ${r.remaining_queued})`;
  const lines = r.leased.map((x) => `${x.url_id} ${x.kind} ${x.url}\n    token=${x.lease_token}`);
  return `${r.leased.length}건 임대 (대기 ${r.remaining_queued} 남음)\n${lines.join('\n')}`;
}

function toolReport({ crawl, items = [], report_id }) {
  const r = store.report(crawl, items, report_id);
  if (r.duplicate) return `이미 반영된 report 입니다(멱등): ${report_id}`;
  const rej = r.rejects?.length ? `\n거절: ${r.rejects.map((x) => `${x.url_id}(${x.why})`).join(', ')}` : '';
  // 첫머리(반영 N · 거절 M)는 워커가 읽는 자리라 모양을 지킨다. 링크 셈은 그 뒤에 붙인다.
  const links = r.links_seen ? ` · 링크 본 것 ${r.links_seen} · 들인 것 ${r.links_added}` : '';
  return `report ${r.report_id} — 반영 ${r.accepted} · 거절 ${r.rejected}${links}${rej}`;
}

function toolStatus({ crawl }) {
  const s = store.status(crawl);
  // 이름을 잘못 쓴 것과 "정말 비어 있는 크롤" 은 다르다. 섞어서 보여 주면 워커가 다 봤다고 착각한다.
  if (!s.exists) {
    const have = listCrawls();
    return `[${crawl}] 그런 크롤이 없습니다.\n`
      + `있는 크롤: ${have.length ? have.join(' · ') : '아직 없음(crawl_new 로 만드세요)'}`;
  }
  const counts = Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(' · ') || '없음';
  const doms = Object.entries(s.domains).slice(0, 15)
    .map(([d, c]) => `  ${d}: ${Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' ')}`).join('\n');
  const rules = s.excluded_by.slice(0, 5).map((x) => `${x.rule}=${x.count}`).join(' · ');
  const cov = Object.entries(s.coverage).map(([axis, c]) =>
    `  ${axis}: 빈칸 [${c.blanks.join(', ') || '없음'}] · 찾음 [${c.found.join(', ') || '없음'}]`
    + `${c.unlabeled_domains.length ? ` · 표 없는 도메인 ${c.unlabeled_domains.length}곳` : ''}`).join('\n');
  const mism = [...s.card_count_mismatch.slice(0, 3).map((m) => `${m.url} 표시 ${m.declared}≠잡은 ${m.found}`),
    ...s.declared_needs_review.slice(0, 3).map((m) => `${m.url} 표시 ${m.declared}(범위 모름)`)].join(' · ');
  return [
    `[${s.crawl}] v${s.version} · mode=${s.mode}${s.sampled ? '(표본)' : ''} · 전체 ${s.total}`,
    `상태: ${counts}`,
    `완료판정: ${s.completion} (${s.completion_reason})`,
    s.blocker_total ? `막힘 ${s.blocker_total}건` : '막힘 없음',
    // 검토 근거 요약 — 자동으로 버리지 않으므로 사람이 볼 수 있어야 한다
    `같아 보이는 묶음 ${s.content_groups}개 · 쪽 묶음 ${s.page_series_total}개(마름 ${s.dry_page_series}개)`,
    `안 들임 ${s.excluded_active}건(풀린 이력 ${s.excluded_resolved}건)${rules ? ` — ${rules}` : ''}`,
    s.review_required ? `사람 확인 대기 ${s.review_required}건` : '',
    s.boundary_candidates ? `상한에 세워 둔 후보 ${s.boundary_candidates}건` : '',
    // 어떤 형태가 얼마나 늘어 상한에 닿았는지 — 개수만으로는 사람이 판단할 수 없다
    ...s.boundary_reviews.slice(0, 5).map((b) => `경계 검토 ${b.domain}: ${b.why}(상한 ${b.evidence?.cap ?? '?'})`
      + ` · 형태 ${b.top_shapes.map((x) => `${x.what} ${x.count}개`).join(', ') || '없음'}`
      + `${b.top_combos.length ? ` · 조합 ${b.top_combos.map((x) => `${x.what || '(없음)'} ${x.count}개`).join(', ')}` : ''}`
      + `${b.top_facet_keys.length ? ` · 거르개 키 ${b.top_facet_keys.map((x) => `${x.what} ${x.count}개`).join(', ')}` : ''}`),
    `카드 ${s.cards_total}장 · 표시 수 대조 ${mism ? `어긋남/미확인 ${s.card_count_mismatch.length + s.declared_needs_review.length}곳 — ${mism}` : '어긋남 없음'}`,
    `자주 나온 도메인: ${s.top_domains.slice(0, 5).map((d) => `${d.domain}(${d.urls})`).join(' · ') || '없음'}`,
    `자주 나온 낱말: ${s.top_words.slice(0, 8).map((t) => `${t.term}(${t.count})`).join(' · ') || '없음'}`,
    s.blockers.length ? `막힌 곳 표본: ${s.blockers.slice(0, 3).map((b) => `${b.url}(${b.state})`).join(' · ')}` : '',
    cov ? `빈칸 표:\n${cov}` : '빈칸 표: 목표 미지정(coverage_targets 를 적어야 채워집니다)',
    `훑기 회차 ${s.cycle}`,
    doms ? `도메인:\n${doms}` : '',
  ].filter(Boolean).join('\n');
}

function toolPaceReserve({ domain, min_interval_ms, jitter_ms, daily_cap }) {
  const r = pace.reserve(domain, { min_interval_ms, jitter_ms, daily_cap });
  return r.ok
    ? `예약됨 ${domain} — 다음 간격 ${r.reserved_gap_ms}ms, 오늘 ${r.today_count}건`
    : `대기 ${r.wait_seconds}초 (${r.why})`;
}

function toolPaceRecord({ domain, blocked = false, failed = false }) {
  const r = pace.record(domain, { blocked, failed });
  return `${domain} — block_score=${r.block_score}, sleep_until=${r.sleep_until || 0}`;
}

function toolPacePeek({ domain }) {
  const r = pace.peek(domain);
  return `${domain} — 오늘 ${r.today_count}건, 대기 ${r.waiting_seconds}초, block_score=${r.block_score}`;
}

function toolRepairLock({ crawl }) {
  const p = crawlPaths(crawl);
  const st = lockStatus(p.lock);
  if (!st.held) return '잠금이 없습니다.';
  const r = repairLock(p.lock, p.stale);
  return `${r.note}\n이전 주인: pid=${st.owner?.pid} instance=${st.owner?.instance_id?.slice(0, 8)} 경과=${st.age_ms}ms`;
}

function toolLockStatus({ crawl }) {
  const st = lockStatus(crawlPaths(crawl).lock);
  if (!st.held) return '잠금 없음(유휴)';
  return `잠금 있음 — pid=${st.owner?.pid}, 경과 ${st.age_ms}ms, 만료됨=${st.expired}, pid살아있음=${st.pid_alive}\n판정: ${st.verdict}`;
}

// 한 주소를 실제로 가져온다. 본문·카드 목록은 돌려주지 않는다 — 컨텍스트로 올라가면 그게 곧 비용이다.
// 짧은 증거 요약과 manifest 경로만 준다.
async function toolFetch({ crawl, url, url_id, lease_token, kind = 'unknown', max_tier = 'chrome' }) {
  const { fetchOne } = await import('./lib/fetch.mjs');
  const r = await fetchOne(crawl, { url, url_id, lease_token, kind, maxTier: max_tier });

  if (r.refused) return `거절: ${r.why} (네트워크 ${r.network_calls}회)`;
  if (r.deferred) {
    return `대기 ${r.wait_seconds}초 (${r.why}) — 네트워크 ${r.network_calls}회\n`
      + `이어갈 곳: ${r.resume?.next_tier} · 끝낸 단 [${(r.resume?.done_tiers || []).join(',')}]\n`
      + `같은 lease_token 으로 다시 부르면 끝낸 단은 다시 요청하지 않습니다.`;
  }
  const mdir = path.join(crawlPaths(crawl).manifests, r.url_id);
  return [
    `${r.page_validity} · 추출 ${r.extraction_status} · ${r.visual}`,
    `status ${r.status}${r.final !== r.requested ? `  final ${r.final}` : ''}`,
    `tier content=${r.content_tier} visual=${r.visual_tier || '-'} · 카드 ${r.cards}${r.declared != null ? `/표시 ${r.declared}` : ''}`,
    r.positive_evidence?.length ? `증거 [${r.positive_evidence.join(', ')}]` : '증거 없음',
    r.negatives?.length ? `부정 [${r.negatives.join(', ')}]` : '',
    r.flags?.length ? `flags [${r.flags.join(', ')}]` : '',
    `단계 ${(r.attempts || []).map((a) => `${a.tier}:${a.status}`).join(' → ')} · 네트워크 ${r.network_calls}회`,
    r.shot ? `캡처 ${r.shot}` : '캡처 없음',
    `manifest ${mdir}/${r.attempt_id}.json`,
  ].filter(Boolean).join('\n');
}

// robots·사이트맵·내부 링크로 주소를 찾는다. 스스로 네트워크를 건드리지 않고 fetch 를 거친다.
// 응답에는 주소 목록을 담지 않는다 — 개수와 보고서 경로만.
async function toolDiscover({ crawl, origin, skip_sitemaps = false, sitemap_seeds = [], refresh = false, worker = '' }) {
  const { discover } = await import('./lib/discover.mjs');
  const r = await discover(crawl, {
    origin, skipSitemaps: skip_sitemaps, sitemapSeeds: sitemap_seeds, refresh,
    worker: worker || process.env.CMUX_SURFACE_ID || '',
  });

  // 끝낸 회차를 다시 부른 것 — 다시 훑지 않았다. 그 사실을 감추지 않는다.
  if (r.reused_finished_run) {
    return [
      `이미 끝낸 회차입니다 (${r.finished_at_iso}) — 이번 호출은 네트워크 0회`,
      `그때 결과: 발견 ${r.found}건 · 사이트맵 ${r.sitemaps_visited.length}개 · 네트워크 ${r.run_network_calls}회`,
      '다시 훑으려면 refresh: true 를 주세요.',
      `보고서 ${r.report}`,
    ].join('\n');
  }

  // 완주하지 않았으면 보고서 파일이 없다. 없는 경로를 지어내지 말고 남은 일만 짧게 돌려준다.
  if (r.deferred) {
    return [
      `아직 안 끝났습니다 — ${r.wait_seconds}초 뒤 같은 호출로 이어 부르세요 (사유 ${r.why})`,
      `단계 ${r.stage} · 남은 사이트맵 큐 ${r.queue_left}개 · 지금까지 발견 ${r.found}건 · 네트워크 ${r.network_calls}회`,
      'lastmod 스냅샷은 완주 전에는 갈지 않습니다.',
    ].join('\n');
  }
  if (r.aborted) {
    return [
      `경계에서 멈췄습니다(needs_boundary_review) — 깊이 ${r.offending?.depth} 에서 ${r.offending?.url}`,
      `단계 ${r.stage} · 남은 큐 ${r.queue_left}개 · 미결 ${r.needs_boundary_review?.length ?? 0}건`,
      'policy.sitemap_depth_max 를 넓힌 뒤 같은 호출로 이어 부르세요. 스냅샷·사라짐 판정은 하지 않았습니다.',
    ].join('\n');
  }

  const lm = r.lastmod_summary;
  return [
    `발견 ${r.found}건 · 중복 ${r.duplicates}건 · 네트워크 ${r.network_calls}회`,
    `사이트맵 ${r.sitemaps_visited.length}개 방문 (robots 선언 ${r.robots_sitemaps.length}개)`,
    `lastmod — 새것 ${lm.new} · 바뀐것 ${lm.changed} · 그대로 ${lm.unchanged} · 재방문 후보 ${r.revisit_candidates}`,
    r.disappeared_marked ? `사이트맵에서 사라짐 ${r.disappeared_marked}건 (삭제 아님, 확인 필요)` : '',
    r.reappeared ? `다시 나타남 ${r.reappeared}건 (사라짐 표시 해제)` : '',
    r.suspected_duplicates ? `내용 같아 보임 ${r.suspected_duplicates}건 (표시만, 폐기 안 함)` : '',
    r.refused ? `임대 거절 ${r.refused}건` : '',
    r.skipped?.length ? `건너뜀 ${r.skipped.length}건 (사유 ${[...new Set(r.skipped.map((s) => s.why))].join(', ')})` : '',
    `보고서 ${r.report}`,
  ].filter(Boolean).join('\n');
}

// 프로필 상태는 명시 호출로만 바뀐다 — 자동 발견이 사람의 판단을 덮지 않는다.
async function toolConfirmProfile({ crawl, domain, who, reason }) {
  const { confirmProfile } = await import('./lib/discover.mjs');
  const r = confirmProfile(crawl, domain, { who, reason });
  return `${domain}: ${r.from} → confirmed (by ${r.profile.confirmed_by})\n${r.file}`;
}

async function toolOverrideProfile({ crawl, domain, selectors, who, reason }) {
  const { overrideProfile } = await import('./lib/discover.mjs');
  const r = overrideProfile(crawl, domain, { selectors, who, reason });
  return `${domain}: ${r.from} → manual_override (by ${r.profile.overridden_by})\n${r.file}`;
}

async function toolProfileStatus({ crawl, domain }) {
  const { readProfile } = await import('./lib/discover.mjs');
  const p = readProfile(crawl, domain);
  if (!p) return `제안된 프로필이 없습니다: ${domain}`;
  const hist = (p.history || []).map((h) => `  ${h.at_iso} ${h.from}→${h.to} by ${h.who}${h.reason ? ` (${h.reason})` : ''}`).join('\n');
  return `${domain} · status=${p.status} · 목록패턴 ${p.listing_path_patterns?.length ?? 0}개\n이력:\n${hist || '  없음'}`;
}

function toolNormalize({ url, base }) {
  const n = normalizeUrl(url, { base });
  return `${n.url}\nid=${n.id} domain=${n.domain}${n.dropped.length ? ` dropped=${n.dropped.join(',')}` : ''}`;
}

function toolList() {
  const cs = listCrawls();
  return cs.length ? `크롤 ${cs.length}개:\n- ${cs.join('\n- ')}\n(${root()})` : `크롤이 없습니다. (${root()})`;
}

// ---- MCP 도구 정의 ----

const TOOLS = [
  { name: 'crawl_new', description: '크롤을 만들고 씨앗과 경계(policy)를 고정한다. 크롤은 저절로 수렴하지 않으므로 경계가 필수다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl'], properties: {
      crawl: { type: 'string' }, seeds: { type: 'array', items: { type: 'string' } },
      policy: { type: 'object', additionalProperties: true } } } },
  { name: 'add_urls', description: '주소를 더미에 넣는다. 정규화 후 url_id 로 중복을 거르고, 경계를 통과한 것만 들어간다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl', 'urls'], properties: {
      crawl: { type: 'string' }, urls: { type: 'array', items: { type: 'string' } },
      kind: { type: 'string', enum: ['listing', 'detail', 'sitemap', 'unknown'] },
      via: { type: 'string', enum: ['seed', 'robots', 'sitemap', 'internal', 'manual', 'link', 'report'],
        description: 'link·report 는 장부에 있는 from_url_id 를 함께 대야 한다' },
      from_url_id: { type: 'string' },
      depth: { type: 'integer' }, discovered_by: { type: 'string' }, base: { type: 'string' } } } },
  { name: 'update_policy', description: '경계 상한을 넓힌다(좁히기·모드·도메인 변경 불가). 세워 뒀던 후보를 그 자리에서 다시 재 큐로 돌린다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl', 'patch', 'who', 'reason'], properties: {
      crawl: { type: 'string' },
      patch: { type: 'object', additionalProperties: true, minProperties: 1, description: '예: { "domain_url_cap": 5000 }' },
      who: { type: 'string', minLength: 1, description: '누가 넓히는가' },
      reason: { type: 'string', minLength: 1, description: '왜 넓히는가 — 무엇을 보고 판단했는지' } } } },
  { name: 'evidence', description: '판단 근거만 읽는다(바꾸지 않는다). 같아 보이는 묶음·쪽 묶음의 마름·안 들인 것과 그 사유.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl', 'what'], properties: {
      crawl: { type: 'string' },
      what: { type: 'string', enum: ['content_groups', 'page_series', 'excluded', 'boundary'] },
      limit: { type: 'integer', minimum: 1, maximum: 200 } } } },
  { name: 'wake_details', description: '고른 카드의 상세만 깨워 대기줄에 올린다. 상세 주소가 없거나 이미 처리된 카드는 사유와 함께 건너뛴다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl', 'card_ids', 'who', 'reason'], properties: {
      crawl: { type: 'string' },
      card_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
      who: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 } } } },
  { name: 'snapshot', description: '지금 상태를 고정판으로 뜬다(고르기 도구는 이것만 읽는다). 기본은 완료 상태에서만.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl'], properties: {
      crawl: { type: 'string' },
      who: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 },
      force: { type: 'boolean', description: '아직 안 끝났어도 뜬다(그 사실이 고정판에 적힌다)' },
      list: { type: 'boolean', description: '뜬 고정판 목록만 본다' } } } },
  { name: 'cycle_report', description: '이번 회차 보고서를 쓰고 회차를 넘긴다. 장부가 그대로면 새 회차를 열지 않는다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl', 'who', 'reason'], properties: {
      crawl: { type: 'string' }, who: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 } } } },
  { name: 'lease', description: '대기 중인 것 n개를 겹치지 않게 빌려준다. 시간 안에 report 가 안 오면 회수해 다시 내보낸다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl'], properties: {
      crawl: { type: 'string' }, n: { type: 'integer' }, worker: { type: 'string' } } } },
  { name: 'report', description: '결과를 반납한다. lease_token 이 현재 것과 다르면 거절하고, 같은 report_id 는 한 번만 반영한다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl', 'items'], properties: {
      crawl: { type: 'string' }, report_id: { type: 'string' },
      items: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
  { name: 'fetch', description: '주소 하나를 실제로 가져온다. lease_token 이 없으면 네트워크를 건드리지 않고 거절한다. curl→Jina→헤드리스→실제 크롬으로 스스로 올라가며, 예약에 막히면 남은 초와 이어갈 자리를 돌려준다(끝낸 단은 다시 요청하지 않는다). 본문이 아니라 증거 요약과 manifest 경로를 준다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl', 'lease_token'], properties: {
      crawl: { type: 'string' }, url: { type: 'string' }, url_id: { type: 'string' },
      lease_token: { type: 'string' }, kind: { type: 'string', enum: ['listing', 'detail', 'sitemap', 'unknown'] },
      max_tier: { type: 'string', enum: ['curl', 'jina', 'headless', 'chrome'] } } } },
  { name: 'discover', description: 'robots·사이트맵·내부 링크로 주소를 찾는다. 스스로 네트워크를 건드리지 않고 임대와 pace 를 거친 fetch 를 쓴다. 사이트맵은 사이트가 선언한 목록일 뿐 전체가 아니므로 발견 경로를 나눠 기록한다. 응답에는 주소 목록이 아니라 개수와 보고서 경로만 담긴다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl', 'origin'], properties: {
      crawl: { type: 'string' }, origin: { type: 'string', description: '예: https://example.com' },
      skip_sitemaps: { type: 'boolean' },
      sitemap_seeds: { type: 'array', items: { type: 'string' }, description: '사이트맵 주소를 큐에 바로 넣는다(robots 를 못 쓰는 사이트용)' },
      refresh: { type: 'boolean', description: '끝낸 회차를 버리고 새로 훑는다. 주지 않으면 끝난 결과를 그대로 돌려주고 네트워크를 건드리지 않는다(진행 중이면 무시)' },
      worker: { type: 'string' } } } },
  { name: 'confirm_profile', description: '도메인 프로필을 사람이 확정한다(proposed → confirmed). 자동 발견은 이 상태를 덮지 못한다. 누가·왜 바꿨는지 반드시 남긴다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl', 'domain', 'who', 'reason'], properties: {
      crawl: { type: 'string' }, domain: { type: 'string' },
      who: { type: 'string', minLength: 1, description: '확정한 사람·패널' },
      reason: { type: 'string', minLength: 1, description: '왜 확정하는가' } } } },
  { name: 'override_profile', description: '사람이 선택자를 직접 지정한다(→ manual_override). 일반 규칙이 두 번 이상 실패한 소수 도메인에만 쓴다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl', 'domain', 'selectors', 'who', 'reason'], properties: {
      crawl: { type: 'string' }, domain: { type: 'string' },
      selectors: { type: 'object', additionalProperties: true, minProperties: 1 },
      who: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 } } } },
  { name: 'profile_status', description: '도메인 프로필의 현재 상태와 전이 이력(누가·언제·왜).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl', 'domain'], properties: {
      crawl: { type: 'string' }, domain: { type: 'string' } } } },
  { name: 'status', description: '진행 상황과 완료 판정. 대기·임대·막힘이 남으면 complete 가 아니라 paused_incomplete 다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl'], properties: { crawl: { type: 'string' } } } },
  { name: 'pace_reserve', description: '도메인 접속 권한을 예약한다. 확인이 아니라 예약이라 두 프로세스가 같은 틈으로 못 나간다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['domain'], properties: {
      domain: { type: 'string' }, min_interval_ms: { type: 'integer' }, jitter_ms: { type: 'integer' }, daily_cap: { type: 'integer' } } } },
  { name: 'pace_record', description: '접속 결과를 알린다. 차단 낌새가 쌓이면 그 도메인을 재운다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['domain'], properties: {
      domain: { type: 'string' }, blocked: { type: 'boolean' }, failed: { type: 'boolean' } } } },
  { name: 'pace_peek', description: '도메인 속도 장부를 들여다본다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['domain'], properties: { domain: { type: 'string' } } } },
  { name: 'lock_status', description: '크롤 잠금 상태. 주인·경과·만료·PID 생존과 판정을 보여준다.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl'], properties: { crawl: { type: 'string' } } } },
  { name: 'repair_lock', description: 'PID 는 살아 있는데 heartbeat 만 멎은 잠금을 사람이 푸는 통로. 자동 회수와 달리 명시 호출 전용.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['crawl'], properties: { crawl: { type: 'string' } } } },
  { name: 'normalize', description: 'URL 정규화 결과와 url_id 를 보여준다(진단용).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string' }, base: { type: 'string' } } } },
  { name: 'crawl_list', description: '이 프로젝트의 크롤 목록.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
];

const DISPATCH = {
  crawl_new: toolCrawlNew, add_urls: toolAddUrls, update_policy: toolUpdatePolicy,
  evidence: toolEvidence, wake_details: toolWakeDetails,
  snapshot: toolSnapshot, cycle_report: toolCycleReport,
  lease: toolLease, report: toolReport,
  fetch: toolFetch, discover: toolDiscover,
  confirm_profile: toolConfirmProfile, override_profile: toolOverrideProfile, profile_status: toolProfileStatus,
  status: toolStatus, pace_reserve: toolPaceReserve, pace_record: toolPaceRecord,
  pace_peek: toolPacePeek, lock_status: toolLockStatus, repair_lock: toolRepairLock,
  normalize: toolNormalize, crawl_list: toolList,
};

// ---- MCP stdio (JSON-RPC 2.0, newline-delimited) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

// 진행 중인 도구 호출들. stdin 이 닫혀도 이게 빌 때까지는 끝내지 않는다 —
// fetch 는 수십 초가 걸리므로 중간에 프로세스가 죽으면 응답을 잃는다.
const inFlight = new Set();

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'web-search', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const fn = DISPATCH[params?.name];
    if (!fn) return reply(id, { content: [{ type: 'text', text: `알 수 없는 도구: ${params?.name}` }], isError: true });
    const job = (async () => {
      try {
        const text = await fn(params.arguments || {});     // 동기·비동기 도구를 함께 받는다
        reply(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    })();
    inFlight.add(job);
    job.finally(() => inFlight.delete(job));
    return job;
  }
  if (id != null) return replyErr(id, -32601, `Method not found: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('parse fail:', line.slice(0, 120)); continue; }
    Promise.resolve(handle(msg)).catch((e) => log('handle error:', e.message));
  }
});
// stdin 이 닫혀도 진행 중인 호출이 끝날 때까지 기다린다.
process.stdin.on('end', async () => {
  if (inFlight.size) log(`stdin 종료 — 진행 중 ${inFlight.size}건을 기다립니다.`);
  await Promise.allSettled([...inFlight]);
  process.exit(0);
});
log(`started. projectDir=${process.env.CLAUDE_PROJECT_DIR || process.cwd()}`);
