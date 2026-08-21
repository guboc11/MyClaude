// workspace.db 스키마 — 기계 상태의 단일 원본.
//
// 계획서 3-3(저장 방식)·3-4(최소 데이터 모델).
// events.jsonl 과 state.json 을 동시에 맞추는 이중 장부를 만들지 않는다. 여기 있는 것이 전부다.
//
// 의미 판정은 이 스키마에 없다. items 의 work_state 는 기계 작업 상태 넷뿐이고,
// 에이전트의 판정은 judgments 에 따로 쌓인다 — 둘은 서로를 덮어쓰지 않는다.

// 2 — judgments 에 제약을 걸었다(#39). 옛 DB 는 그 보호를 못 받으므로 열지 않는다.
export const SCHEMA_VERSION = 2;

/** 기계 작업 상태. 의미 판정과 섞지 않는다. */
export const WORK_STATES = ['queued', 'leased', 'done', 'failed'];

/** URL 이 어디서 나왔는가. 같은 URL 이 여러 곳에서 나와도 item 은 하나다. */
export const SOURCE_KINDS = ['seed', 'search', 'sitemap', 'robots', 'internal_link', 'import'];

/** 어떤 실행이었나. collect 만 item 이 필수다. */
export const OPERATIONS = ['search', 'map', 'collect'];

export const COLLECTORS = ['http', 'browser', 'search-provider'];

export const RESULTS = ['success', 'partial', 'failed'];

export const ARTIFACT_KINDS = [
  'search_result', 'map', 'screenshot', 'text', 'dom', 'link_manifest', 'image_manifest', 'image',
];

const list = (name, values) => `CHECK (${name} IN (${values.map((v) => `'${v}'`).join(', ')}))`;

export const DDL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE items (
  item_id          INTEGER PRIMARY KEY,
  original_url     TEXT NOT NULL,
  canonical_url    TEXT NOT NULL UNIQUE,
  domain           TEXT NOT NULL,
  work_state       TEXT NOT NULL DEFAULT 'queued' ${list('work_state', WORK_STATES)},
  lease_id         TEXT,
  leased_by        TEXT,
  lease_expires_at INTEGER,
  collected_at     INTEGER,
  review_required  INTEGER NOT NULL DEFAULT 0 CHECK (review_required IN (0, 1)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  -- 임대 중이라는 말과 임대 정보가 따로 놀지 않게 DB 가 붙들어 준다.
  CHECK ((work_state = 'leased') = (lease_id IS NOT NULL)),
  CHECK ((lease_id IS NULL) OR (leased_by IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX items_by_state ON items (work_state);
CREATE INDEX items_by_lease ON items (lease_id);
CREATE INDEX items_by_domain ON items (domain);

CREATE TABLE sources (
  source_id      INTEGER PRIMARY KEY,
  item_id        INTEGER NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  source_kind    TEXT NOT NULL ${list('source_kind', SOURCE_KINDS)},
  source_value   TEXT NOT NULL,
  source_item_id INTEGER REFERENCES items(item_id) ON DELETE SET NULL,
  discovered_at  INTEGER NOT NULL,
  -- 같은 출처를 같은 값으로 두 번 적지 않는다. 다른 출처는 얼마든지 쌓인다.
  UNIQUE (item_id, source_kind, source_value)
);
CREATE INDEX sources_by_item ON sources (item_id);

CREATE TABLE attempts (
  attempt_id          TEXT PRIMARY KEY,
  item_id             INTEGER REFERENCES items(item_id) ON DELETE CASCADE,
  operation           TEXT NOT NULL ${list('operation', OPERATIONS)},
  collector           TEXT ${list('collector', COLLECTORS)},
  requested_outputs   TEXT,
  requested_url       TEXT,
  final_url           TEXT,
  http_status         INTEGER,
  result              TEXT ${list('result', RESULTS)},
  warning_codes       TEXT,
  error_stage         TEXT,
  error_code          TEXT,
  error_message_short TEXT,
  started_at          INTEGER NOT NULL,
  finished_at         INTEGER,
  -- collect 는 어느 항목에 대한 것인지가 반드시 있어야 한다. search·map 은 workspace 단위다.
  CHECK (operation <> 'collect' OR item_id IS NOT NULL)
);
CREATE INDEX attempts_by_item ON attempts (item_id);

CREATE TABLE artifacts (
  artifact_id INTEGER PRIMARY KEY,
  attempt_id  TEXT NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  kind        TEXT NOT NULL ${list('kind', ARTIFACT_KINDS)},
  path        TEXT NOT NULL UNIQUE,
  mime_type   TEXT,
  byte_size   INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX artifacts_by_attempt ON artifacts (attempt_id);

-- 에이전트의 판정. 쌓이기만 하고 덮이지 않는다 — 같은 item 에 서로 다른 판정이 둘 있으면
-- 그 둘이 다 남는 것이 맞다. 어느 쪽이 옳은지는 사람이 볼 일이지 DB 가 고를 일이 아니다.
CREATE TABLE judgments (
  judgment_id          INTEGER PRIMARY KEY,
  item_id              INTEGER NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  worker_id            TEXT NOT NULL,
  label                TEXT,
  confidence           REAL,
  evidence_artifact_ids TEXT NOT NULL DEFAULT '[]',
  note                 TEXT NOT NULL DEFAULT '',
  created_at           INTEGER NOT NULL,
  -- "판정 없음" 은 한 모양이어야 한다. 빈 문자열과 NULL 이 같은 뜻으로 쓰이면 세는 사람마다 답이 달라진다.
  CHECK (label IS NULL OR trim(label) <> ''),
  CHECK (trim(worker_id) <> ''),
  -- 판정이 없는데 확신도만 있는 줄은 뜻이 없다.
  CHECK (label IS NOT NULL OR confidence IS NULL),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  -- 라벨 없이 반납하려면 왜인지는 적어야 한다. 그래야 "보고 나서 못 정했다" 와 "아무도 안 봤다" 가 갈린다.
  CHECK (label IS NOT NULL OR trim(note) <> ''),
  CHECK (json_valid(evidence_artifact_ids) AND json_type(evidence_artifact_ids) = 'array')
);
CREATE INDEX judgments_by_item ON judgments (item_id);

-- report 를 두 번 보내도 한 번만 반영되게 하는 열쇠. 같은 report_key 는 두 번 들어가지 않는다.
CREATE TABLE reports (
  report_key   TEXT PRIMARY KEY,
  lease_id     TEXT NOT NULL,
  worker_id    TEXT NOT NULL,
  accepted     INTEGER NOT NULL,
  rejected     INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

-- 다시 대기로 돌린 이력. 증거는 지우지 않으므로, 어느 시점에 왜 되돌렸는지는 여기에만 남는다.
CREATE TABLE retries (
  retry_id    INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
  from_state  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX retries_by_item ON retries (item_id);
`;

/** 새 DB 에 넣는 meta 기본값. */
export function initialMeta({ workspaceId, projectRoot, briefPath, nowMs }) {
  return [
    ['schema_version', String(SCHEMA_VERSION)],
    ['workspace_id', workspaceId],
    ['project_root', projectRoot],
    ['brief_path', briefPath],
    ['created_at', String(nowMs)],
  ];
}
