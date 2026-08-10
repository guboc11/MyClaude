# md-convert MANUAL — md 원본 → 인쇄용 pdf

> **원본은 항상 md다.** pdf는 파생 산출물 — `.claude/md-convert/{날짜}-{주제}/`에 쌓이고 git 추적 제외다.
> 산출 루트는 도구 이름을 따른다 — 형식별 폴더(.claude/pdf 등)는 형식이 늘 때마다 폴더가 늘어나 금지. 형식은 확장자가 말한다.
> 설계 경위: `_PLAN/2026-08-01-md-convert-mcp/PLAN.md`

## 언제 쓰나

조사·계획·명부 등 마크다운 산출물을 인쇄·공유용 pdf로 뽑을 때. 손 변환 금지 — 이 도구가 양식(A4·한글 폰트·표 스타일)을 보장한다.

## MCP 도구 (등록: 프로젝트 .mcp.json, 서버 이름 `md-convert`)

- `convert_pdf { files: [경로...], topic: "주제", landscape?: false }`
  - `files` — md 파일 경로 목록 (레포 루트 기준 상대 또는 절대)
  - `topic` — 산출 폴더의 주제부. `.claude/md-convert/{오늘}-{topic}/`이 자동 생성된다 (kebab-case 권장)
  - `landscape` — A4 가로 방향. **칼럼 많은 표 문서는 켤 것** (예: 전수 명부 표)
- 반환: 생성 폴더·pdf 경로·크기 목록. 실패는 원인 한 줄(파일 없음 / Chrome 부재 / 인쇄 실패 / 의존성 없음).

## 스크립트 직접 실행 (같은 본체)

```bash
node .claude/tools/md-convert/convert.mjs 문서.md --topic 주제 [--landscape] [--out 폴더]
```

`--out`을 주면 topic 기본 경로 대신 그 폴더에 쓴다.

## 의존성 설치 (처음 만난 세션·새 기계의 자가 복구)

marked가 없으면 도구가 아래 한 줄을 안내하고 멈춘다 — 그대로 실행하면 된다 (자동 설치는 하지 않는다):

```bash
npm install --prefix .claude/tools/md-convert
```

Chrome이 표준 경로에 없으면 환경변수 `MD_CONVERT_CHROME`로 실행 파일 경로를 지정한다.

## 양식(style.css) 고치는 법

- `style.css` 한 장이 인쇄 양식의 전부다: A4 여백·한글 폰트 스택·표(헤더 음영·줄무늬·페이지 헤더 반복)·코드·인용.
- A4 기준은 `_CRAFT/PRINT_CONVENTIONS.md` §1을 따르되, 여백 0은 전면 SVG 다이어그램용이라 글 문서인 여기는 본문 여백(14mm/15mm)을 둔다.
- 표의 행 단위 잘림 방지(`tr { page-break-inside: avoid }`)만 걸려 있다 — 긴 표가 여러 페이지에 걸치는 건 정상.
- landscape 전환은 convert.mjs가 `@page { size: A4 landscape; }`를 덧붙이는 방식 — style.css에 방향을 하드코딩하지 말 것.

## 구조 (manage-env 선례와 동일)

| 파일 | 역할 |
|---|---|
| `convert.mjs` | 변환 본체 (CLI + `convertFiles` export) — 사람과 MCP가 같은 본체를 쓴다 |
| `server.mjs` | MCP 껍데기 — convertFiles 재사용, stdio JSON-RPC |
| `style.css` | 인쇄 양식 단일 원천 |
| `package.json` | 의존성 격리 (marked) — 레포 앱 의존성과 무관 |

- 날짜는 로컬(KST) 기준 — `toISOString` 금지 (UTC라 자정~09시에 어제 날짜, task MCP 실사고).
- 이식성: 절대경로·레포 고유값 하드코딩 없음 (레포 루트는 `CLAUDE_PROJECT_DIR` 또는 cwd). 추후 홈(~/.claude) 승격 전제.
- v1은 pdf만. 다음 형식(html 등)은 `convert_html` 같은 별도 도구로 추가한다.
