#!/usr/bin/env bash
#
# Install browser enterprise policy on managed Linux workstations.
#
# Covers Chrome, Chromium, Edge, and Firefox in one pass because on a Linux
# fleet they are all just JSON files in well-known directories -- which makes
# Linux by far the easiest of the three platforms to manage, and worth doing
# first when you are still proving the deployment out.
#
#   sudo ./install-policies.sh <EXTENSION_ID> <POLICY_JSON>
#
# Idempotent. Safe to run from Ansible/Puppet/Salt on every converge.

set -euo pipefail

EXT_ID="${1:-}"
POLICY_FILE="${2:-../samples/policy-baseline.json}"
UPDATE_URL="${DLP_UPDATE_URL:-https://dlp.internal.fortbendcountytx.gov/ext/update.xml}"
XPI_URL="${DLP_XPI_URL:-https://dlp.internal.fortbendcountytx.gov/ext/dlp-guard.xpi}"
GECKO_ID="${DLP_GECKO_ID:-dlp-guard@fortbendcountytx.gov}"

if [[ -z "$EXT_ID" ]]; then
  echo "usage: sudo $0 <EXTENSION_ID> [policy.json]" >&2
  echo "  EXTENSION_ID is the 32-char Chrome/Edge id (see chrome://extensions)" >&2
  exit 1
fi

if [[ ! -f "$POLICY_FILE" ]]; then
  echo "policy file not found: $POLICY_FILE" >&2
  exit 1
fi

need_root() { [[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }; }
need_root

command -v python3 >/dev/null || { echo "python3 required" >&2; exit 1; }

# Per-machine attribution. The hostname is the closest thing to a stable
# workstation identifier that exists without touching an inventory system, and
# an attribution that is present-but-generic is worse than useless -- so make
# it actually distinguish machines.
WORKSTATION_TAG="${DLP_WORKSTATION_TAG:-$(hostname -s)}"

echo "==> extension id : $EXT_ID"
echo "==> workstation  : $WORKSTATION_TAG"

# ---------- Chromium-family ----------
#
# Chrome reads two SEPARATE policy trees and they are easy to confuse:
#   .../policies/managed/*.json          browser policy (force-install)
#   the "3rdparty" key inside the same   extension's managed storage
# Both go in the same file here.

write_chromium_policy() {
  local dir="$1" label="$2"
  [[ -d "$(dirname "$dir")" ]] || return 0
  mkdir -p "$dir"

  python3 - "$dir/dlp_data_guard.json" "$POLICY_FILE" "$EXT_ID" \
            "$UPDATE_URL" "$WORKSTATION_TAG" <<'PY'
import json, sys
out_path, policy_path, ext_id, update_url, tag = sys.argv[1:6]
with open(policy_path) as f:
    policy = json.load(f)
policy = {k: v for k, v in policy.items() if not k.startswith("_")}
policy["workstationTag"] = tag
doc = {
    "ExtensionInstallForcelist": [f"{ext_id};{update_url}"],
    "ExtensionSettings": {
        ext_id: {
            "installation_mode": "force_installed",
            "update_url": update_url,
            "toolbar_pin": "force_pinned",
        }
    },
    "3rdparty": {"extensions": {ext_id: policy}},
}
with open(out_path, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
PY
  chmod 644 "$dir/dlp_data_guard.json"
  echo "    $label -> $dir/dlp_data_guard.json"
}

echo "==> chromium-family policy"
write_chromium_policy /etc/opt/chrome/policies/managed        "chrome"
write_chromium_policy /etc/chromium/policies/managed          "chromium"
write_chromium_policy /etc/chromium-browser/policies/managed  "chromium-browser"
write_chromium_policy /etc/opt/edge/policies/managed          "edge"
write_chromium_policy /etc/opt/microsoft/msedge/policies/managed "msedge"

# ---------- Firefox ----------
#
# Firefox merges nothing: policies.json is read whole, so writing our own file
# would clobber any existing policy. Merge into the existing document instead.

echo "==> firefox policy"
for FFDIR in /etc/firefox/policies /usr/lib/firefox/distribution \
             /usr/lib64/firefox/distribution /opt/firefox/distribution; do
  [[ -d "$(dirname "$FFDIR")" ]] || continue
  mkdir -p "$FFDIR"
  python3 - "$FFDIR/policies.json" "$POLICY_FILE" "$GECKO_ID" \
            "$XPI_URL" "$WORKSTATION_TAG" <<'PY'
import json, os, sys
out_path, policy_path, gecko_id, xpi_url, tag = sys.argv[1:6]
with open(policy_path) as f:
    policy = json.load(f)
policy = {k: v for k, v in policy.items() if not k.startswith("_")}
policy["workstationTag"] = tag

doc = {}
if os.path.exists(out_path):
    try:
        with open(out_path) as f:
            doc = json.load(f)
    except Exception:
        doc = {}   # a corrupt existing file is not a reason to abort the run
doc.setdefault("policies", {})
doc["policies"].setdefault("ExtensionSettings", {})[gecko_id] = {
    "installation_mode": "force_installed",
    "install_url": xpi_url,
    "default_area": "navbar",
}
doc["policies"].setdefault("3rdparty", {}).setdefault("Extensions", {})[gecko_id] = policy
with open(out_path, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
PY
  chmod 644 "$FFDIR/policies.json"
  echo "    -> $FFDIR/policies.json"
done

cat <<EOF

Done.

Verify on the workstation:
  chrome://policy    then "Reload policies"
  about:policies     (Firefox)

The check that actually matters is the EXTENSION section of chrome://policy,
not the browser section. Browser policy applying while extension policy shows
nothing means the extension ID in the path does not match the installed
extension -- a mismatch that produces no error and silently degrades every
workstation to compiled-in defaults.

Also confirm attribution landed:
  the extension's options page should show workstationTag = $WORKSTATION_TAG
EOF
