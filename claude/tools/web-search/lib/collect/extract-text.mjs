// 보이는 텍스트를 나온 순서대로.
//
// 계획서 4-6: "body 의 보이는 텍스트를 순서대로 정규화. 주 내용을 추측해 삭제하지 않음."
//
// 두 가지를 구분한다.
//   - **안 보이는 것**은 뺀다: script·style·template 안쪽, hidden 표시가 붙은 곳.
//     이건 추측이 아니라 문서가 스스로 "안 보인다" 고 적어 둔 것이다.
//   - **본문이 아닌 것 같은 것**은 빼지 않는다: nav·footer·광고처럼 보이는 자리도 그대로 남긴다.
//     그건 의미 판정이고, 1차가 그 판단을 MCP 안에 넣었다가 무너졌다.
//
// 뺀 것은 세어서 돌려준다. 조용히 사라지는 글자가 없어야 한다.

import { BLOCK_ELEMENTS, RAW_TEXT_ELEMENTS, decodeEntities, tokenize } from './html.mjs';

/** 안쪽을 통째로 건너뛰는 자리. 화면에 글자로 나타나지 않는 것들이다. */
const SKIP_SUBTREE = new Set(['script', 'style', 'template', 'svg', 'math', 'iframe', 'object', 'canvas']);

/** 문서가 스스로 "안 보인다" 고 적어 둔 표시인가. */
function isHiddenAttrs(attrs) {
  if (attrs.hidden !== undefined) return true;
  if (attrs['aria-hidden'] === 'true') return true;
  const style = String(attrs.style ?? '').toLowerCase().replace(/\s+/g, '');
  return style.includes('display:none') || style.includes('visibility:hidden');
}

/**
 * @returns {{
 *   text: string, title: string|null, chars: number, lines: number,
 *   skipped_hidden: number, skipped_script_style: number
 * }}
 */
export function extractText(html) {
  // 덩어리로 모은다. pre 덩어리는 마지막 다듬기를 받지 않는다 —
  // 줄 단위로 훑어 버리면 pre 안쪽의 들여쓰기가 통째로 사라진다.
  const blocks = [{ pre: false, chunks: [] }];
  const current = () => blocks[blocks.length - 1];
  const newBlock = (isPre) => {
    if (current().chunks.length === 0) { current().pre = isPre; return; }
    blocks.push({ pre: isPre, chunks: [] });
  };
  const out = {
    push: (s) => current().chunks.push(s),
    get last() { const c = current().chunks; return c.length ? c[c.length - 1] : null; },
    get length() { return current().chunks.length; },
  };
  const stack = [];
  let inBody = false;
  let sawBody = false;
  let title = null;
  let pre = 0;
  const skip = [];             // 건너뛰는 중인 자리 이름
  let skippedHidden = 0;
  let skippedScriptStyle = 0;

  const pushBoundary = () => newBlock(pre > 0);

  for (const t of tokenize(html)) {
    if (t.type === 'open') {
      const hidden = isHiddenAttrs(t.attrs);
      if (t.name === 'body') { inBody = true; sawBody = true; }
      if (!t.selfClosing) stack.push({ name: t.name, hidden });

      if (skip.length === 0 && (SKIP_SUBTREE.has(t.name) || hidden)) {
        if (SKIP_SUBTREE.has(t.name)) skippedScriptStyle++;
        else skippedHidden++;
        if (!t.selfClosing) skip.push(t.name);
        continue;
      }
      if (skip.length) continue;

      if (t.name === 'br') { pushBoundary(); continue; }
      if (t.name === 'pre') { pushBoundary(); pre++; newBlock(true); continue; }
      if (BLOCK_ELEMENTS.has(t.name)) pushBoundary();
      continue;
    }

    if (t.type === 'close') {
      if (skip.length && skip[skip.length - 1] === t.name) { skip.pop(); }
      // 스택을 이름으로 되감는다. 안 닫힌 태그가 있어도 여기서 무너지지 않는다.
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === t.name) { stack.length = k; break; }
      }
      if (t.name === 'pre' && pre > 0) { pre--; newBlock(false); continue; }
      if (skip.length === 0 && BLOCK_ELEMENTS.has(t.name)) pushBoundary();
      continue;
    }

    if (t.type === 'raw') {
      if (t.name === 'title' && title === null) title = decodeEntities(t.value).trim();
      // script·style 안쪽 글자는 사람이 보는 글자가 아니다.
      continue;
    }

    if (t.type !== 'text') continue;     // 주석·선언은 글자가 아니다
    if (skip.length) continue;
    if (!inBody && sawBody) continue;
    // body 태그가 아예 없는 조각 문서도 있다. 그때는 전부 본문으로 본다.
    if (!sawBody && stack.some((e) => e.name === 'head')) continue;

    const decoded = decodeEntities(t.value).replace(/\u0000/g, '');
    if (pre > 0) {
      if (decoded) out.push(decoded);
      continue;
    }
    const squashed = decoded.replace(/\s+/g, ' ');
    if (squashed.trim() === '') {
      // 낱말 사이의 빈칸은 살린다. 붙여 버리면 "총 12개" 가 "총12개" 가 된다.
      if (out.length && !out.last.endsWith(' ')) out.push(' ');
      continue;
    }
    out.push(squashed);
  }

  // 덩어리마다 다르게 다듬는다. pre 는 받은 모양 그대로 두고, 나머지만 한 줄로 줄인다.
  const text = blocks
    .map((b) => (b.pre
      ? b.chunks.join('').replace(/^\n+|\s+$/g, '')
      : b.chunks.join('').replace(/[ \t]+/g, ' ').trim()))
    .filter((s) => s !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    // 앞뒤의 빈 줄만 걷어낸다. trim() 을 쓰면 첫 덩어리가 pre 일 때 들여쓰기까지 먹는다.
    .replace(/^\n+|\n+$/g, '');

  return {
    text,
    title,
    chars: text.length,
    lines: text === '' ? 0 : text.split('\n').length,
    skipped_hidden: skippedHidden,
    skipped_script_style: skippedScriptStyle,
  };
}
