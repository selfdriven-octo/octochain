// ESM browser client for ouro-mini
// Uses WebCrypto (Ed25519). Converts keys to PEM to match server expectations.
const text = (el, v) => el.textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
const q = sel => document.querySelector(sel);

function bytesToBase64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
function base64ToLines(b64) {
  const lines = [];
  for (let i=0;i<b64.length;i+=64) lines.push(b64.slice(i, i+64));
  return lines.join('\n');
}
function derToPem(der, label) {
  const b64 = bytesToBase64(der);
  return `-----BEGIN ${label}-----\n${base64ToLines(b64)}\n-----END ${label}-----\n`;
}
async function exportPubPem(publicKey) {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  return derToPem(new Uint8Array(spki), 'PUBLIC KEY');
}
async function exportPrivPem(privateKey) {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey);
  return derToPem(new Uint8Array(pkcs8), 'PRIVATE KEY');
}
async function sha256_hex(buf) {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function pubkeyToAddress(pubPem) {
  const enc = new TextEncoder();
  return sha256_hex(enc.encode(pubPem));
}

// RPC
async function rpc(rpcUrl, method, params) {
  const r = await fetch(rpcUrl, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ jsonrpc:'2.0', id: Date.now(), method, params }) });
  const j = await r.json();
  if (Array.isArray(j)) return j; // batch
  if (j.error) throw new Error(j.error);
  return j.result;
}

// Tx helpers
async function signInput(privKey, prevTxId, prevIndex, outputs) {
  const enc = new TextEncoder();
  const outputsDigest = await sha256_hex(enc.encode(JSON.stringify(outputs)));
  const msg = enc.encode(JSON.stringify({ prevTxId, prevIndex, outputsDigest }));
  const sig = await crypto.subtle.sign({name:'Ed25519'}, privKey, msg);
  return Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function txidOf(tx) {
  const enc = new TextEncoder();
  const obj = { inputs: tx.inputs||[], outputs: tx.outputs||[] };
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify(obj)));
  return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// State
let keys = null; // {publicKey, privateKey, pubPem, privPem, address}

async function genKeys() {
  const k = await crypto.subtle.generateKey({ name:'Ed25519', namedCurve:'Ed25519' }, true, ['sign', 'verify']);
  const pubPem = await exportPubPem(k.publicKey);
  const privPem = await exportPrivPem(k.privateKey);
  const address = await pubkeyToAddress(pubPem);
  keys = { publicKey: k.publicKey, privateKey: k.privateKey, pubPem, privPem, address };
  return keys;
}

function saveLocal() { localStorage.setItem('ouro.keys', JSON.stringify({ pubPem: keys.pubPem, privPem: keys.privPem, address: keys.address })); }
async function loadLocal() {
  const j = JSON.parse(localStorage.getItem('ouro.keys')||'null');
  if (!j) throw new Error('no keys');
  // Import back to CryptoKey
  const pubDer = pemToDer(j.pubPem);
  const privDer = pemToDer(j.privPem);
  const publicKey = await crypto.subtle.importKey('spki', pubDer, {name:'Ed25519', namedCurve:'Ed25519'}, true, ['verify']);
  const privateKey = await crypto.subtle.importKey('pkcs8', privDer, {name:'Ed25519', namedCurve:'Ed25519'}, true, ['sign']);
  keys = { publicKey, privateKey, pubPem: j.pubPem, privPem: j.privPem, address: j.address };
  return keys;
}
function pemToDer(pem) {
  const b64 = pem.replace(/-----(BEGIN|END) [^-]+-----/g,'').replace(/\s+/g,'');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// UI wiring
const rpcInput = q('#rpc');
q('#btnGen').onclick = async () => { await genKeys(); text(q('#keys'), {address: keys.address, pubPem: keys.pubPem}); q('#addr').value = keys.address; };
q('#btnSave').onclick = () => { saveLocal(); alert('saved'); };
q('#btnLoad').onclick = async () => { await loadLocal(); text(q('#keys'), {address: keys.address, pubPem: keys.pubPem}); q('#addr').value = keys.address; };
q('#btnTip').onclick = async () => { text(q('#out1'), await rpc(rpcInput.value, 'getTip', {})); };
q('#btnWho').onclick = async () => { text(q('#out1'), await rpc(rpcInput.value, 'whoami', {})); };
q('#btnUtxo').onclick = async () => {
  const a = q('#addr').value.trim();
  text(q('#out1'), await rpc(rpcInput.value, 'getUTXO', { address: a }));
};
q('#btnSend').onclick = async () => {
  if (!keys) await loadLocal();
  const to = q('#to').value.trim();
  const amount = parseInt(q('#amt').value, 10) || 0;
  const fee = parseInt(q('#fee').value, 10) || 0;
  // Fetch UTXO
  const utx = await rpc(rpcInput.value, 'getUTXO', { address: keys.address });
  const utxos = utx.utxos||[];
  // Greedy select
  let selected=[], total=0;
  for (const u of utxos) { selected.push(u); total += u.amount; if (total >= amount+fee) break; }
  if (total < amount+fee) { text(q('#out2'), { error:'insufficient funds'}); return; }
  const inputs = selected.map(u => ({ prevTxId: u.outpoint.split(':')[0], prevIndex: parseInt(u.outpoint.split(':')[1], 10), pubkeyPem: keys.pubPem, signature: '' }));
  const outputs = [{ address: to, amount }];
  const change = total - amount - fee;
  if (change > 0) outputs.push({ address: keys.address, amount: change });
  for (const inp of inputs) { inp.signature = await signInput(keys.privateKey, inp.prevTxId, inp.prevIndex, outputs); }
  const tx = { inputs, outputs };
  tx.txid = await txidOf(tx);
  const res = await rpc(rpcInput.value, 'submitTx', { tx });
  text(q('#out2'), { submitted: res, txid: tx.txid, tx });
};

// WS events
let ws = null;
q('#btnConnect').onclick = () => {
  const wsUrl = rpcInput.value.replace('/rpc','/ws').replace('http','ws');
  ws = new WebSocket(wsUrl);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const pre = q('#events');
    pre.textContent += JSON.stringify(msg) + '\n';
    pre.scrollTop = pre.scrollHeight;
  };
  ws.onopen = () => { const pre = q('#events'); pre.textContent += 'WS connected\n'; };
  ws.onclose = () => { const pre = q('#events'); pre.textContent += 'WS closed\n'; };
};
