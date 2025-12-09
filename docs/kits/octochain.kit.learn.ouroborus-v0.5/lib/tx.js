
const crypto = require('crypto');
const { sha256_hex } = require('./block');

// Address = sha256 of PEM public key (toy)
function pubkeyToAddress(pubPem) {
  return sha256_hex(Buffer.from(pubPem));
}

// txid = sha256(JSON of {inputs, outputs})
function txidOf(tx) {
  const obj = { inputs: tx.inputs || [], outputs: tx.outputs || [] };
  return sha256_hex(Buffer.from(JSON.stringify(obj)));
}

// Sign an input: signature over message = sha256(prevTxId||prevIndex||outputsDigest)
function signInput(privPem, prevTxId, prevIndex, outputs) {
  const msg = Buffer.from(JSON.stringify({
    prevTxId, prevIndex, outputsDigest: sha256_hex(Buffer.from(JSON.stringify(outputs)))
  }));
  const sig = crypto.sign(null, msg, crypto.createPrivateKey(privPem)).toString('hex');
  return sig;
}

// Verify an input signature given owner's public key
function verifyInput(pubPem, prevTxId, prevIndex, outputs, sigHex) {
  try {
    const msg = Buffer.from(JSON.stringify({
      prevTxId, prevIndex, outputsDigest: sha256_hex(Buffer.from(JSON.stringify(outputs)))
    }));
    return crypto.verify(null, msg, crypto.createPublicKey(pubPem), Buffer.from(sigHex, 'hex'));
  } catch {
    return false;
  }
}

// Validate a tx against a UTXO set and basic rules
// utxo: Map(key = `${txid}:${index}`, value = { address, amount })
// pubkeys: Map(address -> pubPem)  (toy address book; for demo we allow sender to include pubkey per input)
function validateTx(tx, utxo, addressBook) {
  if (!tx || !Array.isArray(tx.inputs) || !Array.isArray(tx.outputs)) return { ok:false, reason:'bad shape' };
  if (tx.inputs.length === 0) return { ok:false, reason:'no inputs' };
  if (tx.outputs.length === 0) return { ok:false, reason:'no outputs' };

  let inSum = 0, outSum = 0;
  // Spend checks
  for (const inp of tx.inputs) {
    if (!inp.prevTxId || typeof inp.prevIndex !== 'number' || inp.prevIndex < 0) {
      return { ok:false, reason:'bad input ref' };
    }
    const key = `${inp.prevTxId}:${inp.prevIndex}`;
    const utxoEntry = utxo.get(key);
    if (!utxoEntry) return { ok:false, reason:`missing utxo ${key}` };
    const pubPem = inp.pubkeyPem || (addressBook.get(utxoEntry.address) || null);
    if (!pubPem) return { ok:false, reason:'unknown pubkey for address' };
    if (!verifyInput(pubPem, inp.prevTxId, inp.prevIndex, tx.outputs, inp.signature)) {
      return { ok:false, reason:'bad signature' };
    }
    inSum += utxoEntry.amount|0;
  }
  for (const o of tx.outputs) {
    if (!o.address || (o.amount|0) <= 0) return { ok:false, reason:'bad output' };
    outSum += o.amount|0;
  }
  if (outSum > inSum) return { ok:false, reason:'insufficient input' };
  return { ok:true, fee: inSum - outSum };
}

// Apply tx to UTXO
function applyTx(tx, utxo) {
  // Remove inputs
  for (const inp of tx.inputs) {
    const key = `${inp.prevTxId}:${inp.prevIndex}`;
    utxo.delete(key);
  }
  // Add outputs
  const id = txidOf(tx);
  tx.outputs.forEach((o, i) => {
    utxo.set(`${id}:${i}`, { address: o.address, amount: o.amount|0 });
  });
}

// Build a simple coinbase tx to award miner/forger
function makeCoinbase(address, amount, note) {
  return {
    inputs: [],
    outputs: [{ address, amount }],
    coinbase: true,
    note: note || ''
  };
}

module.exports = {
  pubkeyToAddress,
  txidOf,
  signInput,
  verifyInput,
  validateTx,
  applyTx,
  makeCoinbase
};
