# prototype-mcp MANUAL

프로토타입 생명주기 도구 14종 — 생성(proto_new) · 설계서(proto_spec_write/confirm/show) · 스토리보드(proto_board / proto_frame + frame_edit/move/remove) · 서버(proto_up/down) · 현황(proto_status) · 구현(proto_build) · 마무리(proto_done).
관할 공간: `_PROTOTYPES/`(판정 기록) + `apps/playground/src/prototypes/`(실행 코드) — 같은 이름의 짝.
규칙 원천은 `_PROTOTYPES/README.md`(헌장) — proto_new가 실시간 파싱해 응답에 동봉한다. 이 서버에 규칙 사본은 없다.

## 프레임워크 (이 도구의 사용 모델 — 처음 쓰는 에이전트는 여기부터)

- **시안 1개 = 질문 1개 = 폼팩터 1개.** 폼팩터는 이름의 태그(MOBILE·TABLET·DESKTOP·RESPONSIVE)로 선언 — 모바일 질문과 데스크톱 질문은 다른 시안이다.
- **답은 계단으로**: ①설계서 기록(proto_spec_write — 기록마다 인간에게 보여주고 합의 반복) → ②스토리보드(정지화면 레이아웃 판정 — 스테이트 없음) → ③인간 티키타카(스크린샷→판정, 수정은 설계서에 역반영) → ④proto_build로 본편(태스크 기반, **데이터만 가짜·동작은 진짜**) → ⑤판정·결말 기록. 시안은 쌓인다.
- **게이트**: 설계서 없으면 스토리보드가 안 열리고, 설계서·판정 없으면 구현 버튼이 안 눌린다.
- **역할 분담**: 정형 작업은 MCP 버튼, 내용물은 에이전트, 판정은 인간.
- **인간의 요청이 두루뭉술하면**("프로토타입 하나 말아줘") 시작 전에 확인한다: ①확인하려는 질문 ②폼팩터 ③볼 페이지·상태들.

## 형식

- 무의존성 Node stdio JSON-RPC 서버 (task-mcp·onboarding-mcp와 같은 골격). 외부 패키지 0.
- **레포 내장**: `.claude/tools/prototype-mcp/server.mjs` + `.mcp.json` 등록 — 클론하면 팀원 클로드에 자동 연결.
  (홈 디렉토리 이중화 없음 — 온보딩·task 등 user 등록 도구들과 다른 점.)
- 읽기: 헌장·CLAUDE.md·시안 폴더 실시간 (캐시 없음). 쓰기: proto_new의 신규 생성 + INDEX 한 줄 추가 + 장부뿐.
- **삭제 기능 없음** — 헌장 2-3(끝난 시안도 쌓인다, 처분은 사용자 판단)을 도구 수준에서 강제.

## 포트 규칙

| 체크아웃 | 번호 | 포트 |
|---|---|---|
| 메인 | N0 (고정) | 6100 |
| 워크트리 | N1+ (첫 proto_up 때 빈 번호 최소값 할당, 영구 기록) | 6100 + N×10 |

- **6000 자체는 금지** — Chrome이 X11 예약 포트로 차단(ERR_UNSAFE_PORT, 2026-07-24 실측).
- server-mcp와 대역 분리 확정 — server-mcp는 세트 0~7=5200~5699, 8~17=7000~7999로 **6000번대를 건너뛰도록 코드 강제**(2026-07-24). 경계의 단일 원천은 server-mcp DESIGN.md 충돌 분석 절.

## 장부

`{메인 체크아웃}/.claude/proto-servers/ledger.json` — 전 체크아웃이 공유(워크트리는 `git rev-parse --git-common-dir`로 메인을 찾음). git 제외.

```json
{
  "checkouts": { "<체크아웃 절대경로>": 1 },
  "servers": {
    "0": { "port": 6100, "pid": 123, "checkout": "...", "startedAt": "...",
           "urls": { "local": "http://localhost:6100", "network": "http://192.168.x.x:6100" } }
  }
}
```

- `servers` = 상태 현황(끄면 줄이 빠짐) / `checkouts` = 워크트리 번호 배정 영구 기록 / `logs/` = 이력 누적(append, 안 지워짐).
- vite는 `--host`로 기동 — `urls.network`(LAN IP)로 같은 와이파이의 폰에서도 시안 확인 가능.

vite 로그: 같은 폴더 `logs/n{N}-{port}.log`.

## 도구

### proto_new — [1단계] 시안 시작 (반드시 이걸로 시작, 수동 생성 금지)

| 인자 | 필수 | 설명 |
|---|---|---|
| `name` | ✓ | kebab-case (영소문자·숫자·하이픈, 영문 시작). 날짜·태그 접두는 자동 |
| `form` | ✓ | 폼팩터 태그 MOBILE\|TABLET\|DESKTOP\|RESPONSIVE — 인간 요청에 없으면 **묻는다** |
| `goal` | | 확인 목표 한 줄 — SUMMARY·INDEX에 선기입 (인간과 합의 권장) |

생성: `_PROTOTYPES/{오늘}-{form}-{name}/SUMMARY.md`(폼팩터·확인 목표·판정·결말 템플릿) + `apps/playground/src/prototypes/{같은 이름}/index.tsx`(토큰·폰트 골격) + INDEX.md 등재.
반환: **프레임워크 블록** + 생성 경로 + 규칙 주입 — 컨벤션 4문서 필독 / 금지사항 / 헌장 definition·2장 전문 / CLAUDE.md 디자인 시스템 발췌.
거부: form 누락(→ 인간에게 물으라는 안내), 태그·이름 형식 위반, 같은 이름 폴더 존재(기존 파일 불가침).

### proto_up — 이 체크아웃의 playground 기동 (인자 없음)

detached vite 프로세스 + 로그 파일 + 장부 기록. 반환: URL·N·pid·로그 경로.
이미 떠 있으면 주소만 재안내(멱등). up/down은 내부 직렬화 — 동시 호출해도 경쟁하지 않는다.
거부: 내 포트가 장부 밖 프로세스에 점유(`lsof -nP -i :{port}` 안내), 다른 체크아웃이 내 번호 점유, vite 미설치.

### proto_down — 이 체크아웃의 서버 종료 (인자 없음)

SIGTERM → 0.5초 → SIGKILL(그룹). 장부 정리. **다른 체크아웃의 서버는 절대 건드리지 않는다.**

### proto_status — 현황 (인자 없음)

시안 목록(날짜 접두 폴더): `결말 기록됨` / `판정만 기록` / `판정 대기` / `SUMMARY 없음` + 라우트 짝 없으면 ⚠.
서버 현황: 전 체크아웃 장부 + pid 생존 검사(죽은 잔재는 해당 체크아웃에서 proto_down으로 정리 안내).

### proto_board — [2단계] 스토리보드 시작

| 인자 | 필수 | 설명 |
|---|---|---|
| `name` | ✓ | 시안 폴더명 전체 또는 이름 부분 |

**폼팩터 인자 없음** — 시안 이름의 태그가 단일 원천이라 거기서 자동 결정된다.
시안 라우트 폴더에 `storyboard.json`(매니페스트) + `frames/` 초기화, 응답에 스토리보드 절차 주입.
이미 있으면 현황 재안내(멱등). **매니페스트는 MCP만 수정한다 — 손 편집 금지.**
거부: 이름에 폼팩터 태그가 없는 옛 명명 시안.

개념 격리: 폼팩터는 시안 정체성이라 **고정** (모바일 시안을 데스크톱으로 바꿔 보는 것 아님).
그 안의 **폭 변형**만 뷰어 상단 토글(?d=)로 골라 본다. 캔버스 배율은 카테고리별 고정이라
좁게/넓게가 화면에서도 실제 폭 차이로 보인다:

| 폼팩터 | 변형 |
|---|---|
| MOBILE | 좁게 320×690 · 기본 390×844 · 넓게 430×932 |
| TABLET | 세로 768×1024 · 가로 1024×768 |
| DESKTOP | 노트북 1280×800 · FHD 1440×900 · 와이드 1920×1080 |
| RESPONSIVE | 좁은 모바일 320 · 모바일 390 · 태블릿 768 · 노트북 1280 · FHD 1440 (전 구간) |

### proto_frame — [2단계] 프레임(컷) 깔기 (정형 작업은 버튼으로)

| 인자 | 필수 | 설명 |
|---|---|---|
| `name` | ✓ | 시안 이름 |
| `page` | ✓ | **주제(시나리오) 그룹 키** (예: "초대 목록") — 캔버스가 주제별 행으로 묶어 보여준다 |
| `state` | ✓ | 상태(컷) 이름 (예: "추가 모달 열림") |
| `position` | | 삽입 위치(1-기준). 생략 = 맨 끝. 중간 삽입해도 파일명은 안 바뀐다(순서는 매니페스트 배열이 결정) |
| `links` | | 이 컷에서 갈 수 있는 컷 선언 (예: `["f2"]`) — 캔버스 캡션에 `→ f2` 표시 |

`frames/f{증가번호}.tsx` 빈 골격(토큰·폰트 연결) 생성 + 매니페스트 삽입. 에이전트는 **내용물만** 채운다.
프레임 = 고정 상태 정지화면 — 스테이트 로직 금지. 연속 호출로 주제별 컷을 쫙 깔아 놓는 용도.
확인 뷰 2개: 캔버스 `/{시안}/board`(주제별 행으로 전체 조망·클릭 시 슬라이드 진입) · 슬라이드 `/{시안}/board/play`(←/→ 이동, `?f=` 딥링크).
거부: 스토리보드 미초기화(proto_board 먼저), position 범위 밖, links 형식 위반, 없는 시안.

**컷 간 이동(콘티 화살표)**: 실제 클릭 이동은 프레임 안에서 셸 부품 `<Go>`로 —
`import { Go } from '../../../board/Go'` 후 `<Go to="f2"><Button>초대 추가</Button></Go>`.
클릭하면 슬라이드 뷰의 그 컷으로 점프한다(Figma 프로토타입 링크 개념). 화면 데이터는 여전히 하드코딩 —
허용되는 유일한 인터랙션이 이 이동이다. MCP는 JSX를 수술하지 않으므로 links(선언)와 Go(구현)는 분담 관계다.
**Go는 슬라이드 뷰에서만 동작** — 캔버스에선 클릭이 통과돼 "컷 클릭 = 그 컷 열기"가 유지된다.

**링크 구조도**: 캔버스 헤더의 [구조도] 토글 — 프레임 소스의 `<Go to>`를 파싱해(코드가 진실) 컷 연결
그래프를 그린다. 실선 = 코드의 Go 이동, 점선 = links 선언만 있고 코드에 없음(구현 누락 신호).

### proto_frame_edit / move / remove — [2단계] 컷 편집

| 도구 | 인자 | 동작 |
|---|---|---|
| `proto_frame_edit` | name, file, page?/state?/links? | 라벨·links 수정 (links `[]`=제거). 내용물 파일은 불가침 |
| `proto_frame_move` | name, file, position | 배열 내 위치 이동 — 파일명 그대로, 순서만 변경 |
| `proto_frame_remove` | name, file | 매니페스트 줄 + 프레임 파일 제거. 작업 중 콘티 편집 층위(시안 폴더 불가침과 구분). 복구는 git |

세 도구 모두 응답에 현재 순서를 동봉한다. 거부: 없는 컷, position 범위 밖.

### proto_spec_write / proto_spec_show — [1.5단계] 설계서 (프로토타입 설명)

설계서는 요약본이 아니라 **디테일 설계 문서**이고, 두 판이 같은 조항 주소로 함께 자란다:

| 파일 | 대상 | 성격 |
|---|---|---|
| `_PROTOTYPES/{시안}/SPEC.md` | 인간 | 평범판 — 읽기 좋은 설계서 |
| `_PROTOTYPES/{시안}/SPEC_DETAIL.md` | 에이전트 | 끝판왕 — 구현 시 참조하는 전량 디테일. 화면 절 4필드: 레이아웃/요소/**인터랙션(필수)**/mock 데이터 |

| 도구 | 인자 | 동작 |
|---|---|---|
| `proto_spec_write` | name, address?(생략=새 주제 자동), title(새 조항 필수), **normal**, **detail** | 두 파일의 해당 조항 추가/교체(자기 본문만 — 하위 조항 보존). **응답에 평범판 해당 주제를 동봉** → 그대로 인간에게 보여주고 "더 자세히 반영할 것 없나요?" 확인 반복. **기존 승인은 자동 무효화** |
| `proto_spec_confirm` | name, note? | **인간이 평범판을 보고 "진행"이라 답한 뒤에만** — 승인을 SPEC.md에 타임스탬프로 기록. 이 기록이 proto_board의 게이트다. 묻지 않고 누르면 거짓 기록 |
| `proto_spec_show` | name, address? | 평범판 전체/조항 서브트리 출력 |

주소 체계: 주제 `"1"` / 화면 `"1-2"` (조항 문법과 동일 — 온보딩 파서로도 조회 가능).
티키타카에서 나온 수정("2컷 카드 키워")은 설계서에도 **역반영**해 설계서가 단일 진실로 유지되게 한다 —
역반영(spec_write)하면 승인이 풀리므로 재승인까지가 한 세트다.

### proto_build — [4단계] 구현 버튼

| 인자 | 필수 | 설명 |
|---|---|---|
| `name` | ✓ | 시안 이름 |

인간이 "좋아, 구현하자"라고 승인했을 때 누른다. **게이트**: 설계서 없음/빈 설계서/SUMMARY 판정 미기록 → 각각 거부.
통과 시 주입: 품질 기준(2-5) / 태스크 기반 절차(task MCP로 화면 단위 + 인터랙션 전수 검증 + 스크린샷 보고 태스크 생성 후 구현) / 라이브러리 실황(playground·본체 package.json 실시간) / 컨벤션 4문서 / 디자인 시스템 / **설계서 끝판왕 전문**.
본편 품질 기준: **데이터만 가짜, 동작은 진짜** — 버튼은 눌리고, 입력은 입력되고, 모달은 열린다. 컷 이어붙인 껍데기는 본편이 아니다.

### proto_done — 마무리 확인

| 인자 | 필수 | 설명 |
|---|---|---|
| `name` | ✓ | 폴더명 전체 또는 이름 부분 (`-{name}` 접미 일치, 복수 일치 시 거부) |

SUMMARY의 판정·결말이 실제 기입됐는지 검사 — `(`로 시작하는 본문은 템플릿 잔재로 간주해 거부하고 빠진 절을 알려준다.
통과해도 **아무것도 지우지 않는다** — 시안은 쌓이고, 처분은 사용자 판단.
**done의 시점 = 프로토타입 구현이 마무리됐을 때다** (본체 반영 시점이 아님). 결말도 "시안이 어떻게
마무리됐나"를 적는 것 — 본체 이관은 done 이후의 별개 후속이다.

## 진단

| 증상 | 원인·조치 |
|---|---|
| `포트 …이 장부 밖 프로세스에 점유됨` | `lsof -nP -i :{port}`로 확인 — vite 잔재면 그 체크아웃에서 proto_down, 남의 것이면 두고 소유자에게 |
| `기동 실패 … 로그 끝부분` | 응답에 동봉된 vite 로그로 원인 파악 (실패 시 자식 프로세스는 자동 회수됨) |
| `vite 실행 파일 없음` | 그 체크아웃에서 `pnpm install` — `.npmrc node-linker=hoisted`라 루트 node_modules/.bin까지 탐색함 |
| `마무리 불가 — SUMMARY.md 미기입 절` | 알려준 절(판정/결말)을 채우고 다시 proto_done |
| status에 `죽음(장부 잔재)` | 그 체크아웃에서 proto_down 한 번 — 장부만 정리된다 |
| 도구가 안 보임 | `.mcp.json` 등록 확인 후 `/mcp` 재연결. 서버 코드 수정 후에도 재연결 필요 |
| 세션 시작 직후 `still connecting: prototype`이 지속 | 첫 연결이 걸린 상태 — `/mcp` → prototype → **Reconnect** 한 번이면 풀린다 (2026-07-24 실측: 재연결 즉시 도구 5종 정상) |

## 예시 (한 바퀴)

```
(인간 요청이 두루뭉술하면: "어떤 프레임으로 볼까요 — 모바일/데스크톱/반응형? 확인하려는 건 뭔가요?")
proto_new {name: "ledger-compact", form: "MOBILE", goal: "장부 간단히 보기 2안이 통하는지"}
→ (응답의 프레임워크·규칙·필독 문서 확인) → 컨벤션 4문서 읽기
proto_spec_write {name:"...", title:"장부 탭", normal:"...", detail:"..."}   → 반환된 평범판을 인간에게 보여주기
→ "더 자세히 반영할 것 없나요?" → 있으면 spec_write 반복 (화면은 address "1-2"식으로)
→ 인간 "진행" → proto_spec_confirm {name:"...", note:"..."}   → 승인 기록 (없으면 board가 안 열림)
proto_board {name: "ledger-compact"}                          → 설계서+승인 게이트 통과, 폼팩터는 태그에서 자동
proto_frame {name: "...", page: "장부", state: "간단히"}       → f1 (맨 끝)
proto_frame {name: "...", page: "장부", state: "자세히"}       → f2
proto_frame {name: "...", page: "장부", state: "로딩", position: 1}  → f3을 맨 앞에
(컷 편집: proto_frame_edit / proto_frame_move / proto_frame_remove)
→ 컷 내용 채움 → proto_up → /board·/board/play 스크린샷 보고 → 인간 판정 → 수정은 설계서에도 역반영
→ SUMMARY에 판정 기입 → 인간 "구현하자" 승인
proto_build {name: "ledger-compact"}   → 품질 기준·설계서·라이브러리 실황 주입 → task MCP 태스크 생성 → 태스크 기반 구현
proto_status        → 진행 상태 확인
(결말 나면 SUMMARY에 결말 기입)
proto_done {name: "ledger-compact"}   → 마무리 확인. 폴더는 그대로 쌓임
proto_down
```

## 파일

- 서버: `.claude/tools/prototype-mcp/server.mjs`
- 매뉴얼: `.claude/tools/prototype-mcp/MANUAL.md` (이 파일)
- 장부·로그: `{메인}/.claude/proto-servers/` (git 제외)
- 헌장: `_PROTOTYPES/README.md` — 조항 조회는 onboarding MCP (`read doc:"prototypes"`)
