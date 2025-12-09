#!/usr/bin/env bash
set -euo pipefail
: "${OGMIOS_C:=ogmios-local}"
: "${KUPO_C:=kupo-local}"
docker rm -f "$OGMIOS_C" >/dev/null 2>&1 || true
docker rm -f "$KUPO_C" >/dev/null 2>&1 || true
echo "Stopped Ogmios+Kupo."
