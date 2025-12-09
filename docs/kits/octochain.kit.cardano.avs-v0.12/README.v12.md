
# v12: Noir → proof → verifier UTxO pipeline (stub) + fuller Aiken test scaffolds

## What’s included
- **Noir circuit (stub)** at `noir/partnerchain_praos_lc` with `Nargo.toml` and `src/main.nr`.
- **Verifier UTxO creator** (`relayer/src/create-zk-utxo.js`) that mints `ZkDatum(event_id, epoch, ok=true)` at your zk-verifier address after (stub) proof verification.
- **Aiken test scaffolds** that outline Tx-context assembly for Claim/Challenge/Finalize/ChallengeWin, including ZK path.

## Pipeline walkthrough
1) Produce a proof (stub):
   ```bash
   cd noir/partnerchain_praos_lc
   nargo check
   nargo prove p --witness witness.toml
   ```
2) Create a zk_ok UTxO on Cardano:
   ```bash
   cd relayer
   node src/create-zk-utxo.js <event_id_hex> <epoch> noir/partnerchain_praos_lc/proofs/p.proof
   ```
3) Finalize on Cardano with ZK:
   - Call `submitFinalizeTx(..., { zk: true })`. The on-chain validator will accept based on the **reference proof UTxO**.

## Move from stub → real
- Replace Noir logic with actual **Praos header** checks (VRF verification, stake distribution, nonce schedule, etc.).
- Replace the JS creator’s “trust me” step with a genuine verifier (hosted or native) that only creates UTxO if proof is valid.
- Optionally mint a **proof NFT** and require it as a reference input.
- Turn the Aiken test scaffolds into real tests by constructing full `ScriptContext` fixtures.

