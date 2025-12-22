#!/usr/bin/env node
'use strict';

const net = require('net');
const { Encoder, Decoder } = require('cbor-x');

/**
 * Cardano Node-to-Node:
 * - Handshake mini-protocol number: 0
 * - ChainSync mini-protocol number: 2   [oai_citation:5‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
 * - PeerSharing mini-protocol number: 10  [oai_citation:6‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
 *
 * Mux SDU header (8 bytes):  [oai_citation:7‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
 *   word32 transmissionTime
 *   word32: (modeBit<<31) | (miniProtocolId<<16) | length
 *   modeBit: 0 = initiator, 1 = responder
 *   length: uint16
 */

const MAINNET_MAGIC = 764824073;

const MP = {
  HANDSHAKE: 0,
  CHAINSYNC: 2,
  PEERSHARE: 10,
};

const enc = new Encoder({ useRecords: false });
const dec = new Decoder({ useRecords: false });

function now32() {
  // good enough for mux "transmission time" field
  return (Date.now() >>> 0);
}

function muxHeader({ modeBit, miniProtocolId, length }) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(now32(), 0);
  const word2 = ((modeBit & 1) << 31) | ((miniProtocolId & 0x7fff) << 16) | (length & 0xffff);
  buf.writeUInt32BE(word2 >>> 0, 4);
  return buf;
}

function packSegment(miniProtocolId, modeBit, payloadBuf) {
  if (!Buffer.isBuffer(payloadBuf)) payloadBuf = Buffer.from(payloadBuf);
  if (payloadBuf.length > 0xffff) throw new Error(`payload too big for mux uint16 length: ${payloadBuf.length}`);
  const header = muxHeader({ modeBit, miniProtocolId, length: payloadBuf.length });
  return Buffer.concat([header, payloadBuf]);
}

class MuxReader {
  constructor(onSegment) {
    this.onSegment = onSegment;
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const t = this.buf.readUInt32BE(0);
      const w2 = this.buf.readUInt32BE(4);
      const modeBit = (w2 >>> 31) & 1;
      const miniProtocolId = (w2 >>> 16) & 0x7fff;
      const length = w2 & 0xffff;

      if (this.buf.length < 8 + length) return;

      const payload = this.buf.subarray(8, 8 + length);
      this.buf = this.buf.subarray(8 + length);
      this.onSegment({ t, modeBit, miniProtocolId, payload });
    }
  }
}

function ipv4FromWord32(w) {
  // peerSharing uses base.word32 for IPv4  [oai_citation:8‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
  return [
    (w >>> 24) & 0xff,
    (w >>> 16) & 0xff,
    (w >>> 8) & 0xff,
    w & 0xff,
  ].join('.');
}

function parsePeerAddresses(peerAddresses) {
  // peerAddress =
  //  [0, word32, port] (ipv4)
  //  [1, w32, w32, w32, w32, port] (ipv6)
  //  [oai_citation:9‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
  const out = [];
  for (const a of peerAddresses || []) {
    if (!Array.isArray(a) || a.length < 3) continue;
    const tag = a[0];
    if (tag === 0 && a.length === 3) {
      const ip = ipv4FromWord32(a[1] >>> 0);
      const port = a[2] >>> 0;
      out.push({ ip, port });
    } else if (tag === 1 && a.length === 6) {
      // IPv6 words -> hex groups (best-effort)
      const words = a.slice(1, 5).map(x => (x >>> 0).toString(16).padStart(8, '0'));
      const ip = words.join(':'); // not fully normalized, but workable as an address string
      const port = a[5] >>> 0;
      out.push({ ip, port });
    }
  }
  return out;
}

function prettyTip(tip) {
  // In the network spec, 'tip' is left as 'any' at the common layer  [oai_citation:10‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
  // On Cardano this is often something like [slotNo, headerHash, blockNo], but we keep it robust.
  if (Array.isArray(tip) && tip.length === 3 && typeof tip[0] === 'number' && Buffer.isBuffer(tip[1]) && typeof tip[2] === 'number') {
    return {
      slot: tip[0],
      hashHex: tip[1].toString('hex'),
      blockNo: tip[2],
    };
  }
  return tip;
}

function connectAndFetchTip({ host, port }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      // Handshake: MsgProposeVersions = [0, versionTable]  [oai_citation:11‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
      // Node-to-node version data record contains:
      //  networkMagic (word32), diffusionMode (bool), peerSharing (0/1), query (bool)  [oai_citation:12‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
      const mkVData = (peerSharing, diffusionMode, query) => [MAINNET_MAGIC, !!diffusionMode, peerSharing ? 1 : 0, !!query];

      // Offer both 15 and 14 (server picks highest common)  [oai_citation:13‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
      const versionTable = new Map([
        [15, mkVData(true, false, false)],
        [14, mkVData(true, false, false)],
      ]);

      const propose = [0, versionTable];
      const proposeBuf = Buffer.from(enc.encode(propose));

      // Handshake runs before mux is "initialised" but still uses a mux segment header and must fit in one segment  [oai_citation:14‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
      socket.write(packSegment(MP.HANDSHAKE, 0, proposeBuf));
    });

    socket.setNoDelay(true);

    const state = {
      handshakeDone: false,
      negotiatedVersion: null,
      peers: [],
      gotTip: false,
    };

    const kill = (err) => {
      try { socket.destroy(); } catch (_) {}
      if (err) reject(err);
    };

    const timeout = setTimeout(() => {
      kill(new Error('Timeout waiting for handshake/tip (peer may not like our handshake or mux framing).'));
    }, 15000);

    const mux = new MuxReader(({ modeBit, miniProtocolId, payload }) => {
      let msg;
      try { msg = dec.decode(payload); } catch (e) { return kill(new Error(`CBOR decode failed on miniProtocol ${miniProtocolId}: ${e.message}`)); }

      // ---- Handshake responder -> our initiator ----
      if (miniProtocolId === MP.HANDSHAKE) {
        // msgAcceptVersion = [1, versionNumber_v14, v14.nodeToNodeVersionData]  [oai_citation:15‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
        // msgRefuse        = [2, refuseReason]
        // msgQueryReply     = [3, versionTable]
        if (!Array.isArray(msg) || msg.length < 1) return;
        const tag = msg[0];

        if (tag === 1) {
          state.handshakeDone = true;
          state.negotiatedVersion = msg[1];

          // 1) PeerSharing request (optional mini-protocol 10)  [oai_citation:16‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
          // msgShareRequest = [0, base.word8]   [oai_citation:17‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
          const wantPeers = 8;
          const psReq = [0, wantPeers];
          socket.write(packSegment(MP.PEERSHARE, 0, Buffer.from(enc.encode(psReq))));

          // 2) ChainSync: Ask for tip via FindIntersect with empty points.
          // msgFindIntersect = [4, base.points]  [oai_citation:18‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
          // If points is empty: server replies MsgIntersectNotFound(tip)  [oai_citation:19‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
          const findIntersect = [4, []];
          socket.write(packSegment(MP.CHAINSYNC, 0, Buffer.from(enc.encode(findIntersect))));
          return;
        }

        if (tag === 2) {
          return kill(new Error(`Handshake refused: ${JSON.stringify(msg)}`));
        }

        // ignore tag 3 here (query reply)
        return;
      }

      // ---- PeerSharing ----
      if (miniProtocolId === MP.PEERSHARE) {
        // msgSharePeers = [1, peerAddresses]  [oai_citation:20‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
        if (Array.isArray(msg) && msg[0] === 1) {
          const peers = parsePeerAddresses(msg[1]);
          state.peers.push(...peers);
          return;
        }
        return;
      }

      // ---- ChainSync ----
      if (miniProtocolId === MP.CHAINSYNC) {
        // MsgIntersectNotFound = [5, tip]  [oai_citation:21‡Ouroboros Network](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
        // MsgIntersectFound    = [6, point, tip]
        if (Array.isArray(msg) && (msg[0] === 5 || msg[0] === 6)) {
          const tip = (msg[0] === 5) ? msg[1] : msg[2];
          state.gotTip = true;
          clearTimeout(timeout);
          socket.end();

          resolve({
            host, port,
            negotiatedVersion: state.negotiatedVersion,
            peersDiscovered: state.peers,
            tip: prettyTip(tip),
            tipRaw: tip,
          });
          return;
        }

        // If you hit other ChainSync messages, print them for debugging
        return;
      }
    });

    socket.on('data', (chunk) => mux.push(chunk));
    socket.on('error', (e) => kill(e));
    socket.on('end', () => {
      if (!state.gotTip) {
        clearTimeout(timeout);
        kill(new Error('Socket ended before receiving tip.'));
      }
    });
  });
}

// ---- CLI ----
const args = process.argv.slice(2);
const getArg = (k, def) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : def;
};

const host = getArg('--host', process.env.CARDANO_PEER || '3.125.75.199');
const port = Number(getArg('--port', process.env.CARDANO_PORT || '3001'));

connectAndFetchTip({ host, port })
  .then((r) => {
    console.log(JSON.stringify({
      peer: `${r.host}:${r.port}`,
      negotiatedVersion: r.negotiatedVersion,
      tip: r.tip,
      peersDiscovered: r.peersDiscovered.slice(0, 30),
      peersDiscoveredCount: r.peersDiscovered.length,
    }, null, 2));
    process.exit(0);
  })
  .catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
  });