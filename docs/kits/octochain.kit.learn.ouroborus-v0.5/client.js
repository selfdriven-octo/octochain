
// Tiny JS client for ouro-mini JSON-RPC & tx building (CommonJS, Node 18+)
// No external deps. Uses Ed25519 keys (PEM) and the toy address = sha256(pubkeyPem).
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');

function sha256_hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function pubkeyToAddress(pubPem) {
  return sha256_hex(Buffer.from(pubPem));
}

function rpcCall(rpcUrl, method, params) {
  const u = new URL(rpcUrl);
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
  const opts = {
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, res => {
      let data='';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(data || '{}');
          if (j.error) return reject(new Error(String(j.error)));
          resolve(j.result);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Wallet helpers
function createWallet(name, outPath) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const address = pubkeyToAddress(pubPem);
  const wallet = { name: name || 'wallet', publicKeyPem: pubPem, privateKeyPem: privPem, address };
  fs.writeFileSync(outPath, JSON.stringify(wallet, null, 2));
  return wallet;
}
function loadWallet(path) {
  return JSON.parse(fs.readFileSync(path));
}

// Tx helpers (mirror node's tx.js logic)
function txidOf(tx) {
  const obj = { inputs: tx.inputs || [], outputs: tx.outputs || [] };
  return sha256_hex(Buffer.from(JSON.stringify(obj)));
}
function signInput(privPem, prevTxId, prevIndex, outputs) {
  const msg = Buffer.from(JSON.stringify({
    prevTxId, prevIndex, outputsDigest: sha256_hex(Buffer.from(JSON.stringify(outputs)))
  }));
  const sig = crypto.sign(null, msg, crypto.createPrivateKey(privPem));
  return sig.toString('hex');
}

// Select UTXOs to cover amount+fee (greedy simple)
function selectUtxos(utxos, amountNeeded) {
  let selected = [];
  let total = 0;
  for (const u of utxos) {
    selected.push(u);
    total += u.amount|0;
    if (total >= amountNeeded) break;
  }
  if (total < amountNeeded) throw new Error('insufficient funds');
  return { selected, total };
}

// Build a tx: spend from sender (wallet) to recipient (toAddr) with optional change and fee
function buildTxFromUtxos(wallet, utxoEntries, toAddr, amount, fee) {
  const amountNeeded = amount + fee;
  const { selected, total } = selectUtxos(utxoEntries, amountNeeded);
  const inputs = selected.map(u => ({
    prevTxId: u.outpoint.split(':')[0],
    prevIndex: parseInt(u.outpoint.split(':')[1], 10),
    pubkeyPem: wallet.publicKeyPem, // include for toy validation
    signature: '' // fill after outputs known
  }));
  const outputs = [{ address: toAddr, amount }];
  const change = total - amountNeeded;
  if (change > 0) outputs.push({ address: wallet.address, amount: change });

  // sign each input
  inputs.forEach(inp => {
    inp.signature = signInput(wallet.privateKeyPem, inp.prevTxId, inp.prevIndex, outputs);
  });

  const tx = { inputs, outputs };
  tx.txid = txidOf(tx);
  return tx;
}

// CLI
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >=0 && i+1 < process.argv.length) return process.argv[i+1];
  return def;
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || ['init','addr','whoami','utxo','send'].indexOf(cmd) < 0) {
    console.log(`Usage:
  node client.js init --name alice --out wallet/alice.json
  node client.js addr --wallet wallet/alice.json
  node client.js whoami --rpc http://localhost:5001/rpc
  node client.js utxo --rpc http://localhost:5001/rpc --address <ADDR>
  node client.js send --rpc http://localhost:5001/rpc --wallet wallet/alice.json --to <ADDR> --amount 25 --fee 1
`);
    process.exit(0);
  }

  try {
    if (cmd === 'init') {
      const name = arg('name','wallet');
      const out = arg('out', `wallet/${name}.json`);
      const w = createWallet(name, out);
      console.log(JSON.stringify({ ok:true, path: out, address: w.address }, null, 2));
      return;
    }
    if (cmd === 'addr') {
      const wpath = arg('wallet');
      const w = loadWallet(wpath);
      console.log(JSON.stringify({ name: w.name, address: w.address }, null, 2));
      return;
    }
    const rpc = arg('rpc','http://localhost:5001/rpc');
    if (cmd === 'whoami') {
      const me = await rpcCall(rpc, 'whoami', {});
      console.log(JSON.stringify(me, null, 2));
      return;
    }
    if (cmd === 'utxo') {
      const address = arg('address');
      if (!address) throw new Error('address required');
      const res = await rpcCall(rpc, 'getUTXO', { address });
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (cmd === 'send') {
      const wpath = arg('wallet');
      const to = arg('to');
      const amount = parseInt(arg('amount','0'), 10);
      const fee = parseInt(arg('fee','0'), 10);
      if (!wpath || !to || amount <= 0) throw new Error('missing args: --wallet --to --amount [--fee]');
      const w = loadWallet(wpath);

      // fetch UTXOs for sender
      const utx = await rpcCall(rpc, 'getUTXO', { address: w.address });
      const tx = buildTxFromUtxos(w, utx.utxos||[], to, amount, fee);
      const sub = await rpcCall(rpc, 'submitTx', { tx });
      console.log(JSON.stringify({ submitted: sub, txid: tx.txid, tx }, null, 2));
      return;
    }
  } catch (e) {
    console.error('Error:', e.message || e);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { createWallet, loadWallet, pubkeyToAddress };
