# docs(MCP) — 매뉴얼

> 조회 규율 자체는 [clause-reference/GOVERNANCE.md](../../../_CRAFT_GUIDE/clause-reference/GOVERNANCE.md)의 CG-0016 — 문서·조항의 첫 조회는 docs MCP로 시작한다.

## 이름

**docs** — 레포의 Markdown 문서를 폴더·문서·절 순서로 찾고 읽는 읽기 전용 지도

## 형식

```text
map     (path?, sort?, git?, gitFrom?, gitTo?)
search  (query, scope?, 날짜?, sort?, git?, limit?, cursor?)
outline (doc)
read    (doc?, ids)
history (doc, limit?, range?, confirm?)
```

## 성격과 대상

`git ls-files`가 반환하는 추적 md와 미추적 md, `.claude` 아래에서 gitignore에 걸린 md를 대상으로
한다. 계획서·campaigns처럼 git에 없어도 작업 맥락인 문서를 지도와 검색에서 찾을 수 있다.
어느 경로든 `node_modules`는 제외한다. git이 없거나 현재 폴더가 저장소가 아니면 Node 표준 모듈로
md를 훑어 조회 기능을 유지하며, 이때는 git 이력을 붙이지 않도록 문서를 미추적으로 다룬다.

| 추적 상태 | 수집 경계 | git 정보·history |
|---|---|---|
| 추적됨 | `git ls-files` 추적 문서 | 요청하면 git 정보와 history를 반환 |
| 미추적 | `--others --exclude-standard` 문서 | `Git 추적 안 됨 (미추적)` 표시, git 정보·history 없음 |
| 무시됨 | `--others --ignored --exclude-standard` 중 `.claude/` 아래 문서만 | `Git 추적 안 됨 (무시됨)` 표시, git 정보·history 없음 |

무시된 문서 편입 범위는 `.claude/` 아래뿐이다. 다른 무시 경로는 넣지 않으며, `node_modules`는
`.claude/` 안에 있더라도 넣지 않는다.

npm 패키지와 `rg`에 의존하지 않는다. 시스템 git은 세 문서 목록과 사용자가 명시한 git 정보,
`history`에만 쓴다. 도구 API에는 쓰기 도구가 없다. 성공한 `read`의 내부 사용 기록은 기존처럼
`.claude/mcp-docs/usage.jsonl`에 남긴다.

보통은 다음 순서로 쓴다.

```text
map() → search({ query }) → outline({ doc }) → read({ doc, ids }) → history({ doc })
```

`search`가 이번 개편의 중심이다. 문서를 미리 알아야 했던 옛 방식과 달리 `doc` 없이 레포 전체에서
후보와 바로 읽을 수 있는 절 주소를 함께 찾는다.

## doc 인자 해석

`outline`, `history`와 `doc`을 지정한 `read`는 아래 순서로 해석한다. `read`에서 앵커나 헤더를
레포 전체에서 찾을 때는 `doc`을 생략한다.

| 순서 | 입력 | 해석 |
|---|---|---|
| 1 | 주제명(예: `AUDIT`) | 루트의 `_AUDIT/README.md` |
| 2 | 절대경로 | 그 파일 |
| 3 | 상대경로 | `$CLAUDE_PROJECT_DIR` 기준, 미설정 시 cwd |
| — | 폴더 경로 | 폴더 안 `README.md` |

## 도구

### map

레포 md를 폴더부터 훑는다. 폴더의 문서 수는 모든 하위 폴더를 합한 값이다. 문서가 5개 이하면
자동으로 펼치고, 초과하면 접는다. `path`로 접힌 폴더를 한 단계씩 파고든다. 현재 경로의 자식 폴더를
보여줄 때 그 아래 하위 폴더가 12개 이하면 이름과 합산 문서 수도 한 단계 더 보여주고, 12개를 넘으면
그 단계는 접는다. 파일을 펴는 5개 기준은 그대로다.

| 인자 | 설명 |
|---|---|
| `path` | 레포 상대 폴더. 생략하면 루트 |
| `sort` | `alphabetical`(기본), `modified`, `created`, `lines`, `sections`, `git` |
| `git` | 펼친 결과에 마지막 커밋일·수정 횟수 표시 |
| `gitFrom`, `gitTo` | 마지막 커밋일 범위. 지정할 때만 git 정보를 읽음 |

문서에는 제목·줄 수·절 수·파일 생성/수정일·INDEX 상태가 붙는다. 미추적·무시 문서에는
`Git 추적 안 됨 (미추적)` 또는 `Git 추적 안 됨 (무시됨)`도 붙는다.

```text
map({ path: "_CRAFT_GUIDE", sort: "sections" })
```

### search

`doc` 없이 폴더명·파일명·헤더·본문을 검색하고, 각 일치 지점에 `read`용 주소를 붙인다.

관련성 정렬의 강도는 다음 순서다.

1. 확장자를 뺀 파일명 또는 폴더명 전체의 정확 일치(대소문자 무시)
2. 폴더명 부분 일치
3. 파일명 부분 일치
4. 헤더 일치
5. 본문 일치

| 인자 | 설명 |
|---|---|
| `query` | 필수 검색어 문자열 또는 OR로 합칠 문자열 배열 |
| `scope` | 레포 상대경로 범위. 생략하면 전체 |
| `createdFrom`, `createdTo` | 파일 생성일 범위 |
| `modifiedFrom`, `modifiedTo` | 파일 수정일 범위 |
| `sort` | `relevance`(기본), `alphabetical`, `modified`, `created`, `lines`, `sections`, `git` |
| `git` | 반환 문서에 마지막 커밋일·수정 횟수 표시 |
| `gitFrom`, `gitTo` | 마지막 커밋일 범위 |
| `limit` | 문서 수. 기본 20, 최대 100 |
| `cursor` | 다음 페이지를 위한 이전 결과의 `next cursor` |

생성일·수정일·마지막 커밋일은 서로 다른 값이며 섞지 않는다. 경로에 포함된 날짜 문자열도 날짜
조건으로 해석하지 않는다. 범위를 주면 검색 잡음을 줄일 수 있다. 미추적·무시 문서는 결과에 그
상태가 표시되며, git 정보는 추적 문서에만 붙는다.

`next cursor`는 `v1.<offset>.<검색 조건 지문>` 모양의 짧은 한 줄이다. 서버가 검색 상태를 따로
저장하지 않으므로 프로세스가 다시 떠도 같은 검색 조건으로 다음 페이지를 받을 수 있다. cursor를
쓸 때는 query·scope·정렬·날짜·git 조건을 첫 호출과 같게 둔다. 옛 형식이거나 조건이 다른 cursor는
첫 페이지로 조용히 돌아가지 않고 만료 또는 조건 불일치 오류를 낸다.

```text
search({ query: "STORAGE", scope: "_CRAFT_GUIDE", limit: 5 })
→ _CRAFT_GUIDE/STORAGE.md
  [all] STORAGE.md ← 정확 일치
```

### outline

한 문서의 제목과 모든 절 주소를 보여준다. 문서 전체 줄 수뿐 아니라 절마다 줄 수가 붙으므로,
본문을 받기 전에 읽을 범위를 고를 수 있다.

```text
outline({ doc: "_CRAFT_GUIDE/TESTING.md" })
→ 6-1 ... 12줄
```

### read

선택한 절의 원문을 반환한다. 부모 위치 주소를 읽으면 그 아래 절까지 통째로 포함한다. `doc`을
지정하면 그 문서 안에서만 찾고, 생략하면 수집 대상 md 전체에서 CG 앵커나 헤더를 찾는다.

`ids` 원소는 다음 순서로 판정한다. 앞 단계와 모양이 겹치면 뒤 단계로 넘기지 않는다.

1. `all`·`definition`·`1-1` 같은 기존 위치 주소
2. `CG-0241` 모양의 CG 앵커
3. 헤더 문자열 완전일치
4. 완전일치가 없을 때 헤더 문자열 부분일치

CG 앵커와 헤더 문자열은 대소문자를 구분하지 않는다. CG 앵커는 헤더 안의 `[CG-0241]` 토큰을
찾으므로 본문에서 다른 조항을 인용한 곳은 후보가 아니다. 위치 주소는 문서마다 매겨지므로 `doc`
없이 쓸 수 없다.

| `ids` 값 | 반환 범위 |
|---|---|
| `all` | 제목을 포함한 문서 전체 |
| `definition` | 문서에 실제로 존재하는 기본 섹션 |
| `1`, `1-1` 등 | 해당 주소와 자식 절 |
| `CG-0241` 등 | 헤더에 같은 CG 앵커가 있는 절 |
| 헤더 문자열 | 완전일치, 없으면 부분일치하는 절 |
| 여러 주소 | 각 블록을 `---`로 구분 |

전역에서 일치가 하나면 본문 앞에 `출처: 경로 [주소] 헤더` 한 줄을 붙인다. `doc`을 명시한 호출은
기존처럼 본문만 반환한다. 여러 절이 맞으면 문서 경로·주소·헤더 후보만 보여주며 본문을 임의로
고르지 않는다. 주소 하나라도 없거나 복수이면 같은 요청의 유일한 절도 함께 반환하지 않는 원자적
동작이다. `doc` 안에서 복수로 맞아도 같은 규칙을 쓴다.

절 바로 뒤에 다음 절의 독립 `<a id="…"></a>` 앵커 줄이 있으면 앞 절 본문에서는 제외한다. 그
앵커가 가리키는 다음 절의 CG 조회는 그대로 동작한다. 다음 헤더가 없는 문서 끝 앵커는 임의로
제거하지 않는다.

없는 `definition`은 자동 생성하지 않는다. `doc`을 지정한 기존 위치 주소가 없으면 지금까지와
같이 없는 주소와 현재 목차를 보여준다. 전역에서 0건이면 레포 전체에서 찾지 못했다고 알린다.

```text
read({ doc: "AUDIT", ids: ["definition"] })
read({ doc: "_CRAFT_GUIDE/STORAGE.md", ids: ["5", "8"] })
read({ ids: ["CG-0241"] })
read({ ids: ["MCP"] })  # 복수이면 후보만 반환
```

등록 이름과 현재 세션의 재연결 상태에 영향받지 않고 그대로 확인하려면 레포 루트에서 다음 예시를
실행한다.

```bash
node .claude/tools/mcp-call.mjs .claude/tools/docs-mcp/server.mjs read '{"ids":["CG-0241"]}'
node .claude/tools/mcp-call.mjs .claude/tools/docs-mcp/server.mjs read '{"doc":"AUDIT","ids":["definition"]}'
node .claude/tools/mcp-call.mjs .claude/tools/docs-mcp/server.mjs read '{"ids":["MCP"]}'
node .claude/tools/mcp-call.mjs .claude/tools/docs-mcp/server.mjs search '{"query":"업로드","limit":3}'
node .claude/tools/mcp-call.mjs .claude/tools/docs-mcp/server.mjs search '{"query":"업로드","limit":3,"cursor":"v1.3.8Y1p2ojElm_AiLufwERgib3BIyrvee58BQFaesHHyAY"}'
```

### history

한 문서의 git 이력을 `--follow`로 따라간다. 이름 변경 전 이력까지 이어 붙이고 최초 커밋을 1번으로
매긴다. 기본은 최근 5건이며 `limit: "all"`로 전부 본다. 미추적·무시 문서는 빈 이력을 반환하지 않고
`Git 추적 안 됨`과 그 상태를 알려 이력이 없는 추적 문서와 구별한다.

`range: "34..35"`를 주면 첫 응답은 diff 줄 수만 알린다. 같은 요청에 `confirm: true`를 붙였을 때만
지정한 문서의 diff 본문을 반환한다.

```text
history({ doc: "CLAUDE.md" })
history({ doc: "CLAUDE.md", range: "34..35" })
history({ doc: "CLAUDE.md", range: "34..35", confirm: true })
```

`map`·`search`에 선택적으로 붙는 수정 횟수는 여러 파일을 한 번에 읽기 때문에 이름 변경 전 이력을
따라가지 못한다. 이름이 바뀐 문서는 목록에서 실제보다 적게 고쳐진 것처럼 보일 수 있다. 그 문서를
`history`로 열면 `--follow`가 이름 변경 전 이력을 복원한다.

## 주소 규칙

문서에서 처음 만나는 헤더는 급과 관계없이 제목이며 주소가 없다. 그 뒤의 모든 헤더는 헤더 깊이와
등장 순서에 따라 `1`, `1-1`, `1-2`처럼 주소를 받는다. 헤더 텍스트가 정확히 `definition`이면
예약 주소 `definition`을 함께 쓴다. 코드 블록 안의 헤더 모양 줄은 헤더가 아니다.

절의 범위는 해당 헤더부터 다음 같거나 더 얕은 헤더 직전까지다.

주소는 문서에 적힌 번호를 읽어 쓰는 것이 아니라 도구가 헤더 순서로 매기므로, 표기 번호와 다를 수
있다. 1번부터 매긴 문서는 대개 도구 주소와 일치하지만, 0번부터 매긴 문서는 표기 번호보다 주소가
하나씩 밀린다. 따라서 주소는 반드시 `outline`으로 확인한 뒤 `read`에 쓴다.

## 별칭

프로젝트별 별칭은 `.claude/tools/docs-mcp/ALIASES.md`에 아래 형식으로 둔다.

```text
- 질의어 = 문서 용어
```

서버는 `search` 호출마다 파일을 다시 읽는다. 원래 질의에 직접 맞은 결과를 먼저 놓고, 확장된 결과에는
`별칭: 질의어 → 문서 용어`를 표시한다. ALIASES 문서 자체의 직접 히트는 별칭 결과로 표시하지 않는다.
이 파일은 프로젝트별 정보이므로 사용자 스코프에 복사하지 않는다.

## INDEX 상태

루트의 각 `_층/INDEX.md` 링크와 파일 목록을 맞춰 문서에 다음 신호만 붙인다.

| 상태 | 뜻 |
|---|---|
| `INDEX 등재` | 문서 또는 그 주제 폴더가 층의 INDEX에 연결됨 |
| `INDEX 미등재` | 층에 INDEX는 있으나 문서의 주제가 연결되지 않음 |
| `INDEX 해당 없음` | 층 INDEX가 없거나 문서가 그 층의 INDEX·README임 |

이 값과 날짜·수정 횟수는 판단 재료일 뿐이다. 도구는 문서가 살아 있는지, 낡았는지 자동 판정하지 않는다.

## 사본과 파일

| 경로 | 역할 |
|---|---|
| `<repo>/.claude/tools/docs-mcp/server.mjs` | 프로젝트 원본 서버 |
| `<repo>/.claude/tools/docs-mcp/MANUAL.md` | 프로젝트 원본 매뉴얼 |
| `<repo>/.claude/tools/docs-mcp/ALIASES.md` | 프로젝트별 별칭, 사용자 사본에 복사하지 않음 |
| `<repo>/.claude/mcp-docs/usage.jsonl` | 성공한 read의 내부 사용 기록 |
| `~/.claude/tools/docs-mcp/server.mjs` | 게이트 통과 뒤 동기화하는 사용자 스코프 서버 |
| `~/.claude/tools/docs-mcp/MANUAL.md` | 게이트 통과 뒤 동기화하는 사용자 스코프 매뉴얼 |

프로젝트 사본을 먼저 검증한 뒤 서버와 매뉴얼만 사용자 스코프에 동기화한다. 서버 코드가 바뀌면
장기 실행 중인 MCP는 재연결해야 한다.

## 설치

```text
claude mcp add docs --scope user -- node ~/.claude/tools/docs-mcp/server.mjs
```
