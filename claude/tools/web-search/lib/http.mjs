// HTTP 전송 — 나가는 길은 여기 하나다.
//
// 계획서 5-4. 검사와 실제 연결이 갈라지면 검사가 무의미하다. 그래서 이 계층은
// **검사에서 얻은 IP 로 소켓을 고정**한다. hostname 을 다시 해석하게 두면 그 사이에 DNS 가 바뀌어
// (rebinding) 검사한 곳과 다른 데로 나간다.
//
// 고정하는 방법으로 host 를 IP 로 바꿔치지 않는다. 그러면 Host 머리와 TLS SNI 가 IP 가 되어
// 가상 호스트가 엉키고 인증서 검증이 깨진다. 대신 연결 직전의 이름 풀이(lookup)만 갈아 끼운다 —
// 이름은 그대로 두고 **어디로 붙을지만** 우리가 정한다.
//
// 홉마다 다시 검사한다. 앞 홉이 안전했다는 것은 다음 홉에 대해 아무것도 말해 주지 않는다.
//
// 쿠키·세션·Authorization 은 보내지도 받아 두지도 않는다. 받은 set-cookie 는 돌려주는 머리에서
// 아예 빼 버린다 — 어딘가에 적히면 그게 곧 세션 보관이다.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { checkTarget } from './network-policy.mjs';
import { USER_AGENT } from './robots.mjs';

export class HttpError extends Error {
  constructor(stage, code, message) {
    super(message ?? code);
    this.name = 'HttpError';
    this.stage = stage;
    this.code = code;
  }
}

export const HTTP_DEFAULTS = Object.freeze({
  connect_timeout_ms: 5_000,
  headers_timeout_ms: 10_000,
  body_timeout_ms: 15_000,
  overall_timeout_ms: 30_000,
  max_redirects: 5,
  max_bytes: 10 * 1024 * 1024,
});

/** 돌려주는 응답 머리. 여기 없는 것은 버린다 — set-cookie 가 여기 없는 것이 핵심이다. */
const KEEP_HEADERS = [
  'content-type', 'content-length', 'content-encoding', 'location',
  'retry-after', 'last-modified', 'etag', 'server', 'date',
];

const minimalHeaders = (raw) => {
  const out = {};
  for (const k of KEEP_HEADERS) {
    const v = raw[k];
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
};

/** 어떤 경우에도 실어 보내지 않는 머리. 위에서 넘어와도 여기서 지운다. */
const NEVER_SEND = new Set(['cookie', 'authorization', 'proxy-authorization', 'set-cookie']);

function outgoingHeaders(u, extra) {
  const out = {
    host: u.host,
    'user-agent': USER_AGENT,
    accept: '*/*',
    'accept-encoding': 'gzip, deflate, br',
  };
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v === undefined || v === null) continue;
    if (NEVER_SEND.has(k.toLowerCase())) continue;
    out[k.toLowerCase()] = v;
  }
  // 부른 쪽이 무엇을 넣었든 마지막에 한 번 더 훑는다.
  for (const k of Object.keys(out)) if (NEVER_SEND.has(k)) delete out[k];
  return out;
}

const withDefaults = (o = {}) => {
  const out = { ...HTTP_DEFAULTS };
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
};

// ── 한 홉 ─────────────────────────────────────────────────────

/**
 * 검사가 끝난 주소로 한 번 두드린다. 리다이렉트를 따라가지 않는다.
 *
 * @param {{pinnedIp:string, allowedIps:string[], timeouts:object, method:string, headers:object}} o
 * @returns {Promise<{status, headers, body:Buffer, truncated, connected_ip, remote_verified, elapsed_ms}>}
 */
function requestOnce(url, { pinnedIp, allowedIps, cfg, method = 'GET', extraHeaders = {}, deadline = null }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isTls = u.protocol === 'https:';
    const mod = isTls ? https : http;
    const started = Date.now();

    let settled = false;
    const timers = [];
    const clearTimers = () => { for (const t of timers) clearTimeout(t); timers.length = 0; };
    const done = (fn) => (arg) => { if (settled) return; settled = true; clearTimers(); fn(arg); };
    const ok = done(resolve);
    const bad = done(reject);

    const req = mod.request(u, {
      method,
      // 이름은 그대로 두고 붙을 곳만 우리가 정한다. Host 머리와 SNI 는 Node 가 hostname 으로 채운다.
      // options.all 을 봐야 한다 — Node 22 의 autoSelectFamily 는 배열을 기대하고,
      // 안 맞추면 "Invalid IP address: undefined" 로 죽는다.
      lookup: (hostname, options, callback) => {
        const family = net.isIP(pinnedIp);
        if (options?.all) return callback(null, [{ address: pinnedIp, family }]);
        return callback(null, pinnedIp, family);
      },
      headers: outgoingHeaders(u, extraHeaders),
      // 우리가 직접 따라간다. Node 가 몰래 따라가면 홉마다 다시 검사할 기회가 없다.
      // (http.request 는 원래 안 따라가지만, 뜻을 남겨 둔다.)
    });

    let connectedIp = null;
    let remoteVerified = false;

    const armConnect = setTimeout(() => {
      req.destroy(new HttpError('connect', 'connect_timeout', `${cfg.connect_timeout_ms}ms 안에 연결되지 않았습니다`));
    }, cfg.connect_timeout_ms);
    timers.push(armConnect);

    // 전체 상한은 홉 사이에서만 재면 요청 하나가 길어질 때 못 끊는다. 여기서도 건다.
    if (deadline !== null) {
      timers.push(setTimeout(() => {
        req.destroy(new HttpError('response', 'overall_timeout', `전체 ${cfg.overall_timeout_ms}ms 를 넘겼습니다`));
      }, Math.max(1, deadline - Date.now())));
    }

    let headersTimer = null;
    let bodyTimer = null;

    req.on('socket', (socket) => {
      const onConnected = () => {
        clearTimeout(armConnect);
        connectedIp = socket.remoteAddress ? socket.remoteAddress.replace(/^::ffff:/, '') : null;
        // 붙고 나서 실제로 어디에 붙었는지 확인한다. 고정을 했어도 확인은 따로 한다.
        remoteVerified = connectedIp !== null && allowedIps.includes(connectedIp);
        if (!remoteVerified) {
          socket.destroy();
          req.destroy(new HttpError('connect', 'remote_address_mismatch',
            `허용 집합 밖으로 연결됐습니다: ${connectedIp}`));
          return;
        }
        headersTimer = setTimeout(() => {
          req.destroy(new HttpError('response', 'headers_timeout', `${cfg.headers_timeout_ms}ms 안에 응답 머리가 오지 않았습니다`));
        }, cfg.headers_timeout_ms);
        timers.push(headersTimer);
      };
      // 이미 붙어 있는 소켓을 물려받았으면 바로 확인한다. 살려 둔 연결이라도 지금 허용 집합에
      // 없는 곳이면 끊는다 — 앞 요청에서 안전했다는 것이 지금도 안전하다는 뜻은 아니다.
      if (!socket.connecting) onConnected();
      // once 여야 한다. on 으로 걸면 살려 둔 소켓을 쓸 때마다 듣는 이가 쌓인다.
      else socket.once(isTls ? 'secureConnect' : 'connect', onConnected);
    });

    req.on('error', (e) => {
      if (e instanceof HttpError) return bad(e);
      const code = e.code || 'request_failed';
      const stage = /CERT|TLS|SSL|EPROTO|ERR_TLS/i.test(`${code} ${e.message}`) ? 'tls'
        : /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET|EPIPE/.test(code) ? 'connect'
          : 'request';
      return bad(new HttpError(stage, String(code).toLowerCase(), e.message.slice(0, 200)));
    });

    req.on('response', (res) => {
      clearTimeout(headersTimer);
      const raw = res.headers;

      let decoder = null;
      const enc = String(raw['content-encoding'] ?? '').toLowerCase().trim();
      if (enc === 'gzip') decoder = zlib.createGunzip();
      else if (enc === 'deflate') decoder = zlib.createInflate();
      else if (enc === 'br') decoder = zlib.createBrotliDecompress();

      const chunks = [];
      let decoded = 0;
      let rawBytes = 0;
      let truncated = false;

      const finish = () => ok({
        status: res.statusCode,
        headers: minimalHeaders(raw),
        body: Buffer.concat(chunks),
        truncated,
        connected_ip: connectedIp,
        remote_verified: remoteVerified,
        elapsed_ms: Date.now() - started,
      });

      const armBody = () => {
        clearTimeout(bodyTimer);
        bodyTimer = setTimeout(() => {
          req.destroy(new HttpError('body', 'body_timeout', `${cfg.body_timeout_ms}ms 동안 본문이 더 오지 않았습니다`));
        }, cfg.body_timeout_ms);
        timers.push(bodyTimer);
      };
      armBody();

      const take = (chunk) => {
        armBody();
        let c = chunk;
        if (decoded + c.length > cfg.max_bytes) {
          c = c.subarray(0, Math.max(0, cfg.max_bytes - decoded));
          truncated = true;
        }
        if (c.length) { chunks.push(Buffer.from(c)); decoded += c.length; }
        if (truncated) { req.destroy(); finish(); }
      };

      if (decoder) {
        // 압축을 풀기 전 크기도 막는다. 작은 파일이 거대하게 부푸는 것을 여기서 끊는다.
        res.on('data', (c) => {
          rawBytes += c.length;
          if (rawBytes > cfg.max_bytes) { truncated = true; req.destroy(); finish(); }
        });
        res.pipe(decoder);
        decoder.on('data', take);
        decoder.on('end', finish);
        decoder.on('error', (e) => bad(new HttpError('body', 'decode_failed', e.message.slice(0, 200))));
      } else {
        res.on('data', (c) => { rawBytes += c.length; take(c); });
        res.on('end', finish);
      }

      res.on('aborted', () => { if (!settled) finish(); });
      res.on('error', (e) => bad(new HttpError('body', String(e.code ?? 'body_failed').toLowerCase(), e.message.slice(0, 200))));
    });

    req.end();
  });
}

// ── 홉을 이어서 ───────────────────────────────────────────────

/**
 * 안전 검사를 통과한 길로만 나간다. 홉마다 URL·DNS·규약을 다시 본다.
 *
 * @param {string} rawUrl
 * @param {{
 *   resolver?: Function, fixtureAllow?: Array, timeouts?: object, method?: string,
 *   maxRedirects?: number, maxBytes?: number, headers?: object
 * }} [opts]
 * @returns {Promise<{
 *   ok: boolean, requested_url: string, final_url: string|null, status: number|null,
 *   headers: object, body: Buffer|null, truncated: boolean, redirected: boolean,
 *   hops: object[], error_stage: string|null, error_code: string|null, error_message_short: string|null,
 *   elapsed_ms: number
 * }>}
 */
export async function fetchSafely(rawUrl, {
  resolver, fixtureAllow = [], timeouts = {}, method = 'GET', headers = {},
  maxRedirects, maxBytes, nowMs = Date.now(), beforeHop = null, afterHop = null,
} = {}) {
  const cfg = withDefaults({ ...timeouts, max_redirects: maxRedirects, max_bytes: maxBytes });
  const started = Date.now();
  // 예약을 기다린 시간은 상한에서 뺀다. 정중하게 기다린 것을 "응답이 늦었다" 로 셀 수는 없다.
  let pausedMs = 0;
  const hops = [];
  const seen = new Set();

  const out = (extra) => ({
    ok: false,
    requested_url: rawUrl,
    final_url: null,
    status: null,
    headers: {},
    body: null,
    truncated: false,
    redirected: hops.length > 1,
    hops,
    error_stage: null,
    error_code: null,
    error_message_short: null,
    elapsed_ms: Date.now() - started,
    waited_ms: pausedMs,
    ...extra,
  });

  let url = rawUrl;

  for (let hop = 0; hop <= cfg.max_redirects; hop++) {
    if (Date.now() - started - pausedMs > cfg.overall_timeout_ms) {
      return out({ error_stage: 'response', error_code: 'overall_timeout', error_message_short: `전체 ${cfg.overall_timeout_ms}ms 를 넘겼습니다` });
    }

    // (1) 이 홉의 목적지를 검사한다. 앞 홉의 허용 집합을 물려받지 않는다.
    const check = await checkTarget(url, { resolver, fixtureAllow });
    const record = {
      hop, url: check.canonical_url ?? url, hostname: check.hostname,
      addresses: check.addresses, fixture: check.fixture, checked_at: check.checked_at,
      pinned_ip: null, connected_ip: null, remote_verified: false, status: null, location: null,
    };
    hops.push(record);

    if (!check.allow) {
      const stage = String(check.reason).startsWith('url_') ? 'url'
        : String(check.reason).startsWith('dns_') ? 'dns' : 'policy';
      return out({ error_stage: stage, error_code: check.reason, error_message_short: `${check.hostname ?? url} 로는 나가지 않습니다` });
    }

    const canonical = check.canonical_url;
    if (seen.has(canonical)) {
      return out({ error_stage: 'redirect', error_code: 'redirect_loop', error_message_short: `같은 곳으로 되돌아왔습니다: ${canonical.slice(0, 80)}` });
    }
    seen.add(canonical);

    // (2) 나가기 직전에 문을 두드린다. 리다이렉트 홉도 요청 하나다 —
    //     여기서 안 걸면 체인 한 번에 서버를 여러 번 두드리면서 간격이 0 이 된다.
    if (beforeHop) {
      const waitedFrom = Date.now();
      const refusal = await beforeHop(canonical, hop);
      pausedMs += Date.now() - waitedFrom;
      if (refusal) {
        return out({
          error_stage: 'pace', error_code: refusal.reason ?? 'not_granted',
          error_message_short: refusal.message ?? `자리를 못 받았습니다 (${Math.ceil((refusal.wait_ms ?? 0) / 1000)}초 대기 필요)`,
        });
      }
    }

    // (3) 검사가 내준 주소 중 하나로 못을 박는다.
    const pinned = check.addresses[0];
    record.pinned_ip = pinned;

    let res;
    try {
      res = await requestOnce(canonical, {
        pinnedIp: pinned, allowedIps: check.addresses, cfg, method, extraHeaders: headers,
        deadline: started + pausedMs + cfg.overall_timeout_ms,
      });
    } catch (e) {
      record.connected_ip = null;
      if (afterHop) await afterHop(canonical, { ok: false, status: null });
      if (e instanceof HttpError) {
        return out({ error_stage: e.stage, error_code: e.code, error_message_short: e.message.slice(0, 200) });
      }
      return out({ error_stage: 'request', error_code: 'unknown', error_message_short: String(e.message).slice(0, 200) });
    }

    record.connected_ip = res.connected_ip;
    record.remote_verified = res.remote_verified;
    record.status = res.status;
    if (afterHop) await afterHop(canonical, { ok: true, status: res.status });

    // (4) 리다이렉트면 다음 홉으로. 따라가기 전에 위 (1) 이 처음부터 다시 돈다.
    const isRedirect = res.status >= 300 && res.status < 400;
    const location = res.headers.location ?? null;
    record.location = location;

    if (isRedirect && location) {
      if (hop === cfg.max_redirects) {
        return out({ status: res.status, headers: res.headers, final_url: canonical,
          error_stage: 'redirect', error_code: 'too_many_redirects', error_message_short: `${cfg.max_redirects}홉을 넘겼습니다` });
      }
      try {
        url = new URL(location, canonical).toString();
      } catch {
        return out({ status: res.status, headers: res.headers, final_url: canonical,
          error_stage: 'redirect', error_code: 'bad_location', error_message_short: `Location 을 읽을 수 없습니다: ${String(location).slice(0, 80)}` });
      }
      continue;
    }
    if (isRedirect && !location) {
      return out({ status: res.status, headers: res.headers, final_url: canonical,
        error_stage: 'redirect', error_code: 'redirect_no_location', error_message_short: '3xx 인데 Location 이 없습니다' });
    }

    // (5) 도착.
    return out({
      ok: true, final_url: canonical, status: res.status, headers: res.headers,
      body: res.body, truncated: res.truncated, redirected: hops.length > 1,
      error_stage: null, error_code: null, error_message_short: null,
    });
  }

  return out({ error_stage: 'redirect', error_code: 'too_many_redirects', error_message_short: `${cfg.max_redirects}홉을 넘겼습니다` });
}

/**
 * robots.txt 용 작은 가져오기. checkRobots 가 넘겨받는 fetcher 다.
 * robots 도 다른 요청과 똑같은 검사·고정·상한을 받는다.
 */
export const robotsFetcher = (opts = {}) => async (url) => {
  const r = await fetchSafely(url, { ...opts, maxBytes: 512 * 1024, maxRedirects: 2 });
  return { ok: r.ok && r.status === 200, status: r.status, body: r.ok ? r.body : null, error_code: r.error_code };
};
