#!/usr/bin/env bash
#
# setup_aws.sh -- Provision AWS backend components locally or on EC2.
# Idempotent helper script.

set -euo pipefail

APP_DIR=/opt/dlp
DATA_DIR=/var/lib/dlp
CONF_DIR=/etc/dlp

echo "==> checking Python and SQLite dependencies"
mkdir -p "$APP_DIR" "$DATA_DIR" "$CONF_DIR"

if [[ ! -d "$APP_DIR/venv" ]]; then
  python3 -m venv "$APP_DIR/venv"
fi

"$APP_DIR/venv/bin/pip" install -q --upgrade pip
"$APP_DIR/venv/bin/pip" install -q -r requirements_aws.txt

echo "==> initializing AWS database schema"
"$APP_DIR/venv/bin/python" -c "import db_aws; db_aws.init_schema()"

echo "==> setup complete. Ready to run receiver_aws.py on port 8787."
