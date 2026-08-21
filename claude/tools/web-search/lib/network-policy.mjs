// 네트워크 목적지 검사 — 어디로 나가도 되는지.
//
// 계획서 5-4. 검사와 실제 연결이 갈라지면 검사가 무의미하므로, 여기서는 판정만 하지 않고
// **판정의 근거가 된 주소 집합** 을 함께 돌려준다. HTTP 계층(#25)이 그 주소로 연결을 고정한다.
// hostname 을 다시 해석하게 두면 그 사이에 DNS 가 바뀌어(rebinding) 검사한 곳과 다른 데로 간다.

import dns from 'node:dns/promises';
import net from 'node:net';
import { normalizeUrl, UrlError } from './url.mjs';

export class NetworkPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NetworkPolicyError';
    this.code = code;
  }
}

// ── IP 갈래 ───────────────────────────────────────────────────

const v4 = (a) => a.split('.').map(Number);
const inNet4 = (a, prefix, bits) => {
  const toInt = (p) => p.reduce((n, o) => (n * 256) + o, 0);
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
  return (toInt(v4(a)) & mask) === (toInt(v4(prefix)) & mask);
};

/** 이 주소가 어떤 갈래인가. 'public' 만 나가도 된다. */
export function classifyIp(addr) {
  const type = net.isIP(addr);
  if (type === 0) return 'not_an_ip';

  if (type === 4) {
    if (inNet4(addr, '0.0.0.0', 8)) return 'unspecified';
    if (inNet4(addr, '127.0.0.0', 8)) return 'loopback';
    if (inNet4(addr, '10.0.0.0', 8)) return 'private';
    if (inNet4(addr, '172.16.0.0', 12)) return 'private';
    if (inNet4(addr, '192.168.0.0', 16)) return 'private';
    if (inNet4(addr, '169.254.0.0', 16)) return 'link_local';
    if (inNet4(addr, '100.64.0.0', 10)) return 'shared_cgnat';
    if (inNet4(addr, '192.0.0.0', 24)) return 'reserved';
    if (inNet4(addr, '192.0.2.0', 24)) return 'documentation';
    if (inNet4(addr, '198.18.0.0', 15)) return 'benchmark';
    if (inNet4(addr, '198.51.100.0', 24)) return 'documentation';
    if (inNet4(addr, '203.0.113.0', 24)) return 'documentation';
    if (inNet4(addr, '224.0.0.0', 4)) return 'multicast';
    if (inNet4(addr, '240.0.0.0', 4)) return 'reserved';
    return 'public';
  }

  const a = addr.toLowerCase();
  // IPv4 를 감싼 IPv6 는 속을 보고 판정한다. 겉만 보면 ::ffff:127.0.0.1 이 통과한다.
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return classifyIp(mapped[1]);
  if (a === '::') return 'unspecified';
  if (a === '::1') return 'loopback';
  if (/^f[cd]/.test(a)) return 'private';            // fc00::/7 유니크 로컬
  if (/^fe[89ab]/.test(a)) return 'link_local';      // fe80::/10
  if (/^ff/.test(a)) return 'multicast';             // ff00::/8
  if (a.startsWith('2001:db8')) return 'documentation';
  if (a.startsWith('64:ff9b:')) return 'nat64';
  return 'public';
}

export const isPublicIp = (addr) => classifyIp(addr) === 'public';

// ── 목적지 검사 ───────────────────────────────────────────────

/** 기본 해석기. 시험에서는 갈아 끼운다. */
async function defaultResolver(hostname) {
  const found = await dns.lookup(hostname, { all: true, verbatim: true });
  return found.map((r) => r.address);
}

/** 이 URL 이 실제로 두드릴 포트. 적혀 있지 않으면 규약의 기본값이다. */
function effectivePort(canonicalUrl) {
  const u = new URL(canonicalUrl);
  if (u.port) return Number(u.port);
  return u.protocol === 'https:' ? 443 : 80;
}

/**
 * 이 URL 로 나가도 되는지 본다.
 *
 * @param {object} [opts]
 * @param {ReadonlyArray<{host:string,port:number}>} [opts.fixtureAllow]
 *   시험 전용 루프백 허용 목록. **기본값은 빈 목록이고, 이 자리에 무엇을 넣을지는 부른 쪽이 정한다.**
 *   이 모듈이 스스로 argv·환경변수를 읽지 않는 것이 핵심이다 — 문을 여는 결정이 한 곳에만 있게 한다.
 *   목록은 lib/fixture-allow.mjs 가 argv 에서만 만든다.
 *
 * @returns {{
 *   allow: boolean, canonical_url: string, hostname: string,
 *   addresses: string[],        // 허용 판정의 근거가 된 공인 주소. 연결은 이 중에서만 한다.
 *   rejected: {address, kind}[],
 *   checked_at: number,         // 검사와 연결 사이의 시간차를 부른 쪽이 판단할 수 있게
 *   fixture: boolean,           // 시험 전용 문으로 통과했는가. 운영에서는 언제나 false 다.
 *   reason: string|null
 * }}
 */
export async function checkTarget(input, { resolver = defaultResolver, base, fixtureAllow = [] } = {}) {
  const checked_at = Date.now();
  let norm;
  try {
    norm = normalizeUrl(input, base ? { base } : {});
  } catch (e) {
    if (!(e instanceof UrlError)) throw e;
    return { allow: false, canonical_url: null, hostname: null, addresses: [], rejected: [], checked_at, fixture: false, reason: `url_${e.code}` };
  }

  const hostname = norm.domain;
  const deny = (reason, rejected = []) => ({
    allow: false, canonical_url: norm.canonical_url, hostname, addresses: [], rejected, checked_at, fixture: false, reason,
  });
  const permit = (addresses, fixture = false) => ({
    allow: true, canonical_url: norm.canonical_url, hostname, addresses, rejected: [], checked_at, fixture, reason: null,
  });

  // 주소를 그대로 쓴 경우엔 해석할 것이 없다.
  if (net.isIP(hostname)) {
    const kind = classifyIp(hostname);
    if (kind === 'public') return permit([hostname]);
    // 시험 전용 문. 부른 쪽이 건네준 목록에 host·port 가 정확히 있을 때만 열린다.
    // 목록이 비어 있으면(운영) 이 줄은 언제나 거짓이고 아래 거절로 떨어진다.
    if (kind === 'loopback' && fixtureAllow.some((e) => e.host === hostname && e.port === effectivePort(norm.canonical_url))) {
      return permit([hostname], true);
    }
    return deny(`ip_${kind}`, [{ address: hostname, kind }]);
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return deny('hostname_localhost');

  let resolved;
  try {
    resolved = await resolver(hostname);
  } catch (e) {
    return deny(`dns_${e.code || 'failed'}`);
  }
  if (!Array.isArray(resolved) || resolved.length === 0) return deny('dns_empty');

  const allowed = [];
  const rejected = [];
  for (const address of resolved) {
    const kind = classifyIp(address);
    if (kind === 'public') allowed.push(address);
    else rejected.push({ address, kind });
  }
  // 하나라도 위험한 주소가 섞여 있으면 통째로 거절한다. 골라 쓰면 그 호스트가 어느 쪽을
  // 내줄지에 우리 안전이 걸리게 된다.
  if (rejected.length) {
    // 시험 전용 문 — 이름 쪽. 풀린 주소가 **전부** 허용 목록에 그 포트로 들어 있을 때만 열린다.
    // DNS 가 무언가를 새로 허락하는 것이 아니다. 이미 argv 로 허락한 곳을 이름으로 부를 수 있게 할 뿐이라,
    // 하나라도 목록 밖 주소가 섞이면 통째로 거절된다.
    const port = effectivePort(norm.canonical_url);
    const allFixture = resolved.length > 0
      && resolved.every((a) => fixtureAllow.some((e) => e.host === a && e.port === port));
    if (allFixture) return permit(resolved, true);
    return deny('resolves_to_non_public', rejected);
  }
  if (allowed.length === 0) return deny('no_public_address');

  return permit(allowed);
}

/**
 * 리다이렉트 한 홉을 다시 검사한다.
 * 앞 홉의 허용 집합을 물려주지 않는다 — 새 호스트는 새로 확인해야 한다.
 */
export async function checkRedirect(location, currentUrl, opts = {}) {
  return checkTarget(location, { ...opts, base: currentUrl });
}
