// papercup 송신부 — peer_send·peer_send_file. 한 호출에 발견→접속→악수→전송→확인→끊기 완결.
// 설계: _PLAN/2026-07-31-papercup-lan-messenger/PLAN.md §3
// 연결 상태를 들고 다니지 않는다 — 편지 한 통이 지나가는 동안만 연결이 존재한다.

import dgram from 'node:dgram';
import net from 'node:net';
import fs from 'node:fs';
import * as L from './lib.mjs';

const DISCOVER_MS = 3000;
const SEND_MS = 60000;

// 상대 찾기: 장부의 최근 주소 우선, 없거나 밝혀야 하면 방송 재발견.
// 반환: { addr, tcp, fp, name, pub(raw) } | null
function discover(to) {
  return new Promise((resolve) => {
    const self = L.identity();
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; try { udp.close(); } catch {} resolve(v); } };
    udp.on('message', (buf, rinfo) => {
      const m = L.parseDiscovery(buf);
      if (!m || m.kind !== 'here' || m.fp === self.fp) return;
      // to가 지정됐으면 그 상대만
      if (to && !(m.fp === to || m.fp.startsWith(to) || m.name === to)) return;
      finish({ addr: rinfo.address, tcp: m.tcp, fp: m.fp, name: m.name, pub: Buffer.from(m.pub, 'base64') });
    });
    udp.bind(0, () => {
      udp.setBroadcast(true);
      const pkt = Buffer.from(L.discoveryPacket('want', self, 0));
      for (const a of L.broadcastAddrs()) udp.send(pkt, L.udpPort(), a);
      setTimeout(() => finish(null), DISCOVER_MS);
    });
  });
}

// payload = 프레임 본문 평문 [4바이트 헤더길이][헤더 JSON][바이트 본문(파일)]
function makePayload(head, body) {
  const h = Buffer.from(JSON.stringify(head));
  const hlen = Buffer.alloc(4); hlen.writeUInt32BE(h.length, 0);
  return body ? Buffer.concat([hlen, h, body]) : Buffer.concat([hlen, h]);
}

// 악수 + 한 프레임 전송 + ack 대기. 성공/실패 객체 반환.
function deliver(peer, payload) {
  return new Promise((resolve) => {
    const self = L.identity();
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { sock.end(); } catch {} resolve(v); } };
    const timer = setTimeout(() => done({ ok: false, step: 'timeout', detail: `${SEND_MS / 1000}초 무응답` }), SEND_MS);

    const sock = net.connect(peer.tcp, peer.addr, () => {
      // hello: 내 공개키·지문·이름
      sock.write(L.frame(Buffer.from(JSON.stringify({ name: L.loadName(self.fp), fp: self.fp, pub: self.raw.toString('base64') }))));
    });
    let key = null, step = 'hello';
    const read = L.frameReader((buf) => {
      try {
        if (step === 'hello') {
          const hello = JSON.parse(buf.toString('utf8'));
          const peerRaw = Buffer.from(hello.pub, 'base64');
          const fp = L.fingerprint(peerRaw);
          // TOFU: 발견 때 본 지문과 악수 응답의 실제 공개키가 일치해야
          if (hello.fp !== fp || (peer.fp && peer.fp !== fp)) {
            clearTimeout(timer); return done({ ok: false, step: 'handshake', detail: `지문 불일치 (기대 ${peer.fp}, 실제 ${fp})` });
          }
          const prev = L.loadPeers()[fp];
          if (prev && prev.fp !== fp) { clearTimeout(timer); return done({ ok: false, step: 'handshake', detail: '지문 불일치(장부)' }); }
          L.tofu(fp, { name: hello.name, addr: peer.addr });
          key = L.sessionKey(self.privateKey, peerRaw);
          sock.write(L.frame(L.seal(key, payload)));
          step = 'wait';
        } else {
          const ack = JSON.parse(L.open(key, buf).toString('utf8'));
          clearTimeout(timer);
          done({ ok: true, ack, peer: { fp: peer.fp, name: peer.name } });
        }
      } catch (e) { clearTimeout(timer); done({ ok: false, step, detail: e.message }); }
    });
    sock.on('data', read);
    sock.on('error', (e) => { clearTimeout(timer); done({ ok: false, step: 'connect', detail: e.message }); });
  });
}

// 상대 해석: 장부 최근 주소로 곧장 시도할 수도 있으나, 주소·TCP포트·공개키가 필요하므로
// 항상 발견을 거친다(재발견이 곧 IP 갱신). 장부는 to 이름→지문 힌트로만 쓴다.
async function resolvePeer(to) {
  const hint = to ? (L.findPeer(to)?.fp || to) : null;
  return discover(hint);
}

export async function peerSend({ to, text }) {
  if (!to) return '보낼 상대(to)가 필요합니다 — 문패 또는 지문 앞자리.';
  if (!text) return '보낼 text가 필요합니다.';
  const peer = await resolvePeer(to);
  if (!peer) return `상대를 찾지 못했습니다: "${to}" — 상대 귀가 닫혀 있거나 다른 네트워크입니다 (peer_list로 확인).`;
  const r = await deliver(peer, makePayload({ type: 'text', text }));
  if (!r.ok) return `전송 실패 (${r.step}): ${r.detail}`;
  return `보냄 → ${peer.name} (지문 ${peer.fp}). 상대 수신함에 기록됨.`;
}

export async function peerSendFile({ to, path: filePath }) {
  if (!to) return '보낼 상대(to)가 필요합니다.';
  if (!filePath) return '보낼 파일 경로(path)가 필요합니다.';
  if (!fs.existsSync(filePath)) return `파일 없음: ${filePath}`;
  const body = fs.readFileSync(filePath);
  if (body.length > L.MAX_FILE) return `파일이 상한(50MB)을 넘습니다: ${(body.length / 1048576).toFixed(1)}MB`;
  const peer = await resolvePeer(to);
  if (!peer) return `상대를 찾지 못했습니다: "${to}" (peer_list로 확인).`;
  const name = L.safeName(filePath.split('/').pop());
  const head = { type: 'file', name, size: body.length, sha256: L.sha256(body) };
  const r = await deliver(peer, makePayload(head, body));
  if (!r.ok) return `파일 전송 실패 (${r.step}): ${r.detail}`;
  const hashNote = r.ack?.hash_ok === false ? ' ⚠ 상대 측 해시 불일치' : ' 해시 일치';
  return `파일 보냄 → ${peer.name}: ${name} (${(body.length / 1024).toFixed(0)}KB).${hashNote}`;
}
