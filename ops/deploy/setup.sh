#!/usr/bin/env bash
# Sets up (or updates) the lead engine on one Linux server: Ubuntu 22.04 or 24.04, or Amazon Linux
# 2023, on the existing server or an AWS t4g.small in Mumbai (design 9). Safe to run again: each step
# checks what is already there. Run as root from the unpacked repository:
#
#   sudo bash ops/deploy/setup.sh                    install or update, then the go/no-go check
#   sudo bash ops/deploy/setup.sh --no-start         install, but leave the services stopped
#
# It never writes secrets: /opt/ai-lead-engine/.env comes from AWS Parameter Store
# (ops/deploy/env_from_ssm.sh) or is copied in by hand, mode 600, owner leadengine.
set -euo pipefail

APP=/opt/ai-lead-engine
USER_NAME=leadengine
LOGS=/var/log/leadengine
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
START=1
[[ "${1:-}" == "--no-start" ]] && START=0

say() { printf '\n== %s\n' "$*"; }
need_root() { [[ $EUID -eq 0 ]] || { echo "run as root (sudo)"; exit 2; }; }
need_root

say "packages"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git python3 python3-venv python3-pip logrotate cron >/dev/null
  # Ubuntu 22.04 ships Python 3.10; the data side needs 3.11 or newer
  python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || apt-get install -y -qq python3.11 python3.11-venv >/dev/null
  if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  fi
elif command -v dnf >/dev/null; then
  dnf install -y -q ca-certificates curl git python3.11 python3.11-pip logrotate cronie nodejs22 >/dev/null || dnf install -y -q nodejs >/dev/null
  systemctl enable --now crond >/dev/null
else
  echo "neither apt-get nor dnf found: install Node.js 22 and Python 3.11+ by hand, then run again"; exit 2
fi
PY="$(command -v python3.12 || command -v python3.11 || command -v python3)"
"$PY" -c 'import sys; assert sys.version_info >= (3, 11), sys.version' || { echo "Python 3.11 or newer is needed"; exit 2; }
echo "node $(node -v), $($PY --version)"

say "time zone"
# the schedule's times are IST; Ubuntu's cron ignores CRON_TZ, so the server itself keeps IST
timedatectl set-timezone Asia/Kolkata 2>/dev/null || ln -sf /usr/share/zoneinfo/Asia/Kolkata /etc/localtime

say "user and folders"
id "$USER_NAME" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$USER_NAME"
mkdir -p "$APP" "$LOGS" "$APP/data"
if [[ "$SRC" != "$APP" ]]; then
  # copy the code, never the local data, secrets or installed packages
  tar -C "$SRC" --exclude=./data --exclude=./.env --exclude='*/node_modules' --exclude='*/.venv' --exclude='*/__pycache__' -cf - . | tar -C "$APP" -xf -
fi
chown -R "$USER_NAME:$USER_NAME" "$APP" "$LOGS"
if [[ -f "$APP/.env" ]]; then chmod 600 "$APP/.env"; chown "$USER_NAME:$USER_NAME" "$APP/.env"; else echo "no $APP/.env yet: run ops/deploy/env_from_ssm.sh or copy it in (see .env.example)"; fi

say "Node.js services"
sudo -u "$USER_NAME" bash -c "cd $APP/services && npm ci --omit=dev --no-audit --no-fund --silent"

say "Python data side"
sudo -u "$USER_NAME" bash -c "cd $APP/ingest && [[ -d .venv ]] || $PY -m venv .venv; .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q -e '.[s3]'"

say "systemd services"
for unit in worker pages admin; do
  install -m 644 "$APP/ops/deploy/leadengine-$unit.service" "/etc/systemd/system/leadengine-$unit.service"
done
systemctl daemon-reload

say "schedule and logs"
install -m 644 "$APP/ops/deploy/leadengine.cron" /etc/cron.d/leadengine
install -m 644 "$APP/ops/deploy/logrotate.conf" /etc/logrotate.d/leadengine

if [[ -f "$APP/.env" ]]; then
  say "database"
  sudo -u "$USER_NAME" bash -c "cd $APP/services && node src/cli.js migrate"
  if [[ $START -eq 1 ]]; then
    say "starting"
    systemctl enable --now leadengine-worker leadengine-pages leadengine-admin
    systemctl restart leadengine-worker leadengine-pages leadengine-admin
    sleep 3
    systemctl --no-pager --lines=0 status leadengine-worker leadengine-pages leadengine-admin || true
  fi
  say "go/no-go check"
  sudo -u "$USER_NAME" bash -c "cd $APP/services && node src/cli.js preflight --live" || true
fi
echo
echo "Done. The go/no-go check above lists what is still missing; nothing is sent while OUTREACH_TRANSPORT=outbox."
