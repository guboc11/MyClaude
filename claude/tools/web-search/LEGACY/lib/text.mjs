// web-search — 본문 글자 다루기
// 판정과 지문(해시)이 같은 잣대를 쓰도록 한곳에 모은다.

/**
 * 화면에 보이는 글자만 남긴다. 주석과 script 안의 글자는 사람이 못 보는 글자다 —
 * 그걸 세거나 낱말을 찾으면 "글이 있다"고 잘못 판단한다.
 */
export function visibleText(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Jina Reader 가 본문 앞에 붙이는 머리말. 여기에 주소가 들어 있어서 그대로 재면
// 같은 내용이라도 주소가 다르면 지문이 달라진다 — 내용으로 묶는 뜻이 사라진다.
const JINA_MARK = /^[\s\S]*?^Markdown Content:\s*$/m;
const JINA_HEAD_LINE = /^(Title|URL Source|Published Time|Warning|Images|Links|Description)\s*:/i;

export function stripJinaHeader(md) {
  const s = String(md || '');
  if (JINA_MARK.test(s)) return s.replace(JINA_MARK, '').replace(/^\s+/, '');
  // 머리말 표시가 없으면 앞쪽의 머리말 줄만 걷어낸다
  const lines = s.split('\n');
  let i = 0;
  while (i < lines.length && (JINA_HEAD_LINE.test(lines[i]) || lines[i].trim() === '')) i++;
  return i > 0 && i < lines.length ? lines.slice(i).join('\n').replace(/^\s+/, '') : s;
}

// 낱말 세기에서 뺄 흔한 말. 세어 봐야 어느 사이트에나 나와 아무것도 못 가른다.
const STOP = new Set([
  '그리고', '그러나', '있습니다', '합니다', '입니다', '수', '및', '등', '더', '이', '그', '저',
  'the', 'and', 'for', 'with', 'you', 'your', 'this', 'that', 'from', 'are', 'our', 'all',
]);

/**
 * 한 쪽에 나온 낱말을 센다. 보이는 글자만 본다.
 *
 * [자르지 않는다] 쪽마다 상위 몇 개만 남기면, 그 쪽에서는 서른한째지만 여러 쪽에 걸쳐 나오는 낱말이
 * 전체 순위에서 통째로 사라진다. 쪽 단위 저장은 통째로 하고, 자르는 일은 합쳐 보여 줄 때만 한다.
 */
export function termCounts(text) {
  const counts = new Map();
  for (const raw of String(text || '').split(/[^\p{L}\p{N}]+/u)) {
    const t = raw.trim().toLowerCase();
    if (t.length < 2 || t.length > 24) continue;
    if (/^\d+$/.test(t)) continue;
    if (STOP.has(t)) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

/** 지문을 뜨기 전의 표준형. 보이는 글자만, 공백은 한 칸으로. */
export function canonicalContent(body, { markdown = false } = {}) {
  const text = markdown ? stripJinaHeader(body) : visibleText(body);
  return String(text).replace(/\s+/g, ' ').trim();
}
