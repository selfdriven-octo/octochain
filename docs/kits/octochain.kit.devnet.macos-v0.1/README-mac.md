# macOS one-node Conway devnet runner

## 1) Make executable
```bash
chmod +x devnet-conway-mac.sh devnet-stop.sh
```

## 2) Start
```bash
./devnet-conway-mac.sh up
```
This starts the node via `cardano-testnet`, then launches Ogmios (1337) and Kupo (1442) in Docker.

## 3) Health
```bash
./devnet-conway-mac.sh status
```

## 4) Stop indexers
```bash
./devnet-conway-mac.sh down
# or
./devnet-stop.sh
```

## App environment
```bash
export CARDANO_NODE_SOCKET_PATH=$HOME/devnet/conway-one/bft1/node.socket
export OGMIOS_URL=ws://localhost:1337
export KUPO_URL=http://localhost:1442
```
