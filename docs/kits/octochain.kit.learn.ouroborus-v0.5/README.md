# ouro-mini (educational)

Minimal, **two-node, slot-based** blockchain inspired by Ouroboros (Cardano).  
This is **for learning only** — not secure, not production-ready.

## Features
- Slots (default 2s) and epochs
- Simple stake-based leader election (VRF-like using Ed25519 signatures hashed to a score)
- WebSocket gossip between peers
- Longest-chain selection
- Disk persistence of chain and keys (in `data/`)

## Requirements
- Node.js 18+ (tested on Node 20)
- No TypeScript, no ESM — CommonJS + `require()`

## Quick start (two terminals)
```bash
npm i

# Terminal 1
npm run node1

# Terminal 2
npm run node2
```

You'll see blocks being forged when a node's **eligibility score** falls under its stake threshold.

## CLI Options
```
node node.js --port 4001 --name A --stake 600 --peers ws://localhost:4002 --slotMs 2000
```

- `--port` WebSocket server port
- `--name` display name for logs
- `--stake` integer stake weight (proportional to leader eligibility)
- `--peers` comma-separated `ws://host:port` peers
- `--slotMs` slot length in milliseconds (default 2000)

## How leader election works (toy version)
1. For each slot, candidate leader makes a **proof** = Ed25519 sign(`slot || prevHash`).
2. Everyone computes `score = sha256(proof)` and converts to a big integer.
3. The node is eligible if `score < threshold`, where `threshold` scales with the node's stake and a global coefficient `f` (active slot coefficient ~ probability a leader is elected).
4. Since `proof` is a signature, anyone can verify it and recompute the same score (no secret revealed).  
   ⚠️ Real VRFs provide non-grindable randomness; this toy can be grindable and is **not secure**.

## File layout
- `node.js` — main process: keys, network, slot loop, forging
- `lib/block.js` — block structure + hashing
- `lib/consensus.js` — leader election, chain validation/selection
- `lib/network.js` — WebSocket gossip layer
- `data/` — persisted keys and chain snapshots per port

## Security caveats
- Not a real VRF, no slashing, no forks handling nuance, no time-sync, no sybil resistance.
- Use only for learning and demos.


## 3-node quick start
```bash
npm i
npm run node1   # WS :4001, HTTP :5001
npm run node2   # WS :4002, HTTP :5002
npm run node3   # WS :4003, HTTP :5003
```

## REST API (no dependencies)
Each node exposes a tiny HTTP server on `--httpPort` (default `port+1000`). Try:
- `GET /tip` → `{ height, hash, slot, issuer }`
- `GET /chain?from=0` → full chain (or slice)
- `GET /peers` → known peers & stakes

Examples:
- http://localhost:5001/tip
- http://localhost:5002/peers
- http://localhost:5003/chain?from=0

## Pluggable VRF interface (future-ready)
The leader check uses `isEligible()` today (signature→hash score). You can swap a real VRF by replacing
the `leaderScoreFromProof()` and `isEligible()` logic in `lib/consensus.js`. The rest of the system remains the same.


## JSON-RPC
POST to `/rpc` with a body like:
```json
{"jsonrpc":"2.0","id":1,"method":"getTip","params":{}}
```
Methods:
- `ping` → `"pong"`
- `whoami` → `{ name, address, stake, port }`
- `getTip` → `{ height, hash, slot, issuer }`
- `getMempool` → `{ size, txs }`
- `getUTXO` `{ address }` → `{ utxos: [{ outpoint, amount }] }`
- `getBlock` `{ height }` → full block object
- `submitTx` `{ tx }` → `{ txid, fee }`
- `makeAddress` `{ pubkeyPem }` → `{ address }` (adds to local addressBook)

### Transaction format (UTXO-lite)
```json
{
  "inputs": [
    {
      "prevTxId": "<hex>",
      "prevIndex": 0,
      "pubkeyPem": "-----BEGIN PUBLIC KEY-----\n...",
      "signature": "<hex>"  // over sha256(prevTxId||prevIndex||outputsDigest)
    }
  ],
  "outputs": [
    { "address": "<sha256(pubkeyPem)>", "amount": 25 },
    { "address": "<anotherAddress>", "amount": 10 }
  ]
}
```
- **TxID** = sha256(JSON of `{inputs, outputs}`).
- **Coinbase**: Every accepted block auto-mints a 50-unit coinbase to the issuer’s address.

### Example flow
1. Ask a node for its address:
   ```bash
   curl -s http://localhost:5001/rpc -d '{"jsonrpc":"2.0","id":1,"method":"whoami"}'
   ```
2. Query UTXOs for that address (after it has forged a block or two):
   ```bash
   curl -s http://localhost:5001/rpc -d '{"jsonrpc":"2.0","id":2,"method":"getUTXO","params":{"address":"<address>"}}'
   ```
3. Build a tx locally (sign each input with the sender’s private key), then submit:
   ```bash
   curl -s http://localhost:5001/rpc -d '{"jsonrpc":"2.0","id":3,"method":"submitTx","params":{"tx":{...}}}'
   ```


## Tiny JS client
A no-deps wallet/tx helper: `client.js`

### Generate a wallet
```bash
node client.js init --name alice --out wallet/alice.json
node client.js addr --wallet wallet/alice.json
```

### Send a transaction
1) Get your address UTXOs after your node has forged at least one block:
```bash
RPC=http://localhost:5001/rpc
ADDR=$(node -e "console.log(require('./wallet/alice.json').address)")
curl -s $RPC -d '{"jsonrpc":"2.0","id":1,"method":"getUTXO","params":{"address":"'"$ADDR"'"}}' | jq .
```
2) Send:
```bash
node client.js send --rpc http://localhost:5001/rpc --wallet wallet/alice.json --to <RECIPIENT_ADDR> --amount 10 --fee 1
```

### Other commands
```bash
node client.js whoami --rpc http://localhost:5001/rpc
node client.js utxo --rpc http://localhost:5001/rpc --address <ADDR>
```


## Batch JSON-RPC
POST an array to `/rpc`:
```json
[
  {"jsonrpc":"2.0","id":1,"method":"getTip"},
  {"jsonrpc":"2.0","id":2,"method":"whoami"}
]
```

## WebSocket notifications
Connect to `ws://<host>:<httpPort>/ws` to receive JSON messages:
```json
{"event":"mempool.accept","data":{"txid":"..."}}
{"event":"block.accept","data":{"index":12,"hash":"...","issuer":"A","slot":42}}
```

## Browser demo
Open `web/index.html` in a modern browser. Use RPC like `http://localhost:5001/rpc`, click **Connect WS** for events, generate keys, and send a tx.

## Docker
```bash
docker compose up --build
```
Exposes:
- node1: WS 4001, HTTP 5001
- node2: WS 4002, HTTP 5002
- node3: WS 4003, HTTP 5003
