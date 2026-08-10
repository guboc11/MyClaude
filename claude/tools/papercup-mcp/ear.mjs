// papercup 귀 — 방송 응답 + 악수 수신 + 기록. detached 장기 실행.
// 설계: _PLAN/2026-07-31-papercup-lan-messenger/PLAN.md §3
//
// 하는 일은 셋뿐 — ① 매직 방송에 유니캐스트 응답 ② TCP 악수 수신측 ③ 받은 것을 파일에 기록.
// 자동 행동 없음: 어떤 메시지·파일도 실행하지 않는다. 로그는 stderr.

import dgram from 'node:dgram';
import net from 'node:net';
import fs from 'node:fs';
import * as L from './lib.mjs';

const log = (...a) => process.stderr.write(`[papercup-ear] ${a.join(' ')}\n`);
const self = L.identity();
const UDP_PORT = L.udpPort();

// ── TCP 서버 (악수 수신측) ────────────────────────────────────

const tcp = net.createServer((sock) => {
  let key = null;
  let step = 'hello'; // hello(공개키 받기) → data(프레임)
  const read = L.frameReader((buf) => {
    try {
      if (step === 'hello') {
        // 첫 프레임 = 상대 공개키(raw 32B) + 상대 지문·이름 JSON
        const hello = JSON.parse(buf.toString('utf8'));
        const peerRaw = Buffer.from(hello.pub, 'base64');
        const fp = L.fingerprint(peerRaw);
        const addr = sock.remoteAddress?.replace(/^::ffff:/, '');
        const peers = L.loadPeers();
        const prev = peers[fp];
        // TOFU: 지문은 키가 열쇠라 fp 자체가 신원. hello.fp가 실제 공개키와 어긋나면 사칭.
        if (hello.fp !== fp) { log('지문 위조 — 끊음'); sock.end(); return; }
        if (prev && prev.fp !== fp) { log('지문 불일치 — 끊음'); sock.end(); return; }
        L.tofu(fp, { name: hello.name, addr });
        if (!prev) log(`새 상대 기억: ${hello.name} (지문 ${fp})`);
        // 내 공개키 회신
        key = L.sessionKey(self.privateKey, peerRaw);
        sock.write(L.frame(Buffer.from(JSON.stringify({ name: L.loadName(self.fp), fp: self.fp, pub: self.raw.toString('base64') }))));
        step = 'data';
        sock._pcpeer = { fp, name: hello.name || fp.slice(0, 4) };
      } else {
        // 암호화 프레임
        const plain = L.open(key, buf);
        const head = readHead(plain); // {type, ...} + 남은 바이트 오프셋
        const peer = sock._pcpeer;
        if (head.msg.type === 'text') {
          L.inboxAppend({ kind: 'text', from: peer.name, fp: peer.fp, text: head.msg.text });
          sock.write(L.frame(L.seal(key, Buffer.from(JSON.stringify({ ack: true })))));
          log(`텍스트 수신: ${peer.name}`);
        } else if (head.msg.type === 'file') {
          const body = plain.subarray(head.offset);
          const okHash = L.sha256(body) === head.msg.sha256;
          const name = L.safeName(head.msg.name);
          let dest = `${L.receivedFilesDir()}/${name}`;
          let n = 2;
          while (fs.existsSync(dest)) { dest = `${L.receivedFilesDir()}/${name.replace(/(\.[^.]*)?$/, `-${n}$1`)}`; n++; }
          fs.writeFileSync(dest, body); // 저장만 — 해제·실행 없음
          L.inboxAppend({ kind: 'file', from: peer.name, fp: peer.fp, file: dest.replace(L.P().dir + '/', ''), size: body.length, hash_ok: okHash });
          sock.write(L.frame(L.seal(key, Buffer.from(JSON.stringify({ ack: true, hash_ok: okHash })))));
          log(`파일 수신: ${peer.name} → ${name} (${body.length}B, 해시 ${okHash ? '일치' : '불일치'})`);
        }
      }
    } catch (e) { log('수신 처리 오류:', e.message); sock.end(); }
  });
  sock.on('data', read);
  sock.on('error', () => {});
});

// head = 4바이트 JSON 길이 + JSON + (파일이면) 바이트 본문
function readHead(plain) {
  const hlen = plain.readUInt32BE(0);
  const msg = JSON.parse(plain.subarray(4, 4 + hlen).toString('utf8'));
  return { msg, offset: 4 + hlen };
}

// ── UDP (발견 응답) ───────────────────────────────────────────

const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udp.on('message', (buf, rinfo) => {
  const m = L.parseDiscovery(buf);
  if (!m || m.kind !== 'want') return;       // 모르는 형식·응답패킷은 침묵
  if (m.fp === self.fp) return;              // 내 방송 메아리 무시
  const reply = Buffer.from(L.discoveryPacket('here', self, tcp.address().port));
  udp.send(reply, rinfo.port, rinfo.address); // 방송한 상대에게만 유니캐스트
});

// ── 기동 ──────────────────────────────────────────────────────

tcp.listen(0, () => {                          // TCP 포트는 OS 배정(발견 응답에 실어 보냄)
  udp.bind(UDP_PORT, () => {
    try { udp.setBroadcast(true); } catch {}
    const rec = { pid: process.pid, udp: UDP_PORT, tcp: tcp.address().port, fp: self.fp, name: L.loadName(self.fp) };
    fs.writeFileSync(L.P().ear, JSON.stringify(rec, null, 2));
    log(`귀 열림 — 이름 ${rec.name} 지문 ${self.fp} · UDP ${UDP_PORT} · TCP ${rec.tcp}`);
  });
});

function shutdown() {
  try { fs.unlinkSync(L.P().ear); } catch {}
  try { udp.close(); } catch {}
  try { tcp.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
