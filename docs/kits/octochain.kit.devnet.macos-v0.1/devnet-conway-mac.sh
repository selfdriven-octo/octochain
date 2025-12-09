#!/usr/bin/env bash
set -euo pipefail
: "${WORKDIR:=$HOME/devnet/conway-one}"
: "${MAGIC:=42}"
: "${OGMIOS_PORT:=1337}"
: "${KUPO_PORT:=1442}"
: "${OGMIOS_IMAGE:=cardanosolutions/cardano-node-ogmios:latest}"
: "${KUPO_IMAGE:=cardanosolutions/kupo:latest}"
: "${CTEST:=cardano-testnet}"
: "${CCLI:=cardano-cli}"
OGMIOS_C=ogmios-local
KUPO_C=kupo-local

usage(){ cat <<'USAGE'
Usage:
  ./devnet-conway-mac.sh up|status|logs|down

Notes:
  - Requires cardano-testnet & cardano-cli in PATH (Conway-capable)
  - Requires Docker Desktop (for Ogmios & Kupo)
USAGE
}

ensure_dirs(){ mkdir -p "$WORKDIR"; }

ensure_node_socket(){
  export CARDANO_NODE_SOCKET_PATH="$WORKDIR/bft1/node.socket"
  [[ -S "$CARDANO_NODE_SOCKET_PATH" ]] || { echo "Missing node.socket at $CARDANO_NODE_SOCKET_PATH"; exit 1; }
}

node_up(){
  ensure_dirs
  pushd "$WORKDIR" >/dev/null
  echo ">> Launching single-node devnet (Conway) via cardano-testnet..."
  "$CTEST" run --num-pools 1 --testnet-magic "$MAGIC" --workspace . --start --era conway
  popd >/dev/null
}

ogmios_up(){
  ensure_node_socket
  echo ">> Ogmios :$OGMIOS_PORT"
  docker rm -f "$OGMIOS_C" >/dev/null 2>&1 || true
  docker run -d --name "$OGMIOS_C" -p "$OGMIOS_PORT:1337" \
    -v "$WORKDIR/configuration.yaml:/config/config.yaml" \
    -v "$WORKDIR/bft1/db:/data/db" \
    -v "$WORKDIR/bft1/node.socket:/ipc/node.socket" \
    -e OGMIOS_NETWORK="privnet" \
    -e OGMIOS_NODE_SOCKET="/ipc/node.socket" \
    -e OGMIOS_NODE_CONFIG="/config/config.yaml" \
    "$OGMIOS_IMAGE" >/dev/null
}

kupo_up(){
  ensure_node_socket
  echo ">> Kupo :$KUPO_PORT"
  docker rm -f "$KUPO_C" >/dev/null 2>&1 || true
  docker run -d --name "$KUPO_C" -p "$KUPO_PORT:1442" \
    -v "$WORKDIR/bft1/node.socket:/node.socket" \
    -v "$WORKDIR/configuration.yaml:/config/config.yaml" \
    "$KUPO_IMAGE" \
    --node-socket /node.socket \
    --node-config /config/config.yaml \
    --workdir /var/lib/kupo \
    --since origin \
    --match '.*' >/dev/null
}

health(){
  ensure_node_socket
  echo "== CLI tip =="
  "$CCLI" query tip --testnet-magic "$MAGIC" || true
  echo "== Ogmios ws =="
  echo "ws://localhost:$OGMIOS_PORT"
  echo "== Kupo health =="
  curl -fsS "http://localhost:$KUPO_PORT/health" || true
}

logs(){
  echo "== Ogmios =="
  docker logs --tail=80 "$OGMIOS_C" || true
  echo "== Kupo =="
  docker logs --tail=80 "$KUPO_C" || true
}

down(){
  docker rm -f "$OGMIOS_C" >/dev/null 2>&1 || true
  docker rm -f "$KUPO_C" >/dev/null 2>&1 || true
  echo "Stopped Ogmios+Kupo containers. Node (cardano-testnet) continues in your shell."
}

case "${1:-}" in
  up) node_up; ogmios_up; kupo_up;
      echo "Export for apps:"
      echo "  export CARDANO_NODE_SOCKET_PATH=\"$WORKDIR/bft1/node.socket\""
      echo "  export OGMIOS_URL=ws://localhost:$OGMIOS_PORT"
      echo "  export KUPO_URL=http://localhost:$KUPO_PORT"
      ;;
  status|health) health ;;
  logs) logs ;;
  down|stop) down ;;
  *) usage ;;
esac
