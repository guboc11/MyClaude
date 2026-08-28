# mcp-call — 매뉴얼

## 이름

**mcp-call** — 등록 없는 환경(MCP 미지원 하네스)용 stdio MCP 호출기

## 형식

```
node .claude/tools/mcp-call.mjs <서버> --tools
node .claude/tools/mcp-call.mjs <서버> <도구> ['JSON' | @파일]
```

## 설명

윈도우 클로드 데스크탑처럼 레포 `.mcp.json`을 읽지 못하는 환경에서, **레포 클론만으로**
자작 MCP 도구(document-template·task·server·notepad·reminder·docs·prototype)를 쓰게 해주는
호출기다. 서버 목록은 `.mcp.json`의 stdio 등록을 그대로 따르고(이중 장부 없음), 커넥터
등록이 필요 없으며, 도구가 업데이트되면 git pull이 전부다. 설계: `_ARCHIVED/_PLAN/2026-07-31-mcp-call/PLAN.md`.

셸을 경유하지 않아 PowerShell·cmd·bash 어디서든 같은 명령으로 동작한다.
전제는 node 하나(묶기 도구는 git도 사용).

## 윈도우에서 쓰는 법 (기본 권장)

JSON을 명령줄에 직접 쓰면 셸 따옴표 때문에 잘 깨진다. **인자를 파일에 쓰고 `@파일`로 넘겨라**:

```powershell
# 1) 인자 파일을 만든다 (에이전트라면 파일 쓰기 도구로)
'{"name":"_AUDIT","title":"storage-recheck","tag":"SWEEP"}' | Set-Content -Encoding utf8 args.json

# 2) 파일로 호출한다
node .claude\tools\mcp-call.mjs document-template template_add @args.json
```

인자가 없는 도구는 그냥 부른다: `node .claude\tools\mcp-call.mjs document-template template_list`

## 도구별 사용법은 각 MANUAL로

이 문서는 호출기만 다룬다. 무엇을 호출할지는 `--tools`로 훑고,
자세한 규칙은 `.claude/tools/{도구명}/MANUAL.md`를 읽는다 (예: document-template은
`.claude/tools/document-template/MANUAL.md`).

## 종료 코드

| 코드 | 뜻 |
|---|---|
| 0 | 성공 — 응답 본문이 stdout에 출력됨 |
| 1 | 도구 거부·서버 에러 (거부 사유가 본문으로 출력됨 — 예: "미묶음 0건") |
| 2 | 인자·해석 오류 (깨진 JSON, 없는 서버, http 서버 지정 등) |
| 3 | 무응답 — 30초 안에 응답 없어 프로세스 정리 |

## 권한에 대하여 (알고 쓸 것)

이 호출기는 하네스의 도구별 권한 관리를 우회한다 — **셸에서 node 실행이 허용되는 순간,
등록된 도구 전부가 열리는 셈이다.** 정식 MCP 연결이 되는 환경(맥 CLI 등)에서는 정식 연결을
쓰는 것이 기본이고, 이 호출기는 그게 안 되는 환경의 호환층이다. 파일을 만들거나 옮기는
도구(template_add·template_pack·clause 계열 등)는 호출 뒤 결과를 눈으로 확인하고 쓴다.

## 개발 루프 용례 (이 레포에서)

서버 코드를 고치는 중에는 정식 연결이 옛 코드를 물고 있어 재연결(/mcp)이 필요한데,
mcp-call은 호출마다 새 프로세스를 띄우므로 **항상 방금 저장한 코드가 실행된다**.
등록 전 서버도 경로로 바로 호출할 수 있다:

```
node .claude/tools/mcp-call.mjs .claude/tools/새도구-mcp/server.mjs --tools
```

## 문제 해결

| 증상 | 원인·대처 |
|---|---|
| `등록에 없는 서버: ...` + stdio 목록 | 이름 오타 — 동봉된 목록에서 확인 |
| `"..."은(는) http 방식이라 ...` | http 서버는 대상 아님 — 정식 연결로만 |
| `인자 JSON 파싱 실패: ...` | JSON 문법 확인. 셸 따옴표가 의심되면 `@파일`로 전환 |
| `인자 파일 없음: ...` | `@` 뒤 경로 확인 — 현재 위치와 레포 루트 순으로 찾는다 |
| `무응답(30초): ...` | 서버가 뜨다 죽었거나 프로토콜 응답이 없음 — 해당 server.mjs를 `node --check`로 |
| `서버 실행 실패: ... ENOENT` | node가 PATH에 없거나 경로 오타 |
| 본문 앞에 `[xxx-mcp] started...` 로그 | 정상 — 서버의 stderr 로그가 통과된 것 (본문은 stdout) |

## 파일

| 경로 | 역할 |
|---|---|
| `.claude/tools/mcp-call.mjs` | 호출기 본체 (무의존 node 단일 파일) |
| `.claude/tools/mcp-call.MANUAL.md` | 이 문서 |
