// papercup 공용 로직 — server.mjs·ear.mjs가 공유 (신원·장부·프레임·암호·발견)
// 설계: _PLAN/2026-07-31-papercup-lan-messenger/PLAN.md §3
// 무의존: node 내장만 (crypto·fs·path·os·net·dgram).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const PROTO = 1;                 // 매직: 발견 패킷의 papercup 필드
export const MAGIC = 'papercup';
export const MAX_FILE = 50 * 1024 * 1024; // 파일 상한 50MB
export const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex'); // raw→spki 복원용

// ── 상태 폴더 (기본 .claude/papercup/, 환경변수로 재지정 — 한 머신 검증용) ──

export function stateDir() {
  if (process.env.PAPERCUP_DIR) return process.env.PAPERCUP_DIR;
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.join(root, '.claude', 'papercup');
}
export function udpPort() {
  return Number(process.env.PAPERCUP_PORT) || 47777;
}
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
function paths() {
  const d = stateDir();
  return {
    dir: d,
    keys: path.join(d, 'keys'),
    profile: path.join(d, 'profile.json'),
    peers: path.join(d, 'peers.json'),
    ear: path.join(d, 'ear.json'),
    inbox: path.join(d, 'inbox.jsonl'),
    files: path.join(d, 'received-files'),
  };
}
export const P = paths;

// ── 신원 (X25519 키쌍 + 지문) ─────────────────────────────────

// 키쌍을 keys/에 보관(없으면 생성). 반환: { privateKey, publicKey(KeyObject), raw(32B), fp }
export function identity() {
  const pp = paths();
  ensureDir(pp.keys);
  const privPath = path.join(pp.keys, 'x25519.priv');
  const pubPath = path.join(pp.keys, 'x25519.pub'); // raw 32B
  let priv, rawPub;
  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    priv = crypto.createPrivateKey({ key: fs.readFileSync(privPath), format: 'der', type: 'pkcs8' });
    rawPub = fs.readFileSync(pubPath);
  } else {
    const kp = crypto.generateKeyPairSync('x25519');
    priv = kp.privateKey;
    rawPub = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    fs.writeFileSync(privPath, priv.export({ type: 'pkcs8', format: 'der' }));
    fs.writeFileSync(pubPath, rawPub);
    fs.chmodSync(privPath, 0o600);
  }
  const publicKey = rawToPub(rawPub);
  return { privateKey: priv, publicKey, raw: rawPub, fp: fingerprint(rawPub) };
}

export function fingerprint(rawPub) {
  return crypto.createHash('sha256').update(rawPub).digest('hex').slice(0, 8);
}
export function fingerprintFull(rawPub) {
  return crypto.createHash('sha256').update(rawPub).digest('hex');
}
export function rawToPub(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' });
}

// ── 문패 (표시 이름, 기본 지문 4자리) ─────────────────────────

export function loadName(fp) {
  const pp = paths();
  try { const p = JSON.parse(fs.readFileSync(pp.profile, 'utf8')); if (p.name) return p.name; } catch { /* 없으면 기본값 */ }
  return fp.slice(0, 4);
}
export function saveName(name) {
  const pp = paths();
  ensureDir(pp.dir);
  fs.writeFileSync(pp.profile, JSON.stringify({ name: name || null }, null, 2));
}

// ── 지문 장부 (TOFU) ──────────────────────────────────────────

export function loadPeers() {
  try { return JSON.parse(fs.readFileSync(paths().peers, 'utf8')); } catch { return {}; }
}
function savePeers(peers) {
  const pp = paths(); ensureDir(pp.dir);
  fs.writeFileSync(pp.peers, JSON.stringify(peers, null, 2));
}
// TOFU 판정. 반환: { ok, status:'new'|'known'|'mismatch', known? }
export function tofu(fp, { name, addr } = {}) {
  const peers = loadPeers();
  const prev = peers[fp];
  if (prev && prev.fp === fp) {
    // 지문은 키가 열쇠라 fp가 곧 신원 — 여기 도달=일치. 주소·이름만 갱신.
    peers[fp] = { ...prev, name: name || prev.name, addr: addr || prev.addr, last_seen: nowStr() };
    savePeers(peers);
    return { ok: true, status: 'known', known: peers[fp] };
  }
  peers[fp] = { fp, name: name || fp.slice(0, 4), addr: addr || null, first_seen: nowStr(), last_seen: nowStr() };
  savePeers(peers);
  return { ok: true, status: 'new', known: peers[fp] };
}
// 이름 또는 지문 앞자리로 상대 찾기
export function findPeer(to) {
  const peers = loadPeers();
  const byFp = Object.values(peers).find((p) => p.fp === to || p.fp.startsWith(to));
  if (byFp) return byFp;
  return Object.values(peers).find((p) => p.name === to) || null;
}

// ── 발견 패킷 ─────────────────────────────────────────────────

export function discoveryPacket(kind, self, tcpPort) {
  // kind: 'want'(방송) | 'here'(응답). self = identity() 결과.
  return JSON.stringify({
    [MAGIC]: PROTO, kind, name: loadName(self.fp), fp: self.fp,
    pub: self.raw.toString('base64'), tcp: tcpPort,
  });
}
export function parseDiscovery(buf) {
  let m;
  try { m = JSON.parse(buf.toString('utf8')); } catch { return null; }
  if (m[MAGIC] !== PROTO || !m.fp || !m.pub) return null; // 모르는 형식·버전은 침묵
  return m;
}

// ── 세션 암호 (ECDH → HKDF → AES-256-GCM) ─────────────────────

export function sessionKey(myPriv, peerRawPub) {
  const shared = crypto.diffieHellman({ privateKey: myPriv, publicKey: rawToPub(peerRawPub) });
  return crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('papercup-v1'), 32);
}
export function seal(key, plainBuf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), iv);
  const ct = Buffer.concat([c.update(plainBuf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]); // [12 iv][16 tag][ct]
}
export function open(key, blob) {
  const iv = blob.subarray(0, 12), tag = blob.subarray(12, 28), ct = blob.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// ── 길이 머리말 프레임 (TCP) ──────────────────────────────────

export function frame(buf) {
  const len = Buffer.alloc(4); len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}
// 스트림에서 프레임 하나씩 뽑는 누적기. onFrame(buf) 콜백.
export function frameReader(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      onFrame(buf.subarray(4, 4 + len));
      buf = buf.subarray(4 + len);
    }
  };
}

// ── 수신함 장부 ───────────────────────────────────────────────

export function inboxAppend(rec) {
  const pp = paths(); ensureDir(pp.dir);
  const all = inboxAll();
  const no = all.length ? Math.max(...all.map((r) => r.no)) + 1 : 1;
  const full = { no, at: nowStr(), read: false, ...rec };
  fs.appendFileSync(pp.inbox, JSON.stringify(full) + '\n');
  return full;
}
export function inboxAll() {
  try {
    return fs.readFileSync(paths().inbox, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
export function inboxRewrite(recs) {
  const pp = paths(); ensureDir(pp.dir);
  fs.writeFileSync(pp.inbox, recs.map((r) => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : ''));
}

// ── 파일명 소독 (저장 폴더 밖 탈출 불가) ──────────────────────

export function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[/\\]/g, '_').replace(/^\.+/, '');
  return base || 'file';
}
export function receivedFilesDir() { return ensureDir(paths().files); }

// ── 유틸 ──────────────────────────────────────────────────────

export function nowStr() {
  // 로컬 시각 문자열. (Date는 여기선 표시용 — 검증 로직은 값 비교로 결정)
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}
export function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
export function broadcastAddrs() {
  // 방송 대상 — 각 인터페이스의 서브넷 브로드캐스트(예: 172.30.1.255) + 제한 브로드캐스트.
  // macOS는 255.255.255.255를 같은 호스트의 다른 프로세스로 fan-out하지 않아, 서브넷 주소가 필수
  // (2026-08-01 G1 실측). 두 대상 모두로 보내 로컬 검증과 실제 LAN 양쪽을 만족시킨다.
  const outs = [];
  for (const i of Object.values(os.networkInterfaces()).flat()) {
    if (!i || i.family !== 'IPv4' || i.internal) continue;
    const ip = i.address.split('.').map(Number), m = i.netmask.split('.').map(Number);
    outs.push(ip.map((o, k) => (o & m[k]) | (~m[k] & 255)).join('.'));
  }
  outs.push('255.255.255.255');
  return [...new Set(outs)];
}
export function localAddrs() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}
