#!/usr/bin/env node
// 사용법: node .claude/tools/copy-lint.mjs "검사할 문구"  |  --file <경로>  |  --self-test  (표준입력도 받음)
//
// 코퍼스에 실재하지 않는 말을 잡는다. 사전은 terms.md가 아니라 코퍼스 원문 4파일의 '원문' 열이다.
// terms.md를 사전으로 쓰면 terms.md가 틀렸을 때 검출기도 같이 틀린다 — 지난 사고(sections.md의
// '여미는 방식'을 아무도 의심하지 않음)와 같은 구조가 되므로 원문을 직접 사전으로 삼는다.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS_DIR = resolve(HERE, '../../_RESEARCH/2026-08-06-LEARN-landing-copy-voice')
const CORPUS_FILES = ['apps-20.md', 'mcheong.md', 'wedding-20.md', 'info-corpus.md']

// 허용 목록 — 코퍼스에 없어도 통과시킨다. 근거는 terms.md 확정 사전.
const UI_NAMES = [
  // UI 실명 (완성본에서 사용자에게 보이는 문자열)
  '실링', '왁스', '실링 왁스', '덮개', '측면', '리본',
  '아이보리', '핑크', '브라운', '그린',
  '봉투', '청첩장', '모바일', '디방',
  '마음 전하실 곳', '오시는 길',
  // 자체 명명 — terms.md에 등재된 것만
  '뜯',
  // 상용 동사 허용 — terms.md:41 (코퍼스 표준 "스와이프"는 설정 이름 자리라 조작 안내와 자리가 다름)
  // 주의: 맨 '밀'을 넣으면 폐기어 '밀랍'까지 통과한다. 활용형만 적는다.
  '밀어', '밀면', '옆으로',
]

// terms.md 폐기 목록 — 카피 산출물에만 건다(terms.md 처리 규칙 5: 장부 문서는 폐기어를 인용·기록할 수 있다).
const RETIRED = [
  { re: /여미/, why: '폐기어 "여미는 방식" — 지어낸 상위어. 실명 나열로 (terms 규칙 1)' },
  { re: /표지/, why: '폐기어 "표지" → 커버 (코퍼스 0)' },
  { re: /받는 ?분/, why: '폐기어 "받는 분들" → 하객 (코퍼스 0, 하객 20)' },
  { re: /예식 ?일시/, why: '폐기어 "예식 일시" → 예식 정보 (코퍼스 0)' },
  { re: /밀랍/, why: '폐기어 "밀랍" → 실링 왁스 (코퍼스 0)' },
  { re: /부조/, why: '폐기어 "부조" → 형압 (코퍼스 0)' },
  { re: /(\d|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*가지/, why: '수량 단위는 "종" (코퍼스 33회). 굳어진 "한 가지"는 무관' },
]

// 확정 금지어 — SUMMARY.md 규칙 6 계승. 자리와 무관하게 걸린다.
const BANNED = [
  { re: /[!]/, why: '느낌표 금지' },
  { re: /\p{Extended_Pictographic}/u, why: '이모지 금지' },
  { re: /다양한/, why: "막연 수량어 '다양한' 금지 (규칙 3)" },
  { re: /실제 종이를|찍어 만든|촬영/, why: '촬영 주장 금지 — 이미지는 생성물' },
  { re: /만들었습니다|재현했습니다|구현했습니다/, why: '공정을 성과문으로 포장 금지 (규칙 5)' },
  { re: /\d[\d,]*\s*원/, why: '가격 미확정 — 수치 약속 금지' },
  { re: /후기|평점|판매량|1위/, why: '후기·판매량 인용 금지 (규칙 6)' },
]

// 조사·어미 꼬리. 긴 것부터 떼어 본다.
const TAILS = [
  '으로는', '에서는', '에게는', '까지는', '부터는', '이라는', '라는', '습니다', 'ㅂ니다',
  '으로', '에서', '에게', '까지', '부터', '처럼', '보다', '마다', '이나', '거나', '입니다', '됩니다',
  '은', '는', '이', '가', '을', '를', '에', '의', '와', '과', '도', '만', '께', '요',
]

// 용언 활용형·조사 결합형으로 보이는 꼬리. 여기 걸리면 차단이 아니라 경고로 강등한다.
// (검출기의 목적은 부위·기능 '명사'가 코퍼스 밖인지 보는 것이지 어미를 심판하는 게 아니다.)
const INFLECTED = /(다|요|죠|까|니|고|며|면|서|지|게|나|자|라|어|아|여|워|해|돼|임|음|기|은|는|을|를|이|가|에|의|와|과|도|만)$/

// 숫자+단위 꼴. 단위가 코퍼스에 실재하면 통과 ("12종" "30장" "4색").
const NUM_UNIT = /^(\d+)([가-힣]{1,3})/

// 관형형·명사형 어미는 종성으로 붙는다 — 갖추+ㄴ=갖춘, 만들+ㄴ=만든, 누르+ㄹ=누를, 담+ㅁ=담음.
// 마지막 음절의 종성이 ㄴ/ㄹ/ㅁ이면 그것을 뗀 어간을 후보에 넣고, 활용형으로도 본다.
const CODA = { 4: 'ㄴ', 8: 'ㄹ', 16: 'ㅁ' }
function stripCoda(w) {
  const c = w.charCodeAt(w.length - 1) - 0xac00
  if (c < 0 || c > 11171) return null
  if (!CODA[c % 28]) return null
  return w.slice(0, -1) + String.fromCharCode(0xac00 + (c - (c % 28)))
}

function loadCorpus() {
  const chunks = []
  for (const f of CORPUS_FILES) {
    let raw
    try {
      raw = readFileSync(resolve(CORPUS_DIR, f), 'utf8')
    } catch {
      console.error(`[경고] 코퍼스 없음: ${f} — 사전이 좁아진 상태로 검사합니다`)
      continue
    }
    for (const line of raw.split('\n')) {
      if (!line.trimStart().startsWith('|')) continue
      const cells = line.split('|')
      if (cells.length < 6) continue
      const col = cells[4].trim() // 4번째 열 = 원문. 관찰 열은 우리가 쓴 말이라 사전에서 뺀다.
      if (!col || col === '원문' || /^[-:\s]+$/.test(col)) continue
      chunks.push(col)
    }
  }
  return chunks.join('\n').replace(/[ \t]+/g, ' ')
}

const stripTail = (w) => {
  for (const t of TAILS) if (w.length > t.length + 1 && w.endsWith(t)) return w.slice(0, -t.length)
  return w
}

function lint(text, corpus) {
  const banned = [...BANNED, ...RETIRED].filter((b) => b.re.test(text)).map((b) => b.why)

  const tokens = text.split(/[^가-힣A-Za-z0-9·]+/).filter((t) => /[가-힣]/.test(t) && t.length > 1)
  const missing = new Map() // 차단: 코퍼스 밖 '명사'
  const soft = new Map() // 경고: 코퍼스 밖이지만 활용형·조사 결합형

  for (const tok of tokens) {
    if (UI_NAMES.some((n) => tok.includes(n))) continue

    const unit = NUM_UNIT.exec(tok)
    if (unit && corpus.includes(unit[2])) continue // 숫자+단위: 단위가 실증이면 통과

    // 어간 대조 — 조사·어미를 뗀 형과, 2자 이상 앞부분을 차례로 맞춰 본다.
    // "열리고"→"열리"(열리는 실증) · "재생됩니다"→"재생"(실증) · "색은"→"색"(색상 안에 실재)
    const bare = stripCoda(tok)
    const forms = new Set([tok, stripTail(tok), bare].filter(Boolean))
    for (let i = tok.length - 1; i >= 2; i--) forms.add(tok.slice(0, i))
    let hit = false
    for (const f of forms) if (f && corpus.includes(f)) { hit = true; break }
    if (hit) continue

    if (INFLECTED.test(tok) || bare) soft.set(tok, true)
    else missing.set(tok, true)
  }

  // 명사 둘이 각각은 코퍼스에 있는데 붙여 쓴 형태는 없는 경우 — 지어낸 합성어 후보. 차단이 아니라 경고.
  // 용언 활용형이 낀 짝은 자연스러운 조합이라 제외한다("봉투 누르면" 같은 것까지 걸면 경고가 무의미해진다).
  const CONJUGATED = /(니다|습니다|어요|아요|해요|예요|이에요|면|서|고|며|지만|게|도록|든지|는|은|을|ㄹ)$/
  const words = text.replace(/·/g, ' ').split(/\s+/).filter(Boolean)
  const oddPairs = []
  for (let i = 0; i < words.length - 1; i++) {
    const raw = [words[i], words[i + 1]].map((w) => w.replace(/[^가-힣A-Za-z0-9]/g, ''))
    if (raw.some((w) => w.length < 2 || CONJUGATED.test(w) || missing.has(w))) continue
    const [a, b] = raw.map(stripTail)
    if (a.length < 2 || b.length < 2) continue
    if (!corpus.includes(`${a} ${b}`) && !corpus.includes(`${a}${b}`)) oddPairs.push(`${a} ${b}`)
  }

  return { banned, missing: [...missing.keys()], soft: [...soft.keys()], oddPairs: [...new Set(oddPairs)] }
}

function report(text, r) {
  const pass = r.banned.length === 0 && r.missing.length === 0
  console.log(`\n입력: ${text}`)
  if (r.banned.length) console.log(`  [차단] 금지어 ${r.banned.length}건 — ${r.banned.join(' / ')}`)
  if (r.missing.length) console.log(`  [차단] 코퍼스 밖 명사 ${r.missing.length}개 — ${r.missing.join(', ')}`)
  if (r.soft.length) console.log(`  [경고] 코퍼스 밖 활용형 — ${r.soft.join(', ')}`)
  if (r.oddPairs.length) console.log(`  [경고] 코퍼스에 없는 조합 — ${r.oddPairs.join(' · ')}`)
  console.log(`  => ${pass ? 'PASS' : 'FAIL'}`)
  return pass
}

const corpus = loadCorpus()
const argv = process.argv.slice(2)

if (argv[0] === '--self-test') {
  // 회귀 표본: 지난 사고의 원인 명사가 반드시 걸려야 한다.
  const cases = [
    // 반드시 차단 — 지난 폐기의 원인들
    { text: '여미는 방식 세 가지에 색 네 가지를 두었습니다.', expect: 'FAIL' },
    { text: '밀랍의 광택을 그대로 옮겼습니다', expect: 'FAIL' },
    { text: '눌린 부조가 보입니다', expect: 'FAIL' },
    { text: '표지 사진, 인사말, 예식 일시', expect: 'FAIL' },
    { text: '실제 종이를 찍어 만든 청첩장', expect: 'FAIL' },
    { text: '받는 분들이 보게 되는 것', expect: 'FAIL' },
    // 반드시 통과 — 정상 문장(매니저 T5 보정 요청의 실례)
    { text: '실링 왁스 덮개·실링 왁스 측면·리본, 아이보리·핑크·브라운·그린', expect: 'PASS' },
    { text: '봉투가 열리고 배경음악이 재생됩니다.', expect: 'PASS' },
    { text: '색은 4종, 모두 12종입니다.', expect: 'PASS' },
    { text: '갤러리 30장이 들어갑니다.', expect: 'PASS' },
    { text: '눌러서 열어보기', expect: 'PASS' },
    { text: '격식을 갖춘 초대', expect: 'PASS' },
    { text: '옆으로 밀면 색 4종', expect: 'PASS' },
  ]
  let ok = true
  for (const c of cases) {
    const pass = report(c.text, lint(c.text, corpus))
    const got = pass ? 'PASS' : 'FAIL'
    if (got !== c.expect) { ok = false; console.log(`  !! 기대 ${c.expect} / 실제 ${got}`) }
  }
  console.log(`\n코퍼스 ${corpus.length.toLocaleString()}자 적재. 자체 검사 ${ok ? '통과' : '실패'}`)
  process.exit(ok ? 0 : 1)
}

let input = ''
if (argv[0] === '--file') input = readFileSync(argv[1], 'utf8')
else if (argv.length) input = argv.join(' ')
else input = readFileSync(0, 'utf8')

let allPass = true
for (const line of input.split('\n').map((l) => l.trim()).filter(Boolean)) {
  if (!report(line, lint(line, corpus))) allPass = false
}
process.exit(allPass ? 0 : 1)
