
# ZK verifier UTxO creator (stub)

This script **creates** a UTxO at the zk-verifier script with an inline `ZkDatum(event_id, epoch, ok=true)`.

```bash
node src/create-zk-utxo.js <event_id_hex> <epoch> <proofPath>
```

In production:
- Validate the Noir proof before creating the UTxO (trusted relayer cannot lie).
- Consider minting a **proof NFT** and checking it in the claim validator instead of datum-only.
