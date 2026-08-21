# document-template — 매뉴얼

## 이름과 자리

- MCP 등록 이름: `document-template`
- 서버: `.claude/tools/document-template/server.mjs`
- 공통 함수: `.claude/tools/document-template/lib.mjs`
- 형식 스크립트: `.claude/tools/document-template/shapes/{shape}.mjs`
- 형식 장부: `.claude/mcp-document-template/shapes.json`
- 폴더별 정의: `.claude/mcp-document-template/{관리 대상 경로}/`

정의 이름은 관리 대상의 레포 상대경로와 같다. 예를 들어 `_AUDIT` 정의는
`.claude/mcp-document-template/_AUDIT/`, `.claude/plans` 정의는
`.claude/mcp-document-template/.claude/plans/`에 둔다.

## 공개 도구

| 도구 | 하는 일 | shape 함수 |
|---|---|---|
| `shape_new` | `SHAPE_CONTRACT`에서 새 shape 뼈대를 생성 | 없음 |
| `shape_register` | 구현을 검사하고 shape 장부에 등재 | 없음 |
| `template_register` | 정의 README를 반영하고 폴더·INDEX 뼈대를 마련 | 없음 |
| `template_add` | 항목을 만들고 INDEX에 등재 | `nameItem` → `create` → `scan` |
| `template_pack` | 오래된 항목을 정리하고 INDEX 경로를 갱신 | `tidy` |
| `template_list` | 정의 현황과 shape 장부·파일의 어긋남을 표시 | `scan` |
| `readme_set` | README 조항을 정의본과 대상에 함께 추가·교체 | 없음 |
| `readme_remove` | README 조항을 정의본과 대상에서 함께 제거 | 없음 |

## 정의

각 정의에는 `README.md`, `config.json`, 선택 사항인 `stubs/`가 있다.
`config.json`의 공통 필수값은 `shape`와 `index.file`·`index.section`·`index.row`다.
`item_pattern`, `tags`, `entry`, `tidy`는 shape가 요구하거나 지원할 때 둔다.
폐기된 `folder`, `insert` 키는 사용할 수 없다.

## shape 계약

```js
export const shape = {
  name: 'dated-folder',
  requires: ['item_pattern'],
  optional: ['tags', 'entry', 'tidy'],
};

export function nameItem(ctx, input)      // → { item }
export function validateName(ctx, name)   // → { ok, reason? }
export function create(ctx, input)        // → { item, dir, entry, made }
export function scan(ctx)                 // → Item[]
export function tidy(ctx)                 // → { moved }
```

서버는 `shape.name`이 파일 이름과 같은지, `requires`가 config에 모두 있는지,
내놓은 함수가 실제 함수인지 검사한다. 실패는 사람이 읽을 한 문장의 `Error`로 던진다.
`validateName`의 `{ ok: false, reason }`만 이름 판정 결과이므로 예외다.

`shapes.json`은 다음처럼 등재된 shape 이름과 KST 등록일을 보관한다.

```json
{
  "shapes": [
    { "name": "dated-folder", "registered_at": "2026-08-16" }
  ]
}
```

`shape_register`는 `requires`·`optional`이 문자열 배열인지까지 검사한다. 정의별 실제
config가 `requires`를 채웠는지는 shape를 불러오는 `importShape`가 계속 검사한다.
장부에 없는 shape를 정의에서 부르면
`등록되지 않은 형식입니다: {name} — shape_register({name}) 먼저.`로 거부한다.
`template_list`는 장부에만 있는 shape와 파일에만 있는 shape를 각각 표시한다.

함수를 내놓지 않으면 그 동작을 지원하지 않는 shape다. `create`가 없으면
`template_add`, `tidy`가 없으면 `template_pack`, `scan`이 없으면 `template_list`가
`이 폴더에는 없는 동작입니다`로 거부한다. `readme_*`와 `template_register`는 shape와 무관하다.

새 shape 뼈대는 서버의 `SHAPE_CONTRACT`에서 만든다. 별도 양식 사본은 없다.

새 shape는 `shape_new` → 함수 구현 채우기 → `shape_register` → 정의 `config.json` 작성 →
`template_register` 순서로 붙인다.

```sh
node .claude/tools/document-template/scaffold-shape.mjs \
  --name month-note \
  --depth '{month}/{item}.md' \
  --item-pattern '{date}-{title}.md'
```

기존 shape 파일은 덮어쓰지 않는다. 생성된 함수의 TODO를 채우고 지원하지 않는 함수 export는 지운다.

## 호출

```sh
node .claude/tools/mcp-call.mjs document-template --tools
node .claude/tools/mcp-call.mjs document-template shape_new '{"name":"month-note","depth":"{month}/{item}.md","item_pattern":"{date}-{title}.md"}'
node .claude/tools/mcp-call.mjs document-template shape_register '{"name":"month-note"}'
node .claude/tools/mcp-call.mjs document-template template_list '{}'
node .claude/tools/mcp-call.mjs document-template template_add '{"name":"_AUDIT","title":"storage-recheck","tag":"SWEEP","summary":"저장소 재점검"}'
```

파일 생성·이동 도구는 호출 결과와 `git status`를 확인한다. 단, 상위 폴더 전체가 미추적이면
기존 파일의 비변경 여부는 `git status`가 아니라 작업 전후 SHA-256 비교로 확인한다.
