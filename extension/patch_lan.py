"""
copy of the extension at the Ubuntu server over the LAN.

inside the extension/ folder on the MacBook:
    python3 patch_lan.py 192.168.1.19

Safe to re-run. Works on macOS and Linux.
"""
import io, json, os, re, sys

if len(sys.argv) != 2:
    sys.exit("usage: python3 patch_lan.py <server-ip>   e.g. 192.168.1.19")
ip = sys.argv[1].strip()
if not re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", ip):
    sys.exit(f"'{ip}' does not look like an IP address")

base = f"http://{ip}:8787"
pattern = f"{base}/*"

for f in ("server-config.js", "manifest.json"):
    if not os.path.exists(f):
        sys.exit(f"MISSING {f} - run this from inside the extension/ folder")

s = io.open("server-config.js", encoding="utf-8").read()
if f'base: "{base}"' in s:
    print(f"server-config.js: already points at {base}")
else:
    new = re.sub(r'base:\s*"[^"]*"', f'base: "{base}"', s, count=1)
    if new == s:
        sys.exit("could not find the base line in server-config.js")
    io.open("server-config.js", "w", encoding="utf-8").write(new)
    print(f"server-config.js: base -> {base}")

m = json.load(io.open("manifest.json", encoding="utf-8"))
changed = False
if pattern not in m.get("host_permissions", []):
    m.setdefault("host_permissions", []).append(pattern)
    changed = True
if changed:
    io.open("manifest.json", "w", encoding="utf-8").write(json.dumps(m, indent=2) + "\n")
    print(f"manifest.json: added {pattern} to host_permissions")
else:
    print(f"manifest.json: {pattern} already present")

tok = re.search(r'token:\s*"([^"]*)"', io.open("server-config.js", encoding="utf-8").read())
if tok and tok.group(1) in ("", "dev-token-change-me"):
    print("\nWARNING: token is still the placeholder. Copy the real one from")
    print("  sudo grep DLP_TOKEN /etc/dlp/dlp.env   on the server.")
else:
    print(f"token present: {tok.group(1)[:6]}...{tok.group(1)[-4:]}" if tok else "no token found")

print("\nReload the extension at chrome://extensions and hard-refresh any LLM tabs.")