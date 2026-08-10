# manage-env MCP MANUAL

> ★ 전 도구 공통 불변 원칙: **응답에 값을 싣지 않는다 — 이름·경로·명령문만.** ★
> 이 원칙이 무너지는 순간이 유일한 위험 지점이다 (MCP 응답은 Claude 대화 맥락에 들어간다).

## 무엇인가

dibang 레포의 환경변수를 "값은 한 곳에만, 나머지는 생성물"로 관리하는 도구.
설계 문서: `.claude/plans/2026-07-30-manage-env-mcp/PLAN.md`

- 값의 단일 원천: `.claude/env/{localhost,dev,prod}.env` (gitignore, 사람이 에디터로만 편집)
- 생성물: `apps/{api,dibang-wedding,guest-web}/.env.{환경}` + `.claude/env/docs/`(사람용 안내 문서)
- 키 명세: 각 앱 `.env.example` (매핑 파일을 따로 만들지 않는다)
- 사람용 정보: `.claude/env/guide.yaml` (설명·민감도·얻는 곳·스샷·주의 — 값 없음, 커밋)
- 값 파일 표기: `KEY=값`(공유) / `KEY@앱=값`(그 앱에만)

## 도구 5개

| 도구 | 하는 일 | 응답에 담기는 것 |
|---|---|---|
| `env_list` | 환경·앱별 키 목록 + 채워짐/비어있음 | 키 이름·상태만 |
| `env_info` | 키 하나의 전부 (설명·민감도·얻는 곳·스키마 소속·선언·값 유무·갱신일·사용처) | 메타데이터만 |
| `env_sync` | 값 파일 → 앱별 `.env` 분배 + docs 재생성 (sync.mjs·docs.mjs 감싸기) | 파일 이름·개수만 |
| `env_check` | 스키마·example·값 파일·render.yaml·guide.yaml 대조 (check.mjs 감싸기) | 어긋난 키 이름만 |
| `env_reveal` | 값을 보여주는 셸 명령문 출력 — **사용자가 외부 터미널에서 실행** | 명령문만 |

## Claude 행동 수칙

- 시크릿 값을 채우라는 요청을 받으면 **거절**하고: 값 파일을 에디터로 직접 편집하도록 안내한다
  (값을 넣는 도구는 설계상 없다). 사용자가 대화에 값을 붙여넣으면 그 키는 오염 — 교체를 권한다.
- `.env` 값 파일을 Read·cat 으로 직접 열지 않는다 — 상태 확인은 `env_list`, 확인 명령은 `env_reveal`.
- 값 변경 뒤에는 `env_check` 로 정합을 확인한다.
- 공개값(render.yaml `value:`)을 바꿀 때는 값 파일과 render.yaml 을 **둘 다** 갱신해야 한다
  (`env_sync` 는 render.yaml 을 고치지 않는다 — 어긋나면 `env_check` F항이 잡는다).

## 실행·등록

- 서버: `node ~/.claude/tools/manage-env/server.mjs` (stdio, cwd = 레포 루트여야 함)
- 등록(user 스코프): `claude mcp add manage-env -s user -- node ~/.claude/tools/manage-env/server.mjs`
- CLI 단독 실행도 가능: `sync.mjs [환경|all]` / `check.mjs` / `docs.mjs` (레포 루트에서)
- 홈 원본 `~/.claude/tools/manage-env/`, 레포 사본 `.claude/tools/manage-env/` (커밋 대상)

## 파일 구성

- `lib.mjs` — 파서·상수의 단일 원천 (sync·check·docs·server 가 공유. 로직 중복 금지)
- `sync.mjs` — 분배 생성기 (예: `node sync.mjs dev`)
- `check.mjs` — 4원천 대조 순수 검증기 (아무 파일도 쓰지 않음)
- `docs.mjs` — `.claude/env/docs/` 안내 문서 생성기
- `server.mjs` — MCP 본체 (위 셋을 감싼다)
