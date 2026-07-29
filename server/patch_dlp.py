"""Apply the lightweight-model changes. Run from inside the server/ folder:
       python3 patch_dlp.py
   Safe to run more than once."""
import io, os, sys

# (file, marker_that_means_already_done, old_text, new_text)
EDITS = [
    ("agent_client.py", '"DLP_MODEL", "qwen2.5:3b"',
     '"DLP_MODEL", "glm-5.2"', '"DLP_MODEL", "qwen2.5:3b"'),
    ("agent_client.py", '"DLP_WORKERS", "1"',
     '"DLP_WORKERS", "3"', '"DLP_WORKERS", "1"'),
    ("agent_client.py", "NUM_CTX = int(",
     'WORKERS = int(os.environ.get("DLP_WORKERS", "1"))',
     'WORKERS = int(os.environ.get("DLP_WORKERS", "1"))\n'
     'NUM_CTX = int(os.environ.get("DLP_NUM_CTX", "8192"))'),
    ("agent_client.py", '"num_ctx": NUM_CTX',
     '"options": {"temperature": 0},',
     '"options": {"temperature": 0, "num_ctx": NUM_CTX},'),
    ("agent_client.py", "timeout=600", "timeout=120", "timeout=600"),
    ("agent_client.py", "timeout=900", "timeout=180", "timeout=900"),
    ("agent_client.py", "DLP_HISTORY_CHARS", "    CAP = 24000",
     '    CAP = int(os.environ.get("DLP_HISTORY_CHARS", "12000"))\n'
     "    PER = max(400, CAP // max(1, len(prompts)))"),
    ("agent_client.py", "excerpt = p if len(p)",
     '        block = f"\\n--- prompt {i + 1} ---\\n{p}"',
     "        excerpt = p if len(p) <= PER else (\n"
     '            p[:PER] + f"\\n[... {len(p) - PER} more chars in this prompt ...]"\n'
     "        )\n"
     '        block = f"\\n--- prompt {i + 1} ---\\n{excerpt}"'),
    ("setup.sh", "DLP_MODEL=qwen2.5:3b", "DLP_MODEL=glm-5.2", "DLP_MODEL=qwen2.5:3b"),
]

for path, marker, old, new in EDITS:
    if not os.path.exists(path):
        print("MISSING %s - run this from inside the server/ folder" % path)
        sys.exit(1)
    s = io.open(path, encoding="utf-8").read()
    if marker in s:
        print("already done: %s" % marker[:40])
        continue
    if old not in s:
        print("NOT FOUND in %s: %s" % (path, old[:50]))
        sys.exit(1)
    io.open(path, "w", encoding="utf-8").write(s.replace(old, new))
    print("applied: %s" % marker[:40])

print("\nDone. Now run:  python3 -m py_compile agent_client.py && echo OK")