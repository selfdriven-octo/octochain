
const crypto = require('crypto');
const { sha256_hex, blockHash, serializeBlock, makeGenesis } = require('./block');

// Utility: big integer from hex
function bigIntFromHex(hex) {
  return BigInt('0x' + hex);
}

// Verify Ed25519 signature (raw bytes provided as hex) over message buffer
function verifySig(publicKeyPem, messageBuf, signatureHex) {
  try {
    const ok = crypto.verify(
      null,
      messageBuf,
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(signatureHex, 'hex')
    );
    return ok;
  } catch (e) {
    return false;
  }
}

// Produce Ed25519 signature hex over message buffer
function sign(privateKeyPem, messageBuf) {
  const sig = crypto.sign(null, messageBuf, crypto.createPrivateKey(privateKeyPem));
  return sig.toString('hex');
}

// Randomness/VRF-like: signature over (slot||prevHash) becomes 'proof'
// Score = sha256(proof) interpreted as big integer
function leaderScoreFromProof(proofHex) {
  const digest = sha256_hex(Buffer.from(proofHex, 'hex'));
  return bigIntFromHex(digest);
}

// Threshold scaled by stake and a global active slot coefficient f in (0,1]
// Max = 2^256 - 1
const MAX256 = (BigInt(1) << BigInt(256)) - BigInt(1);

function thresholdFor(stake, totalStake, fActive) {
  if (totalStake <= 0) return BigInt(0);
  const frac = Math.max(0, Math.min(1, fActive)) * (stake / totalStake);
  // Convert to BigInt threshold
  // threshold = frac * (MAX256)
  return BigInt(Math.floor(frac * 1e6)) * (MAX256 // scale down via 1e6 to avoid floating errors
    // Dividing by 1e6 below
  ) / BigInt(1_000_000);
}

// Decide if eligible given proof
function isEligible(proofHex, stake, totalStake, fActive) {
  const score = leaderScoreFromProof(proofHex);
  const thr = thresholdFor(stake, totalStake, fActive);
  return { ok: score <= thr, score, thr };
}

// Build a candidate block (without hash), then hash it
function forgeBlock({ index, slot, prevHash, payload, issuer, privateKeyPem, publicKeyPem }) {
  const msg = Buffer.from(JSON.stringify({ slot, prevHash }));
  const proof = sign(privateKeyPem, msg);
  const b = {
    index,
    slot,
    prevHash,
    payload,
    issuer,
    proof,
    pubkey: publicKeyPem,
    timestamp: Date.now()
  };
  b.hash = blockHash(b);
  return b;
}

// Validate a block structurally and cryptographically
function validateBlock(block, prev) {
  if (!block || typeof block !== 'object') return { ok: false, reason: 'bad block object' };
  if (block.index !== prev.index + 1) return { ok: false, reason: 'bad index' };
  if (block.prevHash !== prev.hash) return { ok: false, reason: 'bad prevHash' };
  if (block.hash !== blockHash(block)) return { ok: false, reason: 'bad hash' };

  // Verify proof signature over (slot||prevHash)
  const msg = Buffer.from(JSON.stringify({ slot: block.slot, prevHash: block.prevHash }));
  const sigOk = verifySig(block.pubkey, msg, block.proof);
  if (!sigOk) return { ok: false, reason: 'bad proof signature' };

  return { ok: true };
}

// Simple longest-chain rule
function chooseBestChain(chains) {
  // chains: array of arrays (blocks)
  let best = null;
  for (const c of chains) {
    if (!c || c.length === 0) continue;
    if (!best || c.length > best.length) best = c;
  }
  return best;
}

module.exports = {
  MAX256,
  leaderScoreFromProof,
  thresholdFor,
  isEligible,
  forgeBlock,
  validateBlock,
  chooseBestChain,
  makeGenesis
};
