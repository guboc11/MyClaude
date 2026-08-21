#!/usr/bin/env node
// md-convert 본체 — md 원본 → 인쇄용 pdf. 원본은 항상 md, pdf는 파생 산출물이다.
// 사용: node .claude/tools/md-convert/convert.mjs <파일.md ...> --topic <주제> [--landscape] [--out <폴더>]
// 산출: .claude/mcp-md-convert/{오늘}-{주제}/{원본이름}.pdf  (--out을 주면 그 폴더 우선)
//       — 산출 루트는 도구 이름을 따른다(형식별 폴더 금지: 형식이 늘 때마다 폴더가 늘어남). 형식은 확장자가 말한다.
// 계획: _ARCHIVED/_PLAN/2026-08-01-md-convert-mcp/PLAN.md
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
// Chrome 경로는 환경변수로 덮어쓸 수 있다 (다른 기계 이식용)
const CHROME = process.env.MD_CONVERT_CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// 날짜는 로컬(KST) 기준 — toISOString은 UTC라 자정~09시에 어제 날짜가 찍힌다 (task MCP 실사고 2회)
function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 의존성 로드 — 없으면 복사-실행 가능한 설치 명령을 안내한다. 자동 설치는 하지 않는다(설치는 명시 행동).
function missingDeps() {
  const rel = path.relative(process.cwd(), TOOL_DIR) || '.';
  return new Error(`의존성이 없습니다. 여기서 실행: npm install --prefix ${rel}`);
}

export function loadMarked() {
  const require = createRequire(import.meta.url);
  try {
    return require('marked');
  } catch {
    throw missingDeps();
  }
}

// 본 양식은 github-markdown-css(light 판)가 맡는다 — 미리보기와 같게 보이는 것이 목적이라
// 양식을 직접 쓰지 않는다. light 판을 쓰는 이유는 통합판의 prefers-color-scheme 때문에
// 인쇄가 다크로 뒤집힐 수 있어서다. style.css 는 종이에만 필요한 것(용지·페이지 넘김)만 덮어쓴다.
function loadStyles() {
  const require = createRequire(import.meta.url);
  let theme;
  try {
    theme = fs.readFileSync(require.resolve('github-markdown-css/github-markdown-light.css'), 'utf8');
  } catch {
    throw missingDeps();
  }
  const print = fs.readFileSync(path.join(TOOL_DIR, 'style.css'), 'utf8');
  return `${theme}\n${print}`;
}

function htmlShell(bodyHtml, { title, landscape }) {
  const css = loadStyles();
  const pageOverride = landscape ? '@page { size: A4 landscape; }' : '';
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<style>${css}\n${pageOverride}</style></head>
<body class="markdown-body">${bodyHtml}</body></html>`;
}

// 본체 — MCP server.mjs가 이 함수를 그대로 재사용한다 (변환 로직 중복 구현 금지)
export function convertFiles({ files, topic, landscape = false, out }) {
  if (!files?.length) throw new Error('변환할 md 파일 경로를 하나 이상 주세요.');
  if (!out && !topic) throw new Error('--topic <주제> 또는 --out <폴더>가 필요합니다 (산출 폴더 결정용).');
  if (!fs.existsSync(CHROME)) {
    throw new Error(`Chrome을 찾지 못했습니다: ${CHROME} (환경변수 MD_CONVERT_CHROME로 지정 가능)`);
  }
  const { marked } = loadMarked();

  const outDir = out || path.join(projectDir(), '.claude', 'mcp-md-convert', `${todayLocal()}-${topic}`);
  fs.mkdirSync(outDir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-convert-'));

  const results = [];
  try {
    for (const file of files) {
      if (!fs.existsSync(file)) throw new Error(`파일 없음: ${file}`);
      const md = fs.readFileSync(file, 'utf8');
      const body = marked.parse(md, { gfm: true });
      const base = path.basename(file).replace(/\.md$/i, '');
      const tmpHtml = path.join(tmpDir, `${base}.html`);
      const outPdf = path.join(outDir, `${base}.pdf`);
      fs.writeFileSync(tmpHtml, htmlShell(body, { title: base, landscape }));
      try {
        execFileSync(CHROME, [
          '--headless', '--disable-gpu', '--no-pdf-header-footer',
          `--print-to-pdf=${outPdf}`, tmpHtml,
        ], { stdio: 'pipe' });
      } catch (e) {
        throw new Error(`인쇄 실패 (${file}): ${e.message.split('\n')[0]}`);
      }
      if (!fs.existsSync(outPdf) || !fs.statSync(outPdf).size) {
        throw new Error(`인쇄 실패 (${file}): pdf가 생성되지 않았습니다.`);
      }
      results.push({ source: file, pdf: outPdf, bytes: fs.statSync(outPdf).size });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return { outDir, results };
}

// CLI
function main() {
  const argv = process.argv.slice(2);
  const files = [];
  const opt = { landscape: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--topic') opt.topic = argv[++i];
    else if (a === '--landscape') opt.landscape = true;
    else if (a === '--out') opt.out = argv[++i];
    else files.push(a);
  }
  try {
    const { outDir, results } = convertFiles({ files, ...opt });
    for (const r of results) console.log(`생성: ${r.pdf} (${(r.bytes / 1024).toFixed(1)} KB)`);
    console.log(`완료 — ${results.length}개, 폴더: ${outDir}`);
  } catch (e) {
    console.error(`[md-convert] ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
