
# Noir Praos LC (stub)

This is a **stub** Noir circuit that will be replaced by real Praos/VRF header checks.

## How to use (local)
```bash
cd noir/partnerchain_praos_lc
nargo check
nargo prove p --witness witness.toml
nargo verify p --proof proofs/p.proof
```

Create `witness.toml` like:
```toml
event_id = "0x<64-hex-bytes>"
epoch = 123
```

The proof is just a placeholder—it attests that the circuit constraints were satisfiable.
In production, swap to a circuit that verifies:
- block header formatting,
- VRF output/leader election per Praos rules,
- hash-chain linkage,
- event inclusion.
