"""
Point a dev build at a backend on the LAN.

    python3 tools/patch_lan.py 192.168.1.19

WHAT CHANGED FROM v1
--------------------
The old extension/patch_lan.py edited manifest.json in place. There is no
manifest to edit any more -- it is generated per browser target from the site
catalog, and a hand-edit would be overwritten by the next build.

So this writes the backend origin to extension/backend-origins.json instead,
which tools/build.mjs reads and merges into host_permissions for every target.
Same outcome, survives a rebuild.

This is dev tooling. In production the endpoint comes from managed policy and
this script is not involved -- see enterprise/README.md.

Safe to re-run. Works on macOS and Linux.
"""

import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")
CONFIG = os.path.join(EXT, "server-config.js")
EXAMPLE = os.path.join(EXT, "server-config.example.js")
ORIGINS = os.path.join(EXT, "backend-origins.json")

if len(sys.argv) != 2:
    sys.exit("usage: python3 tools/patch_lan.py <server-ip>   e.g. 192.168.1.19")

ip = sys.argv[1].strip()
if not re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", ip):
    sys.exit(f"'{ip}' does not look like an IP address")

base = f"http://{ip}:8787"
pattern = f"{base}/*"

# server-config.js is gitignored because it carries a token. On a clean
# checkout it does not exist yet, so seed it from the example rather than
# failing -- the whole point of this script is getting to a working dev loop
# in one command.
if not os.path.exists(CONFIG):
    if not os.path.exists(EXAMPLE):
        sys.exit("neither server-config.js nor server-config.example.js found")
    io.open(CONFIG, "w", encoding="utf-8").write(
        io.open(EXAMPLE, encoding="utf-8").read()
    )
    print("server-config.js: created from example")

s = io.open(CONFIG, encoding="utf-8").read()
if f'base: "{base}"' in s:
    print(f"server-config.js: already points at {base}")
else:
    new = re.sub(r'base:\s*"[^"]*"', f'base: "{base}"', s, count=1)
    if new == s:
        sys.exit("could not find the base line in server-config.js")
    io.open(CONFIG, "w", encoding="utf-8").write(new)
    print(f"server-config.js: base -> {base}")

origins = []
if os.path.exists(ORIGINS):
    try:
        origins = json.load(io.open(ORIGINS, encoding="utf-8"))
    except Exception:
        origins = []
if pattern in origins:
    print(f"backend-origins.json: {pattern} already present")
else:
    origins.append(pattern)
    io.open(ORIGINS, "w", encoding="utf-8").write(json.dumps(origins, indent=2) + "\n")
    print(f"backend-origins.json: added {pattern}")

tok = re.search(r'token:\s*"([^"]*)"', io.open(CONFIG, encoding="utf-8").read())
if tok and tok.group(1) in ("", "dev-token-change-me"):
    print("\nWARNING: token is still the placeholder. Copy the real one from")
    print("  sudo grep DLP_TOKEN /etc/dlp/dlp.env   on the server.")
elif tok:
    print(f"token present: {tok.group(1)[:6]}...{tok.group(1)[-4:]}")

print("\nNow rebuild, then reload the unpacked extension:")
print("  npm run build")
print("\nIf events still queue with no error, the backend origin is missing from")
print("host_permissions -- check the generated dist/<target>/manifest.json.")
