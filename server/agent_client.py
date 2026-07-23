"""
Semantic compliance scoring via local Ollama.

This is tier 2's brain. The regex tier catches formatted identifiers; this tier
exists for the thing regex structurally cannot see -- an employee describing a
resident's case in ordinary prose, with no pattern anywhere in it.

CRITICAL DESIGN CONSTRAINT
--------------------------
Inference stays on this box. Do not swap this for a hosted API to chase a few
accuracy points. The text being scored is exactly the county data the whole
project exists to keep out of third-party LLMs -- shipping it to one in order to
check whether it was shipped to one is self-defeating, and it is the first thing
an auditor will find. If the dedicated team ever proposes a hosted model here,
that is the objection to raise.
"""

import json
import os
from concurrent.futures import ThreadPoolExecutor

import urllib.request

OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
MODEL = os.environ.get("DLP_MODEL", "qwen2.5:3b")
WORKERS = int(os.environ.get("DLP_WORKERS", "1"))
NUM_CTX = int(os.environ.get("DLP_NUM_CTX", "8192"))

SYSTEM = """You review text that a county employee submitted to a public AI chat
service. Decide whether it disclosed non-public county information.

Treat as HIGH risk:
- Any identifiable resident, employee, or minor described alongside their
  circumstances, even with no ID numbers present
- Active case, investigation, or litigation detail
- Personnel matters, discipline, medical or benefits information
- Non-public infrastructure, system, or security detail
- Draft policy, contract, or budget material not yet released

Treat as LOW risk:
- Public record information already published by the county
- Generic professional questions with no county specifics

Treat as NONE:
- General knowledge, drafting help, code, or technical questions with no county
  content at all

Judge the text as written. Do not assume benign intent to excuse a disclosure,
and do not invent details that are not present."""

SCHEMA_HINT = """Respond with JSON only, no prose:
{"risk":"none|low|high","categories":["..."],"rationale":"one sentence"}"""


def retrieve_policy(text: str) -> str:
    """
    OPTIONAL HOOK: query your existing ChromaDB policy index and return the 1-3
    most relevant policy excerpts. Grounding the verdict in an actual county
    policy is what turns 'the model flagged it' into something a supervisor can
    act on. Return "" to score without grounding.
    """
    return ""


def _score_one(text: str) -> dict:
    grounding = retrieve_policy(text)
    prompt = (
        f"{SCHEMA_HINT}\n\n"
        + (f"Relevant county policy:\n{grounding}\n\n" if grounding else "")
        + f"Submitted text:\n<<<\n{text[:8000]}\n>>>"
    )

    body = json.dumps(
        {
            "model": MODEL,
            "system": SYSTEM,
            "prompt": prompt,
            "format": "json",
            "stream": False,
            "options": {"temperature": 0, "num_ctx": NUM_CTX},
        }
    ).encode()

    req = urllib.request.Request(
        f"{OLLAMA}/api/generate", data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            raw = json.loads(r.read())["response"]
        verdict = json.loads(raw)
    except Exception as exc:
        # Fail loud, not silent. An unscored item must stay pending, not be
        # quietly recorded as clean.
        return {"risk": "error", "categories": [], "rationale": str(exc)[:200]}

    risk = str(verdict.get("risk", "error")).lower()
    if risk not in {"none", "low", "high"}:
        risk = "error"
    return {
        "risk": risk,
        "categories": verdict.get("categories", [])[:6],
        "rationale": str(verdict.get("rationale", ""))[:400],
        "model": MODEL,
    }


HISTORY_SYSTEM = """You review the complete set of prompts one county employee
submitted to public AI chat services in a single day, in order. Individual
prompts have already been screened; your job is the picture they form TOGETHER.

Look specifically for:
- Cumulative disclosure: details spread across prompts that individually look
  harmless but together identify a resident, case, employee, or system
- Patterns of feeding county work product into a public service (documents
  pasted piece by piece, ongoing case discussion, drafting from internal records)
- Escalation over the day after warnings

Treat as HIGH only when the combined history discloses non-public county
information or shows sustained feeding of county records into a public service.
Judge only what is present. Do not invent details."""


def score_user_history(employee: str, prompts: list[str]) -> dict:
    """One verdict over a user's full day of prompts, oldest first. Capped to
    fit the local model's context; truncation keeps the earliest prompts and
    is disclosed to the model."""
    CAP = int(os.environ.get("DLP_HISTORY_CHARS", "12000"))
    PER = max(400, CAP // max(1, len(prompts)))
    joined = ""
    used = 0
    for i, p in enumerate(prompts):
        excerpt = p if len(p) <= PER else (
            p[:PER] + f"\n[... {len(p) - PER} more chars in this prompt ...]"
        )
        block = f"\n--- prompt {i + 1} ---\n{excerpt}"
        if len(joined) + len(block) > CAP:
            joined += f"\n--- {len(prompts) - i} later prompts omitted for length ---"
            break
        joined += block
        used += 1

    prompt = (
        f"{SCHEMA_HINT}\n\nEmployee: {employee}\n"
        f"Prompts submitted today ({len(prompts)} total, {used} shown):\n<<<{joined}\n>>>"
    )
    body = json.dumps(
        {
            "model": MODEL,
            "system": HISTORY_SYSTEM,
            "prompt": prompt,
            "format": "json",
            "stream": False,
            "options": {"temperature": 0, "num_ctx": NUM_CTX},
        }
    ).encode()
    req = urllib.request.Request(
        f"{OLLAMA}/api/generate", data=body, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            raw = json.loads(r.read())["response"]
        verdict = json.loads(raw)
    except Exception as exc:
        return {"risk": "error", "categories": [], "rationale": str(exc)[:200]}

    risk = str(verdict.get("risk", "error")).lower()
    if risk not in {"none", "low", "high"}:
        risk = "error"
    return {
        "risk": risk,
        "categories": verdict.get("categories", [])[:6],
        "rationale": str(verdict.get("rationale", ""))[:400],
        "model": MODEL,
    }


def score_with_agent(prompts: list[str]) -> list[dict]:
    """One call per prompt. Batching several into a single call is faster but
    the model drifts on which verdict belongs to which input, and a misaligned
    verdict is worse than a slow one. Volume here is tens per day, not thousands."""
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        return list(pool.map(_score_one, prompts))
