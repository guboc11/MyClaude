// 공개 10개 버튼의 입력·반환 스키마.
//
// 계약 원본은 tests/contracts/fixtures/public-tools.json 이고, 이 파일이 그 계약의 구현이다.
// 계약 시험이 둘을 정확히 대조하므로 한쪽만 고치면 바로 걸린다.
//
// 스키마는 열 개 모두 여기 있지만 실제로 부를 수 있는 것은 handler 가 붙은 것뿐이다.
// 아직 구현되지 않은 버튼은 tools/list 에 나오지 않는다 — 있는 척하지 않기 위해서다.

const str = { type: 'string' };
const int = { type: 'integer' };
const strArray = { type: 'array', items: { type: 'string' } };

const obj = (properties, required, extra = {}) => ({
  type: 'object', properties, required, additionalProperties: false, ...extra,
});
const out = (fields, types = {}) => ({
  type: 'object',
  properties: Object.fromEntries(fields.map((f) => [f, types[f] ?? str])),
  required: [...fields],
  additionalProperties: false,
});

export const SOURCE_KINDS = ['seed', 'search', 'sitemap', 'robots', 'internal_link', 'import'];
export const COLLECT_OUTPUTS = ['screenshot', 'text', 'dom', 'links', 'images'];
export const COLLECT_MODES = ['http', 'browser'];
export const EXPORT_FORMATS = ['jsonl', 'csv'];

export const TOOL_SCHEMAS = {
  workspace_new: {
    description: '새 조사 workspace 를 만든다. 같은 이름이 있으면 덮어쓰지 않고 거절한다.',
    inputSchema: obj({ topic: str, brief: str }, ['topic', 'brief']),
    outputSchema: out(['workspace_id', 'workspace_path', 'brief_path']),
  },

  add_urls: {
    description: 'URL 을 공용 명부에 넣는다. 중복이어도 새 발견 출처는 남긴다. 방문하지 않는다.',
    inputSchema: obj(
      { workspace: str, source_kind: { type: 'string', enum: SOURCE_KINDS }, source_value: str, urls: strArray, file: str },
      ['workspace', 'source_kind', 'source_value'],
      { anyOf: [{ required: ['urls'] }, { required: ['file'] }] },
    ),
    outputSchema: out(['received', 'added', 'duplicates', 'rejected', 'reject_reasons'],
      { received: int, added: int, duplicates: int, rejected: int, reject_reasons: { type: 'array', items: { type: 'object' } } }),
  },

  search: {
    description: '받은 검색어만 실행한다. 검색어를 새로 만들지 않는다.',
    inputSchema: obj({ workspace: str, queries: strArray, locale: str, max_results_per_query: int }, ['workspace', 'queries']),
    outputSchema: out(['queries_succeeded', 'queries_failed', 'new_urls', 'duplicates', 'result_path'],
      { queries_succeeded: int, queries_failed: int, new_urls: int, duplicates: int }),
  },

  map_domain: {
    description: 'robots·sitemap·대표 페이지로 확인한 범위만 지도로 만든다. 발견한 곳을 자동 방문하지 않는다.',
    inputSchema: obj({ workspace: str, domain: str, url: str }, ['workspace'],
      { anyOf: [{ required: ['domain'] }, { required: ['url'] }] }),
    outputSchema: out(['sources', 'discovered', 'new_urls', 'map_path', 'limits', 'needs_review'],
      { sources: { type: 'array', items: { type: 'object' } }, discovered: int, new_urls: int,
        limits: { type: 'object' }, needs_review: { type: 'array', items: { type: 'string' } } }),
  },

  next: {
    description: '대기 중인 항목을 한 워커에게 겹치지 않게 빌려준다.',
    inputSchema: obj({
      workspace: str, worker_id: str,
      count: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
      lease_minutes: { type: 'integer', default: 60, minimum: 1 },
    }, ['workspace', 'worker_id']),
    outputSchema: out(['lease_id', 'expires_at', 'work_file', 'leased'], { expires_at: int, leased: int }),
  },

  collect: {
    description: '유효한 임대 항목에서 요청한 산출물만 수집한다. 수집 방식을 자동으로 바꾸지 않는다.'
      + ' mode=http 는 검사한 IP 로 연결을 고정한다. mode=browser 는 요청마다 목적지를 검사하고'
      + ' 속도 예약은 페이지 이동 한 번마다 걸지만(딸린 자원은 그 한 장의 일부로 본다)'
      + ' 연결 대상 IP 고정은 없고, 그 사실이 결과마다 browser_no_pinned_connection 경고로 남는다.',
    inputSchema: obj({
      workspace: str, lease_id: str,
      outputs: { type: 'array', items: { type: 'string', enum: COLLECT_OUTPUTS } },
      mode: { type: 'string', enum: COLLECT_MODES },
    }, ['workspace', 'lease_id', 'outputs', 'mode'], {
      // mode=http 이면 screenshot 을 요청할 수 없다. 접속하기 전에 입력 오류로 거절한다.
      allOf: [{
        if: { properties: { mode: { const: 'http' } }, required: ['mode'] },
        then: { properties: { outputs: { items: { enum: ['text', 'dom', 'links', 'images'] } } } },
      }],
    }),
    outputSchema: out(['succeeded', 'partial', 'failed', 'warnings', 'index_path', 'awaiting_report'],
      { succeeded: int, partial: int, failed: int, warnings: { type: 'object' }, awaiting_report: int }),
  },

  report: {
    description: '에이전트 판정과 작업 종료를 반납한다. label 을 해석해 다음 작업을 만들지 않는다.',
    inputSchema: obj({
      workspace: str, lease_id: str, worker_id: str, file: str,
      judgments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            item_id: str,
            label: { type: ['null', 'string'] },
            confidence: { type: ['null', 'number'] },
            evidence_artifact_ids: strArray,
            note: str,
          },
          required: ['item_id', 'label', 'confidence', 'evidence_artifact_ids', 'note'],
          additionalProperties: false,
        },
      },
    }, ['workspace', 'lease_id', 'worker_id'], { anyOf: [{ required: ['judgments'] }, { required: ['file'] }] }),
    outputSchema: out(['accepted', 'rejected', 'done'], { accepted: int, rejected: int, done: int }),
  },

  status: {
    description: '기계 상태와 문제를 짧게 보여준다. 조사 완료 여부는 말하지 않는다.',
    inputSchema: obj({ workspace: str }, ['workspace']),
    outputSchema: out([
      'total', 'queued', 'leased', 'done', 'failed',
      'awaiting_report', 'review_required', 'expired_leases',
      'top_errors', 'artifact_counts', 'last_export', 'workspace_drained',
    ], {
      total: int, queued: int, leased: int, done: int, failed: int,
      awaiting_report: int, review_required: int, expired_leases: int,
      top_errors: { type: 'array', items: { type: 'object' } },
      artifact_counts: { type: 'object' },
      last_export: { type: ['null', 'string'] },
      workspace_drained: { type: 'boolean' },
    }),
  },

  retry: {
    description: '고른 항목만 이전 증거를 보존한 채 다시 대기로 돌린다.',
    inputSchema: obj({ workspace: str, item_ids: strArray, reason: str }, ['workspace', 'item_ids', 'reason']),
    outputSchema: out(['requeued', 'rejected'], { requeued: int, rejected: int }),
  },

  export: {
    description: '다음 역할이 읽을 작은 결과 파일을 만든다. 원본을 복사하지 않는다.',
    inputSchema: obj({
      workspace: str, format: { type: 'string', enum: EXPORT_FORMATS }, fields: strArray,
      filter_state: str, filter_label: str, filter_domain: str, filter_source: str, filter_warning: str,
    }, ['workspace', 'format']),
    outputSchema: out(['rows', 'path', 'filter_summary'], { rows: int, filter_summary: { type: 'object' } }),
  },
};

export const PUBLIC_TOOL_NAMES = Object.keys(TOOL_SCHEMAS);
