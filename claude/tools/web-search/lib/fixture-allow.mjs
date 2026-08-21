// 시험 전용 목적지 허용 — 루프백으로 나가는 유일한 문.
//
// 계획서 5-4 의 마지막 문단. 로컬 fixture 시험은 안전 규칙을 끄는 것이 아니라, 시험 프로세스에만
// 있는 좁은 문 하나를 여는 것이다. 그래서 세 가지를 못박는다.
//
//   (1) 값은 argv 에서만 온다. 환경변수도, workspace 파일도, MCP 입력도 읽지 않는다.
//       그래서 이 파일에는 process.env 도 파일 읽기도 없다 — 시험이 그 부재를 직접 확인한다.
//   (2) 프로세스가 시작할 때 한 번 읽고 얼린다. 도는 중에 늘릴 방법이 없다.
//   (3) 루프백 주소에 포트까지 붙은 것만 받는다. 사설망·공인 주소는 이 문으로 못 들어온다.
//       이름(localhost)도 받지 않는다 — 이름이 어디를 가리킬지는 DNS 가 정하고, DNS 는 우리 것이 아니다.
//
// [경계] 이 파일은 목록을 만들 뿐, 스스로 아무 문도 열지 않는다. checkTarget 은 부른 쪽이
// 명시적으로 건네준 목록만 본다(기본값은 빈 목록). 그래서 이 모듈을 import 하는 것만으로는
// 어떤 프로세스도 루프백에 나갈 수 없다.

import net from 'node:net';

export const FIXTURE_FLAG = '--allow-fixture-host';

export class FixtureAllowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FixtureAllowError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new FixtureAllowError(code, message); };

/**
 * 이 주소가 문자 그대로의 루프백인가.
 *
 * classifyIp 의 전체 분류를 쓰지 않는 이유: 여기서 묻는 것은 "어느 갈래인가" 가 아니라
 * "이 플래그에 적어도 되는 아주 좁은 형태인가" 다. 질문이 다르므로 규칙도 따로 둔다.
 * (network-policy 를 import 하면 두 모듈이 서로를 부르는 고리가 생긴다 — 그것도 피한다.)
 */
function isLiteralLoopback(host) {
  const kind = net.isIP(host);
  if (kind === 4) return /^127\./.test(host);   // 127.0.0.0/8
  if (kind === 6) return host === '::1';
  return false;
}

/** 보여 줄 때 쓰는 표기. IPv6 는 대괄호를 씌운다. */
export const fixtureLabel = ({ host, port }) => (net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`);

function parseEntry(value) {
  const raw = String(value).trim();
  if (!raw) fail('empty_value', `${FIXTURE_FLAG} 값이 비었습니다`);

  // [::1]:5599 또는 127.0.0.1:5599 두 형태만 받는다.
  const bracketed = raw.match(/^\[([0-9a-fA-F:]+)\]:(\d{1,5})$/);
  const plain = raw.match(/^([0-9.]+):(\d{1,5})$/);
  const m = bracketed || plain;
  if (!m) fail('not_host_port', `${FIXTURE_FLAG} 는 host:port 형태여야 합니다 (받은 값: ${raw})`);

  const host = m[1].toLowerCase();
  const port = Number(m[2]);
  if (!isLiteralLoopback(host)) {
    fail('not_loopback', `${FIXTURE_FLAG} 에는 루프백 주소만 적을 수 있습니다 (받은 값: ${host})`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail('bad_port', `${FIXTURE_FLAG} 의 포트가 범위 밖입니다 (받은 값: ${m[2]})`);
  }
  return Object.freeze({ host, port });
}

/**
 * argv 에서 허용 목록을 읽는다. 순수 함수 — 여기서 process 를 만지지 않는다.
 * @param {string[]} argv
 * @returns {ReadonlyArray<{host:string, port:number}>}
 */
export function parseFixtureAllow(argv = []) {
  const out = [];
  const seen = new Set();
  for (const arg of argv) {
    if (arg === FIXTURE_FLAG) fail('missing_value', `${FIXTURE_FLAG} 뒤에 =host:port 를 붙여야 합니다`);
    if (!arg.startsWith(`${FIXTURE_FLAG}=`)) continue;
    const entry = parseEntry(arg.slice(FIXTURE_FLAG.length + 1));
    const key = fixtureLabel(entry);
    if (seen.has(key)) continue;      // 같은 곳을 두 번 적어도 목록은 한 줄이다
    seen.add(key);
    out.push(entry);
  }
  return Object.freeze(out);
}

/** 이 host·port 조합이 목록에 있는가. 포트까지 정확히 맞아야 한다. */
export function isFixtureAllowed(host, port, allow = []) {
  const h = String(host).toLowerCase();
  const p = Number(port);
  return allow.some((e) => e.host === h && e.port === p);
}

/**
 * 이 프로세스의 허용 목록. 시작할 때 한 번 읽고 그대로 얼어 있다.
 * argv 에 플래그가 없으면 빈 목록이고, 그때 동작은 이 모듈이 없던 때와 정확히 같다.
 */
export const FIXTURE_ALLOW = parseFixtureAllow(process.argv.slice(2));
