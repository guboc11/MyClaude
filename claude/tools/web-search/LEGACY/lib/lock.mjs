// web-search — 잠금
// 계획서 2-9.
//
// [왜 하드링크인가] 예전에는 디렉터리를 만들어 잠금을 잡고 그 안에 owner.json 을 썼다.
// 그러면 "디렉터리는 생겼는데 주인 정보는 아직 없는" 순간이 생기고, 그 순간을 본 다른 프로세스가
// 반쪽 잠금으로 오해해 살아 있는 주인의 잠금을 걷어 갔다. 주인은 쓰기 도중에 쫓겨났다.
// (2026-08-11 재현: addUrls 자식이 "잠금이 다른 쪽으로 넘어갔습니다"로 죽음. 사유는 owner.json 없음.)
// 유예 시간을 늘리는 건 그 틈을 좁힐 뿐 없애지 못한다.
//
// 그래서 주인 정보를 임시 파일에 **먼저 완성해 두고**, 그 파일을 잠금 이름으로 하드링크한다.
// link 는 대상이 이미 있으면 실패하고, 성공하면 그 순간 파일은 이미 완전하다.
// 잠금은 "없거나, 완전하거나" 둘 중 하나만 된다 — 반쪽인 순간이 아예 없다.
//
// 왜 짧게 잡는가: 잠금은 장부를 읽고 갱신하는 순간에만 잡는다. 네트워크 요청 중에는 절대 안 잡는다.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 서버 실행마다 새로 생기는 값. PID 재사용을 걸러내는 데 쓴다.
export const INSTANCE_ID = crypto.randomUUID();

// 장부 갱신은 밀리초 단위 작업이다. ttl 을 길게 잡으면 주인이 죽었을 때 그만큼 전체가 멈춘다.
const DEFAULT_TTL_MS = 5_000;
// 주인이 "살아 있는데" 만료된 경우에만 이만큼 더 기다린다(느린 디스크·일시 정지 배려).
const GRACE_ALIVE_MS = 5_000;
// 주인 PID 가 아예 없으면 오래 기다릴 이유가 없다 — 부재는 강한 증거다.
// (2026-08-11 회귀 R3: SIGKILL 된 주인의 잠금을 20초간 못 걷어 전체가 멈추는 것을 발견)
const GRACE_DEAD_MS = 300;

function nowMs() { return Date.now(); }

function readOwner(lockFile) {
  try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; }
}

// [심장 박동] 만료 시각만 따로 둔다.
// 잠금 파일 자체를 다시 쓰면 그 순간 파일의 정체(inode)가 바뀌어, 손잡이와 잠금 이름이 어긋난다.
// 그 사이에 프로세스가 죽으면 회수자가 "손잡이는 잡았는데 같은 파일이 아니다"라며 물러나
// 잠금이 영영 풀리지 않는다. 그래서 잠금의 정체는 끝까지 손대지 않고 만료만 옆에서 갱신한다.
function beatPath(lockFile, nonce) { return `${lockFile}.beat.${nonce}`; }

function effectiveExpiry(lockFile, o) {
  const base = o.expires_at ?? 0;
  const b = readOwner(beatPath(lockFile, o.nonce));
  if (b && b.nonce === o.nonce && typeof b.expires_at === 'number') return Math.max(base, b.expires_at);
  return base;
}

// 시험에서만 켜지는 결정적 중단점. 운영 프로세스를 죽이지 않도록 이중 조건을 건다.
function lockFault(name) {
  if (process.env.NODE_ENV !== 'test') return;
  if (process.env.WEBSEARCH_LOCK_FAULT === name) process.kill(process.pid, 'SIGKILL');
}

// 시험에서만 켜지는 장벽. 경합의 순서를 손으로 만들어야 확인할 수 있는 계약이 있다.
// WEBSEARCH_LOCK_BARRIER="지점이름::/열쇠/파일[::/도착/파일]"
// 도착 파일을 주면 기다리기 직전에 원자적으로 만든다 — 시험이 "여기 멈춰 있다"를 시간이 아니라
// 사실로 확인할 수 있어야 순서가 증명된다(잠깐 재우는 것만으로는 증거가 아니다).
function lockBarrier(name) {
  if (process.env.NODE_ENV !== 'test') return;
  const spec = process.env.WEBSEARCH_LOCK_BARRIER;
  if (!spec) return;
  const [want, gate, ready] = spec.split('::');
  if (want !== name || !gate) return;
  if (ready) {
    try {
      const t = `${ready}.tmp.${process.pid}`;
      fs.writeFileSync(t, String(nowMs()));
      fs.renameSync(t, ready);
    } catch {}
  }
  const until = nowMs() + 15_000;
  while (nowMs() < until && !fs.existsSync(gate)) { /* 열릴 때까지 */ }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * 죽은 잠금인지 판정한다.
 * 잠금 파일은 완성된 채로만 나타나므로 "만들어지는 중"이라는 상태가 없다 — 유예도 필요 없다.
 * @returns {{dead:boolean, reason:string}}
 */
export function inspectLock(lockFile) {
  // 판정에 쓴 주인을 그대로 돌려준다. 부르는 쪽이 나중에 다시 읽으면 그 사이 바뀐 주인을
  // 판정 대상으로 착각해, 살아 있는 새 주인을 걷어 갈 수 있다.
  const o = readOwner(lockFile);
  if (!o) {
    // 없는 것은 "죽은 잠금"이 아니라 "잠금이 아예 없는 것"이다.
    // 이걸 죽었다고 보고 회수하러 가면, 그 찰나에 들어온 새 주인의 잠금을 걷어 간다.
    // (2026-08-11 재현: 사유 "잠금 없음"인데 피해자가 1ms 전에 잡은 살아 있는 주인이었다.)
    if (!fs.existsSync(lockFile)) return { dead: false, missing: true, reason: '잠금 없음' };
    // 완성된 채로만 나타나므로, 못 읽으면 만들어지는 중이 아니라 망가진 것이다
    return { dead: true, owner_nonce: null, reason: '잠금 파일을 읽을 수 없음(손상)' };
  }

  const t = nowMs();
  const expiresAt = effectiveExpiry(lockFile, o);
  const expired = t > expiresAt;
  const alive = pidAlive(o.pid);

  // [단 하나의 회수 조건] 주인 프로세스가 없을 때만 죽은 잠금이다.
  // 살아 있는 주인은 무슨 이유로도 걷지 않는다 — 그래야 주인이 쓰기 도중에 쫓겨나는 일이 없고,
  // 주인이 자기 잠금을 풀 때 그것이 여전히 자기 것임을 믿을 수 있다.
  if (!alive) {
    const age = t - (o.acquired_at ?? 0);
    if (age > GRACE_DEAD_MS) return { dead: true, owner_nonce: o.nonce, reason: `PID ${o.pid} 없음(경과 ${Math.round(age)}ms)` };
    return { dead: false, owner_nonce: o.nonce, reason: `PID 없으나 방금 잡힌 잠금(${Math.round(age)}ms) — 잠시 기다린다` };
  }

  if (!expired) return { dead: false, owner_nonce: o.nonce, reason: '유효' };
  if (t <= expiresAt + GRACE_ALIVE_MS) return { dead: false, owner_nonce: o.nonce, reason: '만료됐으나 유예 안' };
  // 만료 + 유예까지 지났는데 PID 는 살아 있다 — PID 재사용일 수도, 멎은 주인일 수도 있다.
  // 함부로 걷지 않고 사람에게 넘긴다(repair_lock).
  return { dead: false, owner_nonce: o.nonce, reason: `PID ${o.pid} 는 살아 있는데 만료+유예 경과 — repair_lock 대상` };
}

/** 두 경로가 같은 파일인가(같은 장치의 같은 inode). 이름이 아니라 정체를 본다. */
function sameFile(a, b) {
  try {
    const x = fs.statSync(a);
    const y = fs.statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch { return false; }
}

/**
 * 죽은 잠금을 회수한다. 여러 프로세스가 동시에 발견할 수 있으므로
 * 잠금 파일을 고유 이름으로 "원자적으로 이동"하고, 이동에 성공한 쪽만 새 잠금을 시도한다.
 * 이전 잠금은 지우지 않고 stale/ 아래에 남겨 조사할 수 있게 한다.
 */
/**
 * 죽은 잠금을 회수한다.
 *
 * [경주를 한 번으로 줄인다] 잠금 이름을 바로 옮기면, 확인과 옮기기 사이에 다른 회수자가 먼저 옮기고
 * 새 주인이 들어와 그 새 잠금을 뺏을 수 있다. 그래서 먼저 **죽은 주인의 손잡이**를 내 이름으로 옮긴다.
 * rename 은 원자적이라 여럿이 달려들어도 딱 하나만 성공한다. 성공한 쪽만 다음으로 간다.
 * 그다음 "내가 쥔 손잡이와 잠금 이름이 같은 파일인가"를 확인하고, 맞을 때만 잠금 이름을 옮긴다.
 * 죽은 주인은 스스로 풀 수 없으므로, 그 사이에 잠금 이름이 비어 새 주인이 들어올 길이 없다.
 */
export function reapLock(lockFile, staleDir, why = '', ownerNonce = null, { force = false } = {}) {
  fs.mkdirSync(staleDir, { recursive: true });
  const victim = readOwner(lockFile);
  const nonce = ownerNonce ?? victim?.nonce ?? null;
  const dest = path.join(staleDir, `${path.basename(lockFile)}.${crypto.randomBytes(6).toString('hex')}`);
  const note = (obj) => {
    try {
      fs.appendFileSync(path.join(staleDir, 'reaps.jsonl'), JSON.stringify({
        ts: nowMs(), lock: path.basename(lockFile), why,
        by: { pid: process.pid, instance_id: INSTANCE_ID },
        victim: victim ? { pid: victim.pid, acquired_at: victim.acquired_at, expires_at: victim.expires_at } : null,
        ...obj,
      }) + '\n');
    } catch {}
  };

  if (!nonce) {
    // 주인 정보를 못 읽으면 손잡이를 찾을 수 없다. 사람이 시킨 경우에만 이름으로 직접 옮긴다.
    if (!force) return { reaped: false, movedTo: null, why: '주인 정보를 읽을 수 없어 회수하지 않습니다' };
    try { fs.renameSync(lockFile, dest); } catch { return { reaped: false, movedTo: null }; }
    note({ by_force: true });
    return { reaped: true, movedTo: dest };
  }

  const heldPath = `${lockFile}.held.${nonce}`;
  const claim = `${lockFile}.claim.${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.renameSync(heldPath, claim);              // 이 경주에서 이긴 하나만 통과한다
  } catch {
    if (!force) return { reaped: false, movedTo: null, why: '다른 쪽이 먼저 회수 중이거나 손잡이가 없습니다' };
    // 사람이 시킨 경우에는 손잡이가 없어도 이름으로 옮겨 준다
    try { fs.renameSync(lockFile, dest); } catch { return { reaped: false, movedTo: null }; }
    note({ by_force: true });
    return { reaped: true, movedTo: dest };
  }
  if (!sameFile(claim, lockFile)) {              // 그 사이 잠금이 갈렸다 — 남의 것을 건드리지 않는다
    fs.rmSync(claim, { force: true });
    return { reaped: false, movedTo: null, why: '그 사이 주인이 바뀌었습니다' };
  }
  try {
    fs.renameSync(lockFile, dest);
  } catch {
    fs.rmSync(claim, { force: true });
    return { reaped: false, movedTo: null };
  }
  fs.rmSync(claim, { force: true });
  fs.rmSync(beatPath(lockFile, nonce), { force: true });          // 심장 박동 기록도 함께 걷는다
  fs.rmSync(`${beatPath(lockFile, nonce)}.tmp`, { force: true });
  note({});
  return { reaped: true, movedTo: dest };
}

function writeOwnerTmp(lockFile, owner) {
  const tmp = `${lockFile}.tmp.${process.pid}.${owner.nonce}`;
  fs.writeFileSync(tmp, JSON.stringify(owner, null, 2));
  return tmp;
}

/**
 * 잠금을 잡는다. 못 잡으면 null.
 * @returns {{nonce:string, release:Function, valid:Function, renew:Function}|null}
 */
export function tryAcquire(lockFile, staleDir, ttlMs = DEFAULT_TTL_MS, depth = 0) {
  const nonce = crypto.randomUUID();
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const owner = {
    instance_id: INSTANCE_ID,
    pid: process.pid,
    hostname: process.env.HOSTNAME || '',
    acquired_at: nowMs(),
    expires_at: nowMs() + ttlMs,
    nonce,
  };
  // [순서] 손잡이를 먼저 만들고, 그 손잡이를 잠금 이름으로 건다.
  // 이래야 "보이는 잠금에는 반드시 손잡이가 먼저 있다"가 성립하고,
  // 회수자가 그 손잡이를 표로 삼아 단 한 번의 경주로 주인을 가릴 수 있다.
  const tmp = writeOwnerTmp(lockFile, owner);      // 먼저 완성시킨다
  const held = `${lockFile}.held.${nonce}`;
  fs.renameSync(tmp, held);

  try {
    fs.linkSync(held, lockFile);                   // 원자적: 이미 있으면 EEXIST
  } catch (e) {
    fs.rmSync(held, { force: true });
    if (e.code !== 'EEXIST') throw e;
    if (depth >= 2) return null;                   // 몇 번만 더 본다. 무한히 맴돌지 않는다.
    const insp = inspectLock(lockFile);
    // 그 사이 사라졌다면 회수할 것이 없다. 바로 다시 잡아 본다.
    if (insp.missing) return tryAcquire(lockFile, staleDir, ttlMs, depth + 1);
    if (!insp.dead) return null;
    lockBarrier('after_inspect');                  // 시험에서만 멈춘다(경합 순서를 만들기 위해)
    // [정확히 그 주인만] 판정에 쓴 nonce 를 그대로 넘긴다. 여기서 다시 읽으면 그 사이 들어온
    // 살아 있는 새 주인의 손잡이를 잡아 그를 걷어 가게 된다.
    const { reaped } = reapLock(lockFile, staleDir, insp.reason, insp.owner_nonce ?? null);
    if (!reaped) return null;                      // 남이 회수했거나 주인이 바뀌었다 — 다음 시도에서 다시 본다
    return tryAcquire(lockFile, staleDir, ttlMs, depth + 1);
  }

  return {
    nonce,
    // 되살아난 프로세스 방어: 쓰기 직전에 잠금이 여전히 내 것인지 확인한다.
    valid() {
      return sameFile(lockFile, held);
    },
    /**
     * 오래 걸리는 일을 붙들고 있을 때 만료 시각을 밀어 준다.
     * 잠금 파일은 절대 다시 쓰지 않는다 — 정체가 바뀌면 손잡이와 어긋나고,
     * 그 사이에 죽으면 아무도 걷을 수 없는 잠금이 된다. 만료만 옆 파일에 원자적으로 적는다.
     */
    renew(extendMs = ttlMs) {
      if (!sameFile(lockFile, held)) return false;
      const bp = beatPath(lockFile, nonce);
      const t2 = `${bp}.tmp`;
      try {
        fs.writeFileSync(t2, JSON.stringify({ nonce, expires_at: nowMs() + extendMs, at: nowMs() }, null, 2));
        lockFault('renew_after_write');              // 옮기기 전에 죽어도 잠금 정체는 그대로다
        fs.renameSync(t2, bp);
        lockFault('renew_after_rename');
      } catch { try { fs.rmSync(t2, { force: true }); } catch {} return false; }
      return true;
    },
    /**
     * 내 손잡이와 잠금 이름이 "같은 파일"일 때만 잠금 이름을 지운다.
     * 이름을 먼저 옮겨 놓고 확인하면, 이미 회수된 옛 손잡이가 새 주인의 잠금을 치워 버린다.
     * 살아 있는 주인은 회수되지 않으므로(inspectLock), 살아 있는 내가 확인한 정체는 그대로 유지된다.
     */
    release() {
      const mine = sameFile(lockFile, held);
      if (mine) fs.rmSync(lockFile, { force: true });
      fs.rmSync(held, { force: true });
      fs.rmSync(beatPath(lockFile, nonce), { force: true });
      fs.rmSync(`${beatPath(lockFile, nonce)}.tmp`, { force: true });
      return mine;
    },
  };
}

/** 잠금을 잡을 때까지 짧게 재시도한다. 네트워크 대기가 아니라 장부 갱신용이라 대기가 짧다. */
export function acquire(lockFile, staleDir, { ttlMs = DEFAULT_TTL_MS, waitMs = 15_000 } = {}) {
  const deadline = nowMs() + waitMs;
  for (;;) {
    const h = tryAcquire(lockFile, staleDir, ttlMs);
    if (h) return h;
    if (nowMs() > deadline) throw new Error(`잠금 획득 실패(${waitMs}ms 초과): ${lockFile}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 + Math.random() * 30);
  }
}

/** 잠금을 잡고 fn 을 돌린 뒤 반드시 푼다. */
export function withLock(lockFile, staleDir, fn, opts) {
  const h = acquire(lockFile, staleDir, opts);
  try {
    return fn(h);
  } finally {
    h.release();
  }
}

/** 사람이 푸는 통로 — PID 는 살아 있는데 heartbeat 만 멎은 경우 */
export function repairLock(lockFile, staleDir) {
  if (!fs.existsSync(lockFile)) return { ok: true, note: '잠금이 없습니다.' };
  const o = readOwner(lockFile);
  // 사람이 직접 시킨 통로다. 손잡이가 사라졌거나 파일이 망가졌어도 이름으로 옮겨 준다.
  const { reaped, movedTo } = reapLock(lockFile, staleDir, 'repair_lock(사람이 지시)', o?.nonce ?? null, { force: true });
  return { ok: reaped, note: reaped ? `stale 로 옮겼습니다: ${movedTo}` : '이미 다른 쪽이 회수했습니다.', owner: o };
}

export function lockStatus(lockFile) {
  if (!fs.existsSync(lockFile)) return { held: false };
  const o = readOwner(lockFile);
  const v = inspectLock(lockFile);
  return {
    held: true,
    owner: o,
    age_ms: o ? nowMs() - o.acquired_at : null,
    expires_at: o ? effectiveExpiry(lockFile, o) : null,
    expired: o ? nowMs() > effectiveExpiry(lockFile, o) : null,
    pid_alive: o ? pidAlive(o.pid) : null,
    verdict: v.reason,
  };
}
