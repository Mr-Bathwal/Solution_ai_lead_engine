#!/usr/bin/env bash
# Writes /opt/ai-lead-engine/.env from AWS Systems Manager Parameter Store (design 7.11: secrets live
# there, never in the repository). Each parameter under the prefix becomes one line: the parameter
# /leadengine/prod/CONTACT_KEY_SECRET becomes CONTACT_KEY_SECRET=<value>. Needs the AWS CLI and an
# instance role allowed ssm:GetParametersByPath and kms:Decrypt on that prefix.
#
#   sudo bash ops/deploy/env_from_ssm.sh [/leadengine/prod] [region]
set -euo pipefail
PREFIX="${1:-/leadengine/prod}"
REGION="${2:-ap-south-1}"
OUT=/opt/ai-lead-engine/.env
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

aws ssm get-parameters-by-path --region "$REGION" --path "$PREFIX" --recursive --with-decryption \
  --query 'Parameters[].[Name,Value]' --output text |
while IFS=$'\t' read -r name value; do
  key="${name##*/}"
  [[ "$key" =~ ^[A-Z0-9_]+$ ]] || { echo "skipping $name: not an environment variable name" >&2; continue; }
  printf '%s=%s\n' "$key" "$value" >> "$TMP"
done
[[ -s "$TMP" ]] || { echo "no parameters under $PREFIX in $REGION"; exit 1; }
sort -o "$TMP" "$TMP"
install -m 600 -o leadengine -g leadengine "$TMP" "$OUT"
echo "wrote $(wc -l < "$OUT") settings to $OUT (values not shown)"
