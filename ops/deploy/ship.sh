#!/usr/bin/env bash
# Copies the code from this laptop to the server and runs the set-up there (Git Bash on Windows works:
# it needs only tar and ssh). The local data, .env and installed packages are never copied.
#
#   bash ops/deploy/ship.sh ubuntu@<server> [--no-start]
set -euo pipefail
HOST="${1:?usage: ship.sh user@server [--no-start]}"
shift
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE="/tmp/ai-lead-engine-$(date +%Y%m%d%H%M%S)"

echo "packing $ROOT"
tar -C "$ROOT" --exclude=./data --exclude=./.env --exclude='*/node_modules' --exclude='*/.venv' --exclude='*/__pycache__' \
    --exclude=./design --exclude=./research -czf - . | ssh "$HOST" "mkdir -p $STAGE && tar -xzf - -C $STAGE"
echo "running the set-up on $HOST"
ssh -t "$HOST" "sudo bash $STAGE/ops/deploy/setup.sh $* && rm -rf $STAGE"
