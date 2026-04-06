---
name: diagram-canvas
description: Generate an interactive SVG diagram canvas with drag, zoom, pan, lock, aggregate drag, and Cmd+S save. Use when the user wants to visualize entities, relationships, and aggregates as a draggable diagram.
---

# diagram-canvas

엔티티·관계·Aggregate 구조를 인터랙티브 SVG 다이어그램으로 시각화하는 캔버스를 프로젝트에 생성한다.

## Trigger

- `/diagram-canvas`
- "구조도 캔버스 만들어줘", "다이어그램 만들어줘", "인터랙티브 구조도"

## Features

- 엔티티 드래그 (개별 이동)
- Aggregate 이름표 드래그 (멤버 일괄 이동)
- 더블클릭 잠금/해제 (자물쇠 아이콘)
- 스크롤 줌 (마우스 중심, 2%/step)
- 캔버스 팬 (빈 공간 드래그)
- Cmd+S 직접 저장 (server.mjs가 diagram-layout.json 덮어쓰기)
- Reset 버튼 (원래 레이아웃 복원)
- VO candidate 점선 테두리 + "VO?" 표시
- Aggregate Root "ROOT" 뱃지
- 관계선 (실선/점선, 카디널리티 라벨)
- Legend 패널

## Constraints

- 인터넷 필요: React 18 + Babel standalone을 CDN에서 로드
- Node.js 필요: server.mjs 실행용

## Workflow

### Step 1: 입력 확인

사용자가 다이어그램 데이터를 제공했는지 확인한다.

- 데이터가 있는 경우 → Step 3으로
- 데이터가 없는 경우 → Step 2로

### Step 2: 데이터 수집

사용자에게 최소 필요 정보를 질문한다:
- "어떤 엔티티들이 있나요? (이름 목록만 주셔도 됩니다)"
- "그룹(Aggregate)으로 묶이는 것들이 있나요?"
- "엔티티 간 관계가 있다면 알려주세요"

엔티티 목록만 줘도 동작해야 한다. 관계와 Aggregate는 선택적이다.

### Step 3: 대상 디렉토리 확인

사용자가 경로를 지정하지 않았으면 질문한다:
- "어디에 생성할까요? (예: ./docs/diagram)"

### Step 4: 파일 생성

4개 파일을 대상 디렉토리에 생성한다:

1. **diagram-data.json** — 사용자 데이터 기반으로 동적 생성
2. **diagram-layout.json** — 자동 레이아웃 계산 (아래 알고리즘 참고)
3. **diagram.html** — `~/.claude/skills/diagram-canvas/TEMPLATE.html`을 Read한 뒤 **그대로** Write. 절대 내용을 수정하거나 재생성하지 말 것.
4. **server.mjs** — 아래 코드블록 그대로 Write

### Step 5: 실행 안내

```
node <경로>/server.mjs
→ http://localhost:4321
포트 변경: PORT=4322 node server.mjs
```

## Updating Existing Diagrams

기존 파일이 있는 디렉토리가 지정되면:
1. diagram-data.json을 읽어 현재 상태 파악
2. 사용자 요청에 따라 data 수정
3. diagram-layout.json에서:
   - 기존 엔티티 위치는 유지
   - 새 엔티티만 빈 공간에 자동 배치
   - 삭제된 엔티티는 layout에서도 제거
4. diagram.html, server.mjs는 건드리지 않음

## Data Schema

### diagram-data.json

```json
{
  "version": 1,
  "title": "Diagram Title",
  "entities": [
    { "id": "EntityName", "label": "표시 이름", "aggregate": "AggregateId", "type": "entity" }
  ],
  "relationships": [
    { "from": "EntityA", "to": "EntityB", "label": "관계 설명", "fromCard": "1", "toCard": "*", "style": "solid" }
  ],
  "aggregates": [
    { "id": "AggregateId", "label": "Aggregate Name", "root": "RootEntityId", "members": ["EntityA", "EntityB"] }
  ]
}
```

**version**: 스키마 버전. 현재 1. 향후 스키마 변경 시 마이그레이션 경로 제공용. TEMPLATE.html은 런타임에 검증하지 않음.
**Entity type**: `"entity"` (기본) 또는 `"vo_candidate"` (점선 테두리 + VO? 표시)
**Relationship style**: `"solid"` (실선, 강한 참조) 또는 `"dashed"` (점선, 약한 참조)
**참조 무결성**: relationships의 from/to는 반드시 entities에 존재하는 id여야 한다. aggregates의 members도 마찬가지.

### diagram-layout.json

```json
{
  "canvas": { "width": 1400, "height": 900 },
  "entityDefaults": { "width": 160, "height": 70 },
  "entities": { "EntityName": { "x": 100, "y": 50 } },
  "aggregateColors": { "AggregateId": { "bg": "#DBEAFE", "border": "#3B82F6" } },
  "locked": { "EntityName": true }
}
```

`locked`는 선택적. 잠긴 엔티티가 없으면 필드 자체를 생략한다.

## Layout Algorithm

초기 레이아웃 자동 계산:

```
1. Aggregate를 members 수 내림차순으로 정렬
2. columns = ceil(sqrt(aggregate_count))
3. columnWidth = canvas.width / columns
4. 각 Aggregate를 순서대로 열에 배치:
   - Root를 열의 최상단 중앙에 배치
   - 나머지 멤버를 Root 아래 2열 그리드로 배치
   - 수평 간격: entityWidth + 20, 수직 간격: entityHeight + 40
5. 같은 column에 여러 Aggregate가 오면 이전 Aggregate 하단 + 80px에서 시작
6. canvas 크기 자동 결정: max(1400, 실제 사용 너비 + 200) x max(900, 실제 사용 높이 + 200)
```

Aggregate가 없는 엔티티는 단일 멤버 Aggregate로 취급한다.

## Color Palette

Aggregate 순서대로 순환 할당:

```json
[
  { "bg": "#DBEAFE", "border": "#3B82F6" },
  { "bg": "#FEF3C7", "border": "#F59E0B" },
  { "bg": "#D1FAE5", "border": "#10B981" },
  { "bg": "#EDE9FE", "border": "#8B5CF6" },
  { "bg": "#CFFAFE", "border": "#06B6D4" },
  { "bg": "#FEE2E2", "border": "#EF4444" },
  { "bg": "#FFF7ED", "border": "#F97316" },
  { "bg": "#F0FDF4", "border": "#22C55E" },
  { "bg": "#FCE7F3", "border": "#EC4899" },
  { "bg": "#F5F5F4", "border": "#78716C" }
]
```

10개 초과 시 처음부터 반복.

## server.mjs

아래 코드를 그대로 Write한다:

```javascript
import { createServer } from 'http'
import { readFile, writeFile } from 'fs/promises'
import { resolve, extname } from 'path'
import { fileURLToPath } from 'url'

const DIR = fileURLToPath(new URL('.', import.meta.url))
const PORT = process.env.PORT || 4321
const MAX_BODY = 1_048_576 // 1MB
const MIME = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' }

createServer(async (req, res) => {
  // POST /save → diagram-layout.json 덮어쓰기
  if (req.method === 'POST' && req.url === '/save') {
    const chunks = []
    let size = 0
    for await (const c of req) { size += c.length; if (size > MAX_BODY) { res.writeHead(413); return res.end('Too large') } chunks.push(c) }
    await writeFile(resolve(DIR, 'diagram-layout.json'), Buffer.concat(chunks))
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    return res.end('ok')
  }
  // 정적 파일 서빙 (path traversal 방지)
  const file = req.url === '/' ? '/diagram.html' : req.url
  const resolved = resolve(DIR, '.' + file)
  if (!resolved.startsWith(DIR)) { res.writeHead(403); return res.end('Forbidden') }
  try {
    const data = await readFile(resolved)
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`))
```

## DANGER ZONES (diagram.html)

TEMPLATE.html에 포함된 위험 지대 4곳. 절대 수정하지 말 것:

1. **이벤트 전파 순서** — `stopPropagation → e.detail>=2 → locked` 3줄 순서 고정
2. **useCallback 의존성 배열** — `handleEntityMouseDown: [layout, locked]`, `handleSave: [layout, locked]`, `handleCanvasMouseDown: [dragging, aggDragging, pan]`
3. **드래그 상태 머신** — `dragging | aggDragging | panning` 3개 상호 배타. if/else if 분기 + handleMouseUp 전체 초기화
4. **SVG 좌표 변환** — `pt.matrixTransform(svg.getScreenCTM().inverse())` 사용 필수

사용자가 직접 수정을 요청하지 않았다면, 위 영역을 건드리기 전에 반드시 사용자에게 먼저 알리고 승인을 받을 것.

## Extension Guide

- 새 엔티티 타입: EntityNode 컴포넌트 내 분기 추가
- 새 드래그 종류: DANGER ZONE 3 참조 — 시작/이동/종료 3곳 수정 필수
- 새 데이터 필드: diagram-data.json 스키마에 필드 추가 + 렌더링 코드 추가
- TEMPLATE.html이 800줄 초과 시: 컴포넌트를 별도 .js 파일로 분리하고 server.mjs에서 서빙
