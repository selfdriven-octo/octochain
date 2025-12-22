#!/usr/bin/env node
'use strict';

/**
 * Pure-JS Cardano mainnet TIP via Ouroboros NtN + Mux + ChainSync (no cardano-node).
 *
 * Usage:
 *   npm i cbor-x
 *   node ./chainsync-tip.cjs --host 3.125.75.199 --port 3001
 *
 * Notes:
 * - This targets PUBLIC RELAYS (node-to-node) on port 3001.
 * - Node-to-client is NOT what internet relays speak.
 */

const net = require('net');
const { Decoder, Encoder } = require('cbor-x');

// ---- CLI ----
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

const HOST = arg('--host', '127.0.0.1');
const PORT = parseInt(arg('--port', '3001'), 10);

// Cardano MAINNET network magic is 764824073 (Word32).
// (This is stable and widely used; if you want, make it configurable.)
const NETWORK_MAGIC = parseInt(arg('--magic', '764824073'), 10);

// If set to 1, we propose peer sharing willingness in handshake and then send a peer-sharing request.
// Many relays may ignore/disable peer sharing; it’s optional.
const WANT_PEER_SHARING = arg('--peer-sharing', '0') === '1';

// Keep small timeouts so “hangs” become explicit errors.
const TIMEOUT_MS = parseInt(arg('--timeout', '12000'), 10);

const enc = new Encoder({ useRecords: false });
const dec = new Decoder({ useRecords: false });

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

/**
 * Mux SDU header (8 bytes), big-endian bit order:
 * - 32-bit Transmission Time (lower 32 bits of monotonic clock micros; can be 0)
 * - 1-bit Mode (0 initiator, 1 responder)
 * - 15-bit Mini Protocol ID
 * - 16-bit Payload Length (bytes)
 */
function muxFrame(miniProtocolId, mode /*0|1*/, payload) {
  if (miniProtocolId < 0 || miniProtocolId > 0x7fff) throw new Error('miniProtocolId out of range');
  if (payload.length > 0xffff) throw new Error('payload too large for single mux segment');

  const transmissionTime = 0; // ok for a simple client
  const word0 = u32be(transmissionTime);

  // Pack: [Mode:1][MiniProtocolId:15][Length:16] into a 32-bit word
  const word1 =
    ((mode & 1) << 31) |
    ((miniProtocolId & 0x7fff) << 16) |
    (payload.length & 0xffff);

  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(word1 >>> 0, 0);

  return Buffer.concat([word0, hdr, payload]);
}

// ---- Minimal stream reader for mux frames ----
class MuxReader {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    socket.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this._pump();
    });
    socket.on('close', () => this._failAll(new Error('socket closed')));
    socket.on('error', (e) => this._failAll(e));
  }

  _failAll(err) {
    while (this.waiters.length) this.waiters.shift().reject(err);
  }

  _pump() {
    while (true) {
      if (this.buf.length < 8) return;

      const transmissionTime = this.buf.readUInt32BE(0);
      const word1 = this.buf.readUInt32BE(4);

      const mode = (word1 >>> 31) & 1;
      const miniProtocolId = (word1 >>> 16) & 0x7fff;
      const len = word1 & 0xffff;

      if (this.buf.length < 8 + len) return;

      const payload = this.buf.subarray(8, 8 + len);
      this.buf = this.buf.subarray(8 + len);

      const waiterIndex = this.waiters.findIndex((w) => w.filter(miniProtocolId, mode));
      if (waiterIndex >= 0) {
        const w = this.waiters.splice(waiterIndex, 1)[0];
        w.resolve({ transmissionTime, mode, miniProtocolId, payload });
      } else {
        // No one is waiting for this mini-protocol. Drop it.
        // (In real impl, you’d route per mini-protocol.)
      }
    }
  }

  readFrame(filter, timeoutMs) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('timeout waiting for mux frame'));
      }, timeoutMs);

      this.waiters.push({
        filter,
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });

      this._pump();
    });
  }
}

function decodeCbor(buf) {
  try {
    return dec.decode(buf);
  } catch (e) {
    return { _decodeError: String(e), _hex: buf.toString('hex') };
  }
}

function toHex(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('hex') : Buffer.from(buf).toString('hex');
}

// ---- Mini-protocol IDs (NtN) ----
// Handshake: 0
// ChainSync: 2
// PeerSharing: 10
// (from the spec table)  [oai_citation:5‡ouroboros-network.cardano.intersectmbo.org](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
const MP_HANDSHAKE = 0;
const MP_CHAINSYNC = 2;
const MP_PEERSHARE = 10;

// ---- Handshake (Node-to-Node) ----
// Supported NtN versions: 14, 15  [oai_citation:6‡ouroboros-network.cardano.intersectmbo.org](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
// msgProposeVersions = [0, { versionNumber => versionData, ... }]  [oai_citation:7‡ouroboros-network.cardano.intersectmbo.org](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
//
// versionData fields: networkMagic, diffusionMode, peerSharing, query  [oai_citation:8‡ouroboros-network.cardano.intersectmbo.org](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
function handshakePropose() {
  const diffusionMode = false; // initiator+responder mode (fine for a client)
  const peerSharing = WANT_PEER_SHARING ? 1 : 0; // 0 or 1  [oai_citation:9‡ouroboros-network.cardano.intersectmbo.org](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
  const query = false;

  // In practice you propose the newest first. We'll offer both 15 and 14.
  const versionTable = {
    15: [NETWORK_MAGIC >>> 0, diffusionMode, peerSharing, query],
    14: [NETWORK_MAGIC >>> 0, diffusionMode, peerSharing, query],
  };

  return [0, versionTable];
}

async function run() {
  const socket = net.connect({ host: HOST, port: PORT });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(t);
      resolve();
    });
    socket.once('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });

  const mux = new MuxReader(socket);

  // ---- Send Handshake Propose ----
  const hsMsg = handshakePropose();
  const hsPayload = enc.encode(hsMsg);
  socket.write(muxFrame(MP_HANDSHAKE, 0, hsPayload));

  // ---- Read Handshake response on MP_HANDSHAKE, responder mode=1 ----
  const hsResp = await mux.readFrame((mp, mode) => mp === MP_HANDSHAKE && mode === 1, TIMEOUT_MS);
  const hsObj = decodeCbor(hsResp.payload);

  // Expected: msgAcceptVersion = [1, versionNumber, versionData]  [oai_citation:10‡ouroboros-network.cardano.intersectmbo.org](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
  if (!Array.isArray(hsObj) || hsObj.length < 1) throw new Error('bad handshake response');
  if (hsObj[0] === 2) {
    throw new Error(`handshake refused: ${JSON.stringify(hsObj)}`);
  }
  if (hsObj[0] !== 1) {
    throw new Error(`unexpected handshake response tag ${hsObj[0]}: ${JSON.stringify(hsObj)}`);
  }

  const negotiatedVersion = hsObj[1];
  const negotiatedData = hsObj[2];

  // ---- ChainSync: MsgFindIntersect ----
  // msgFindIntersect = [4, base.points]  [oai_citation:11‡ouroboros-network.cardano.intersectmbo.org](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
  // We'll send [] points; producer should reply IntersectNotFound with its tip.
  const findIntersect = [4, []];
  socket.write(muxFrame(MP_CHAINSYNC, 0, enc.encode(findIntersect)));

  // Wait for either IntersectFound or IntersectNotFound on chain-sync (responder mode=1)
  // msgIntersectFound = [5, point, tip]
  // msgIntersectNotFound = [6, tip]  [oai_citation:12‡ouroboros-network.cardano.intersectmbo.org](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
  const csResp = await mux.readFrame((mp, mode) => mp === MP_CHAINSYNC && mode === 1, TIMEOUT_MS);
  const csObj = decodeCbor(csResp.payload);

  let tip = null;
  if (Array.isArray(csObj) && csObj[0] === 6) {
    tip = csObj[1];
  } else if (Array.isArray(csObj) && csObj[0] === 5) {
    tip = csObj[2];
  } else {
    throw new Error(`unexpected ChainSync response: ${JSON.stringify(csObj)}`);
  }

  // ---- Optional: Peer Sharing request for discovery ----
  // peerSharingMessage:
  // msgShareRequest = [0, word8]
  // msgSharePeers = [1, peerAddresses]
  // msgDone = [2]
  // peerAddress = [0, word32, portNumber] (ipv4) / [1, w32,w32,w32,w32, portNumber] (ipv6)  [oai_citation:13‡ouroboros-network.cardano.intersectmbo.org](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
  let peers = [];
  if (WANT_PEER_SHARING) {
    try {
      // ask for up to N peers (word8)
      const reqN = 25;
      socket.write(muxFrame(MP_PEERSHARE, 0, enc.encode([0, reqN])));

      const psResp = await mux.readFrame((mp, mode) => mp === MP_PEERSHARE && mode === 1, TIMEOUT_MS);
      const psObj = decodeCbor(psResp.payload);

      if (Array.isArray(psObj) && psObj[0] === 1 && Array.isArray(psObj[1])) {
        peers = psObj[1].map((addr) => {
          if (!Array.isArray(addr)) return { raw: addr };
          if (addr[0] === 0) {
            // ipv4: [0, word32, port]
            const ipNum = addr[1] >>> 0;
            const ip = [
              (ipNum >>> 24) & 255,
              (ipNum >>> 16) & 255,
              (ipNum >>> 8) & 255,
              ipNum & 255,
            ].join('.');
            return { ip, port: addr[2] };
          }
          if (addr[0] === 1) {
            // ipv6: [1, w32,w32,w32,w32, port]
            const parts = addr.slice(1, 5).map((w) => (w >>> 0).toString(16).padStart(8, '0'));
            // not perfect formatting, but workable
            const ip = parts.join(':');
            return { ip, port: addr[5] };
          }
          return { raw: addr };
        });
      }
    } catch (e) {
      // Peer sharing is optional; ignore if not supported by that relay.
    }
  }

  // Output
  console.log(JSON.stringify({
    peer: { host: HOST, port: PORT },
    handshake: { version: negotiatedVersion, versionData: negotiatedData },
    tipDecoded: tip,              // tip is "any" in spec, depends on Cardano-era types  [oai_citation:14‡ouroboros-network.cardano.intersectmbo.org](https://ouroboros-network.cardano.intersectmbo.org/pdfs/network-spec/network-spec.pdf)
    tipCborHex: toHex(enc.encode(tip)),
    discoveredPeers: peers,
  }, null, 2));

  socket.destroy();
}

run().catch((e) => {
  console.error('Error:', e && e.stack ? e.stack : e);
  process.exit(1);
});