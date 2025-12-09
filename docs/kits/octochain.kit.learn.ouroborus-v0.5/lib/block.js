
const crypto = require('crypto');

function sha256_hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function serializeBlock(b) {
  // Deterministic serialization excluding 'hash' for hashing
  const obj = {
    index: b.index,
    slot: b.slot,
    prevHash: b.prevHash,
    payload: b.payload,
    issuer: b.issuer,
    proof: b.proof,   // signature as hex
    pubkey: b.pubkey, // PEM public key
    timestamp: b.timestamp
  };
  return Buffer.from(JSON.stringify(obj));
}

function blockHash(b) {
  return sha256_hex(serializeBlock(b));
}

function makeGenesis() {
  const b = {
    index: 0,
    slot: 0,
    prevHash: '0'.repeat(64),
    payload: { genesis: true },
    issuer: 'genesis',
    proof: '',
    pubkey: '',
    timestamp: Date.now()
  };
  b.hash = blockHash(b);
  return b;
}

module.exports = {
  sha256_hex,
  blockHash,
  serializeBlock,
  makeGenesis
};
