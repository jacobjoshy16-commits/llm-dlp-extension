#!/usr/bin/env bash
#
# Provision a fresh Ubuntu 22.04/24.04 box for the LLM Data Guard backend.
# Run once, as root, from inside the server/ directory:
#
#     sudo ./setup.sh
#
# Idempotent. Safe to re-run after you pull new code.

set -euo pipefail

APP_DIR=/opt/dlp
DATA_DIR=/var/lib/dlp
CONF_DIR=/etc/dlp

echo "==> packages"
apt-get update -qq
apt-get install -y python3-venv python3-pip nginx sqlite3

echo "==> ollama"
command -v ollama >/dev/null || curl -fsSL https://ollama.com/install.sh | sh
systemctl enable --now ollama || true

echo "==> service account"
id dlp &>/dev/null || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin dlp

echo "==> directories"
mkdir -p "$APP_DIR" "$DATA_DIR" "$CONF_DIR"
install -m 644 receiver.py eod_review.py agent_client.py morning_report.py requirements.txt "$APP_DIR/"

echo "==> virtualenv"
python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install -q --upgrade pip
"$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"

echo "==> shared token"
if [[ ! -f "$CONF_DIR/dlp.env" ]]; then
  TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)
  {
    printf 'DLP_TOKEN=%s\n' "$TOKEN"
    printf 'DLP_DB=/var/lib/dlp/dlp.db\n'
    printf 'DLP_MODEL=qwen2.5:3b\n'
    printf 'OLLAMA_HOST=http://127.0.0.1:11434\n'
    printf 'DLP_SMTP=\n'
    printf 'DLP_MAIL_TO=\n'
  } > "$CONF_DIR/dlp.env"
  echo "    generated a new token"
else
  echo "    keeping existing token"
fi
chmod 640 "$CONF_DIR/dlp.env"
chown root:dlp "$CONF_DIR/dlp.env"

chown -R dlp:dlp "$APP_DIR" "$DATA_DIR"

echo "==> systemd"
install -m 644 dlp-receiver.service dlp-eod.service dlp-eod.timer \
        dlp-report.service dlp-report.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now dlp-receiver.service
systemctl enable --now dlp-eod.timer
systemctl enable --now dlp-report.timer

echo "==> timezone check"
timedatectl show -p Timezone --value | grep -q '^America/Chicago$' \
  || echo "    WARNING: not America/Chicago -- the 17:45 pass will run at the wrong hour."

echo
echo "Done. Receiver on 127.0.0.1:8787."
echo "Token for server-config.js:"
echo
grep DLP_TOKEN "$CONF_DIR/dlp.env" | cut -d= -f2
echo
echo "Next:"
echo "  1. Copy that token into the extension's server-config.js"
echo "  2. Put TLS certs in /etc/ssl/dlp/ and enable nginx-dlp.conf"
echo "  3. Wire score_with_agent() in $APP_DIR/eod_review.py to your agent"
echo "  4. ollama pull \$DLP_MODEL"
echo "  5. Set DLP_SMTP and DLP_MAIL_TO in /etc/dlp/dlp.env for the morning report"
echo "  6. curl -s http://127.0.0.1:8787/health"
