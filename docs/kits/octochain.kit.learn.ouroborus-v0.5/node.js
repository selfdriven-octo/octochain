
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createServer, connectToPeers, broadcast, send } = require('./lib/network');
const { makeGenesis, forgeBlock, validateBlock, isEligible, thresholdFor, MAX256 } = require('./lib/consensus');
const { pubkeyToAddress, txidOf, validateTx, applyTx, makeCoinbase } = require('./lib/tx');
const { sha256_hex } = require('./lib/block');

// --- CLI args (CommonJS) ---
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i+1];
  return def;
}

const PORT     = parseInt(getArg('port', '4001'), 10);
const NAME     = getArg('name', `N${PORT}`);
const STAKE    = parseInt(getArg('stake', '500'), 10);
const PEERS    = (getArg('peers', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const SLOT_MS  = parseInt(getArg('slotMs', '2000'), 10);
const F_ACTIVE = parseFloat(getArg('f', '0.5')); // active slot coefficient (0,1]

// Persistence paths
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const NODE_DIR = path.join(DATA_DIR, `port-${PORT}`);
if (!fs.existsSync(NODE_DIR)) fs.mkdirSync(NODE_DIR);
const KEYS_FILE = path.join(NODE_DIR, 'keys.json');
const CHAIN_FILE = path.join(NODE_DIR, 'chain.json');

function saveJSON(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function loadJSON(file, def) { try { return JSON.parse(fs.readFileSync(file)); } catch { return def; } }

// Key management (Ed25519)
function ensureKeys() {
  if (fs.existsSync(KEYS_FILE)) return loadJSON(KEYS_FILE, null);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const keys = { publicKeyPem: pubPem, privateKeyPem: privPem };
  saveJSON(KEYS_FILE, keys);
  return keys;
}

// Load or init chain
function ensureChain() {
  if (fs.existsSync(CHAIN_FILE)) return loadJSON(CHAIN_FILE, null);
  const genesis = makeGenesis();
  const chain = [genesis];
  saveJSON(CHAIN_FILE, chain);
  return chain;
}

let keys = ensureKeys();
let chain = ensureChain();
// --- State: mempool & UTXO ---
let mempool = new Map(); // txid -> tx
let addressBook = new Map(); // address -> pubkeyPem (toy convenience)
let utxo = new Map(); // `${txid}:${index}` -> { address, amount }

function rebuildUtxoFromChain() {
  utxo.clear();
  // Walk from genesis
  for (let i=0;i<chain.length;i++) {
    const b = chain[i];
    const payload = b.payload || {};
    const txs = Array.isArray(payload.txs) ? payload.txs : [];
    // coinbase to issuer
    if (i > 0) {
      const issuerAddress = pubkeyToAddress(b.pubkey);
      const coin = makeCoinbase(issuerAddress, 50, `reward for block ${b.index}`);
      const coinId = txidOf(coin);
      coin.outputs.forEach((o, idx) => utxo.set(`${coinId}:${idx}`, { address: o.address, amount: o.amount|0 }));
      addressBook.set(issuerAddress, b.pubkey);
    }
    // normal txs
    for (const tx of txs) {
      // Remove inputs
      (tx.inputs||[]).forEach(inp => utxo.delete(`${inp.prevTxId}:${inp.prevIndex}`));
      // Add outputs
      const id = txidOf(tx);
      (tx.outputs||[]).forEach((o, idx) => utxo.set(`${id}:${idx}`, { address: o.address, amount: o.amount|0 }));
    }
  }
}
rebuildUtxoFromChain();

function addToMempool(tx) {
  const id = txidOf(tx);
  if (mempool.has(id)) return { ok:true, id, note:'duplicate' };
  // validate against current UTXO and mempool-applied view
  // Build a temp UTXO overlay: apply mempool txs first to detect double-spend
  const overlay = new Map(utxo);
  for (const [tid, t] of mempool) {
    // try to apply
    (t.inputs||[]).forEach(inp => overlay.delete(`${inp.prevTxId}:${inp.prevIndex}`));
    const tId = txidOf(t);
    (t.outputs||[]).forEach((o, idx) => overlay.set(`${tId}:${idx}`, { address: o.address, amount: o.amount|0 }));
  }
  const v = validateTx(tx, overlay, addressBook);
  if (!v.ok) return v;
  mempool.set(id, tx);
  return { ok:true, id, fee: v.fee||0 };
}

let height = chain.length - 1;

// Total stake is sum of known stakes (including ours). For demo, we infer two-node total if peers known.
let TOTAL_STAKE = STAKE + 500; // default guess for demo
// Allow override from CLI for total stake if needed
const totalStakeOverride = getArg('totalStake', '');
if (totalStakeOverride) TOTAL_STAKE = parseInt(totalStakeOverride, 10);

// --- Networking ---
const wss = createServer(PORT, (msg, ws) => {
  handleMessage(msg, ws);
});
const sockets = connectToPeers(PEERS, (ws, url) => {
  // send tip on connect
  send(ws, { type: 'hello', name: NAME, port: PORT, stake: STAKE, pubkey: keys.publicKeyPem });
  send(ws, { type: 'tip', height, hash: chain[chain.length-1].hash });
send(ws, { type: 'mempool', txs: Array.from(mempool.values()) });
}, (msg, ws, url) => {
  handleMessage(msg, ws);
});

const peers = new Map(); // url -> {name, stake, pubkey}

function handleMessage(msg, ws) {
  switch (msg.type) {
    case 'hello':
      // remember peer stake/public key
      if (msg.name) {
        peers.set(msg.name, { stake: msg.stake||0, pubkey: msg.pubkey||'' });
        // Recompute TOTAL_STAKE as our stake + sum peer stakes
        let sum = STAKE;
        for (const [,p] of peers) sum += (p.stake||0);
        TOTAL_STAKE = sum;
      }
      break;
    case 'tip':
      // Request sync if remote is ahead
      if (msg.height > height) {
        broadcast(wss, { type: 'getBlocksFrom', from: height - 10 < 0 ? 0 : height - 10 }); // simple
      }
      break;
    case 'getBlocksFrom':
      {
        const from = Math.max(0, msg.from|0);
        const slice = chain.slice(from);
        send(ws, { type: 'blocks', blocks: slice });
      }
      break;
    case 'blocks':
      if (Array.isArray(msg.blocks) && msg.blocks.length) {
        // naive adopt if strictly longer and hashes connect from genesis
        tryAdopt(msg.blocks);
      }
      break;
    case 'block':
      tryAddBlock(msg.block);

    case 'tx':
      // Validate and store; rebroadcast if newly accepted
      {
        const res = addToMempool(msg.tx);
        if (res.ok && res.note !== 'duplicate') {
          broadcast(wss, { type: 'tx', tx: msg.tx });
          push('mempool.accept', { txid: res.id });
          log(`Mempool accepted tx ${res.id.slice(0,8)}...`);
        }
      }
      break;
    case 'mempool':
      if (Array.isArray(msg.txs)) {
        for (const t of msg.txs) addToMempool(t);
      }
      break;
      break;
  }
}

function tryAdopt(remoteChain) {
  // Validate chain linkage quickly
  for (let i=1;i<remoteChain.length;i++) {
    if (remoteChain[i].prevHash !== remoteChain[i-1].hash) return;
  }
  if (remoteChain.length > chain.length) {
    chain = remoteChain;
    height = chain.length - 1;
    saveJSON(CHAIN_FILE, chain);
    log(`Adopted longer chain height=${height}`);
  }
}

function tryAddBlock(b) {
  const prev = chain[chain.length-1];
  const { ok, reason } = validateBlock(b, prev);
  if (!ok) return; // reject silently to reduce noise
  chain.push(b);
  height = chain.length - 1;
  saveJSON(CHAIN_FILE, chain);

  // Apply txs in block to UTXO and clean mempool
  const txs = Array.isArray(b.payload?.txs) ? b.payload.txs : [];
  for (const tx of txs) {
    applyTx(tx, utxo);
    const id = txidOf(tx);
    mempool.delete(id);
  }
  // Add coinbase to issuer (reward)
  const issuerAddress = pubkeyToAddress(b.pubkey);
  const coin = makeCoinbase(issuerAddress, 50, `reward for block ${b.index}`);
  const coinId = txidOf(coin);
  coin.outputs.forEach((o, idx) => utxo.set(`${coinId}:${idx}`, { address: o.address, amount: o.amount|0 }));
  addressBook.set(issuerAddress, b.pubkey);
  broadcast(wss, { type: 'tip', height, hash: b.hash });
  log(`Accepted block #${b.index} slot=${b.slot} by ${b.issuer}`);
  push('block.accept', { index: b.index, hash: b.hash, issuer: b.issuer, slot: b.slot });
}

// --- Slot loop ---
let slot = chain.length === 1 ? 1 : chain[chain.length-1].slot + 1;

function tick() {
  const prev = chain[chain.length-1];
  // Build proof for this slot
  const msg = Buffer.from(JSON.stringify({ slot, prevHash: prev.hash }));
  const proof = crypto.sign(null, msg, crypto.createPrivateKey(keys.privateKeyPem)).toString('hex');
  
  // select some txs from mempool (FIFO)
  const MAX_TXS = 10;
  const txs = Array.from(mempool.values()).slice(0, MAX_TXS);

  const elig = isEligible(proof, STAKE, TOTAL_STAKE, F_ACTIVE);
  const thrPct = Number(elig.thr) / Number(MAX256) * 100;

  if (elig.ok) {
    const b = forgeBlock({
      index: prev.index + 1,
      slot,
      prevHash: prev.hash,
      payload: { note: `Hello from ${NAME} at slot ${slot}`, txs },
      issuer: NAME,
      privateKeyPem: keys.privateKeyPem,
      publicKeyPem: keys.publicKeyPem
    });
    tryAddBlock(b);
    broadcast(wss, { type: 'block', block: b });
    log(`FORGED block #${b.index} score ok (thr≈${thrPct.toFixed(6)}%)`);

  } else if (req.method === 'POST' && url.pathname === '/rpc') {
    // Batch support: body may be a single object or an array

    let body='';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const call = JSON.parse(body||'{}');
        const calls = Array.isArray(call) ? call : [call];
        const results = [];
        function handleOne(one) {
          const { id, method, params } = one || {};
          function build(result, error) { return { jsonrpc:'2.0', id, result, error }; }
          switch (method) {
          case 'ping': return reply('pong');
          case 'whoami': {
            const addr = pubkeyToAddress(keys.publicKeyPem);
            return reply({ name: NAME, address: addr, stake: STAKE, port: PORT });
          }
          case 'getTip': {
            const tip = chain[chain.length-1];
            return reply({ height, hash: tip.hash, slot: tip.slot, issuer: tip.issuer });
          }
          case 'getMempool': {
            const txs = Array.from(mempool.values());
            return reply({ size: txs.length, txs });
          }
          case 'getUTXO': {
            const address = params && params.address;
            if (!address) return reply(null, 'address required');
            const list = [];
            for (const [k,v] of utxo) if (v.address === address) list.append
            for (const [k,v] of utxo) if (v.address === address) list.push({ outpoint: k, amount: v.amount });
            return reply({ utxos: list });
          }
          case 'getBlock': {
            const h = (params && params.height)|0;
            if (h < 0 || h >= chain.length) return reply(null, 'bad height');
            return reply(chain[h]);
          }
          case 'submitTx': {
            const tx = params && params.tx;
            if (!tx) return reply(null, 'tx required');
            const resAdd = addToMempool(tx);
            if (!resAdd.ok) return reply(null, resAdd.reason||'invalid tx');
            broadcast(wss, { type: 'tx', tx });
            return reply({ txid: txidOf(tx), fee: resAdd.fee||0 });
          }
          case 'makeAddress': {
            const pubPem = params && params.pubkeyPem;
            if (!pubPem) return reply(null, 'pubkeyPem required');
            const addr = pubkeyToAddress(pubPem);
            addressBook.set(addr, pubPem);
            return reply({ address: addr });
          }
          default:
            return build(null, 'method not found');
          }
        }
        for (const one of calls) results.push(handleOne(one));
        const out = Array.isArray(call) ? results : results[0];
        res.end(JSON.stringify(out));
      } catch (e) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'bad json' }));
      }
    });
  } else {
    // Occasionally share tip
    if (slot % 5 === 0) broadcast(wss, { type: 'tip', height, hash: prev.hash });
  }

  slot += 1;
  
// --- Tiny REST API (no deps) ---
const http = require('http');
const WebSocket = require('ws');
const HTTP_PORT = parseInt(getArg('httpPort', String(PORT + 1000)), 10);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && url.pathname === '/tip') {
    const tip = chain[chain.length-1];
    res.end(JSON.stringify({ height, hash: tip.hash, slot: tip.slot, issuer: tip.issuer }));
  } else if (req.method === 'GET' && url.pathname === '/chain') {
    const from = Math.max(0, parseInt(url.searchParams.get('from') || '0', 10));
    res.end(JSON.stringify(chain.slice(from)));
  } else if (req.method === 'GET' && url.pathname === '/peers') {
    const list = Array.from(peers.entries()).map(([name, p]) => ({ name, stake: p.stake||0 }));
    res.end(JSON.stringify({ self: { name: NAME, stake: STAKE }, peers: list }));

  } else if (req.method === 'POST' && url.pathname === '/rpc') {
    // Batch support: body may be a single object or an array

    let body='';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const call = JSON.parse(body||'{}');
        const calls = Array.isArray(call) ? call : [call];
        const results = [];
        function handleOne(one) {
          const { id, method, params } = one || {};
          function build(result, error) { return { jsonrpc:'2.0', id, result, error }; }
          switch (method) {
          case 'ping': return reply('pong');
          case 'whoami': {
            const addr = pubkeyToAddress(keys.publicKeyPem);
            return reply({ name: NAME, address: addr, stake: STAKE, port: PORT });
          }
          case 'getTip': {
            const tip = chain[chain.length-1];
            return reply({ height, hash: tip.hash, slot: tip.slot, issuer: tip.issuer });
          }
          case 'getMempool': {
            const txs = Array.from(mempool.values());
            return reply({ size: txs.length, txs });
          }
          case 'getUTXO': {
            const address = params && params.address;
            if (!address) return reply(null, 'address required');
            const list = [];
            for (const [k,v] of utxo) if (v.address === address) list.append
            for (const [k,v] of utxo) if (v.address === address) list.push({ outpoint: k, amount: v.amount });
            return reply({ utxos: list });
          }
          case 'getBlock': {
            const h = (params && params.height)|0;
            if (h < 0 || h >= chain.length) return reply(null, 'bad height');
            return reply(chain[h]);
          }
          case 'submitTx': {
            const tx = params && params.tx;
            if (!tx) return reply(null, 'tx required');
            const resAdd = addToMempool(tx);
            if (!resAdd.ok) return reply(null, resAdd.reason||'invalid tx');
            broadcast(wss, { type: 'tx', tx });
            return reply({ txid: txidOf(tx), fee: resAdd.fee||0 });
          }
          case 'makeAddress': {
            const pubPem = params && params.pubkeyPem;
            if (!pubPem) return reply(null, 'pubkeyPem required');
            const addr = pubkeyToAddress(pubPem);
            addressBook.set(addr, pubPem);
            return reply({ address: addr });
          }
          default:
            return build(null, 'method not found');
          }
        }
        for (const one of calls) results.push(handleOne(one));
        const out = Array.isArray(call) ? results : results[0];
        res.end(JSON.stringify(out));
      } catch (e) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'bad json' }));
      }
    });
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  }
});
server.listen(HTTP_PORT, () => log(`HTTP listening on :${HTTP_PORT} (/tip, /chain?from=0, /peers, /rpc, WS:/ws)`));

// --- WebSocket notifications (clients) ---
const wssClients = new WebSocket.Server({ noServer: true });
const clientSockets = new Set();
wssClients.on('connection', (ws) => {
  clientSockets.add(ws);
  ws.on('close', () => clientSockets.delete(ws));
});
server.on('upgrade', (req, socket, head) => {
  const { url } = req;
  if (url === '/ws') {
    wssClients.handleUpgrade(req, socket, head, (ws) => {
      wssClients.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});
function push(event, data) {
  const payload = JSON.stringify({ event, data });
  for (const ws of clientSockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}


setTimeout(tick, SLOT_MS);
}

function log(msg) {
  const now = new Date().toISOString();
  console.log(`[${now}] [${NAME}@${PORT}] ${msg}`);
}

log(`Node started. stake=${STAKE}, f=${F_ACTIVE}, slotMs=${SLOT_MS}, peers=${PEERS.join(',')||'(none)'} `);

// --- Tiny REST API (no deps) ---
const http = require('http');
const WebSocket = require('ws');
const HTTP_PORT = parseInt(getArg('httpPort', String(PORT + 1000)), 10);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && url.pathname === '/tip') {
    const tip = chain[chain.length-1];
    res.end(JSON.stringify({ height, hash: tip.hash, slot: tip.slot, issuer: tip.issuer }));
  } else if (req.method === 'GET' && url.pathname === '/chain') {
    const from = Math.max(0, parseInt(url.searchParams.get('from') || '0', 10));
    res.end(JSON.stringify(chain.slice(from)));
  } else if (req.method === 'GET' && url.pathname === '/peers') {
    const list = Array.from(peers.entries()).map(([name, p]) => ({ name, stake: p.stake||0 }));
    res.end(JSON.stringify({ self: { name: NAME, stake: STAKE }, peers: list }));

  } else if (req.method === 'POST' && url.pathname === '/rpc') {
    // Batch support: body may be a single object or an array

    let body='';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const call = JSON.parse(body||'{}');
        const calls = Array.isArray(call) ? call : [call];
        const results = [];
        function handleOne(one) {
          const { id, method, params } = one || {};
          function build(result, error) { return { jsonrpc:'2.0', id, result, error }; }
          switch (method) {
          case 'ping': return reply('pong');
          case 'whoami': {
            const addr = pubkeyToAddress(keys.publicKeyPem);
            return reply({ name: NAME, address: addr, stake: STAKE, port: PORT });
          }
          case 'getTip': {
            const tip = chain[chain.length-1];
            return reply({ height, hash: tip.hash, slot: tip.slot, issuer: tip.issuer });
          }
          case 'getMempool': {
            const txs = Array.from(mempool.values());
            return reply({ size: txs.length, txs });
          }
          case 'getUTXO': {
            const address = params && params.address;
            if (!address) return reply(null, 'address required');
            const list = [];
            for (const [k,v] of utxo) if (v.address === address) list.append
            for (const [k,v] of utxo) if (v.address === address) list.push({ outpoint: k, amount: v.amount });
            return reply({ utxos: list });
          }
          case 'getBlock': {
            const h = (params && params.height)|0;
            if (h < 0 || h >= chain.length) return reply(null, 'bad height');
            return reply(chain[h]);
          }
          case 'submitTx': {
            const tx = params && params.tx;
            if (!tx) return reply(null, 'tx required');
            const resAdd = addToMempool(tx);
            if (!resAdd.ok) return reply(null, resAdd.reason||'invalid tx');
            broadcast(wss, { type: 'tx', tx });
            return reply({ txid: txidOf(tx), fee: resAdd.fee||0 });
          }
          case 'makeAddress': {
            const pubPem = params && params.pubkeyPem;
            if (!pubPem) return reply(null, 'pubkeyPem required');
            const addr = pubkeyToAddress(pubPem);
            addressBook.set(addr, pubPem);
            return reply({ address: addr });
          }
          default:
            return build(null, 'method not found');
          }
        }
        for (const one of calls) results.push(handleOne(one));
        const out = Array.isArray(call) ? results : results[0];
        res.end(JSON.stringify(out));
      } catch (e) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'bad json' }));
      }
    });
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  }
});
server.listen(HTTP_PORT, () => log(`HTTP listening on :${HTTP_PORT} (/tip, /chain?from=0, /peers, /rpc, WS:/ws)`));

// --- WebSocket notifications (clients) ---
const wssClients = new WebSocket.Server({ noServer: true });
const clientSockets = new Set();
wssClients.on('connection', (ws) => {
  clientSockets.add(ws);
  ws.on('close', () => clientSockets.delete(ws));
});
server.on('upgrade', (req, socket, head) => {
  const { url } = req;
  if (url === '/ws') {
    wssClients.handleUpgrade(req, socket, head, (ws) => {
      wssClients.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});
function push(event, data) {
  const payload = JSON.stringify({ event, data });
  for (const ws of clientSockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}


setTimeout(tick, SLOT_MS);
