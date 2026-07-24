"""
Bridge: lets the DLP server's nightly agent ground its verdicts in the county
policy vault built by compliance-agent-fbc (build_vault.py).

This is the ONLY reusable seam between the two projects. The compliance agent
audits policy DOCUMENTS against NIST controls; the DLP server scores employee
PROMPTS for data disclosure. Different inputs, different outputs. What they can
share is the vault.

Install:
    place this file in /opt/dlp/
    then in /opt/dlp/agent_client.py replace the stub retrieve_policy with:
        from dlp_policy_bridge import retrieve_policy
"""

import os

# Absolute path -- the nightly job runs from /opt/dlp under systemd, not from
# the compliance-agent folder, so a relative "./local_db" would silently miss.
VAULT_DIR = os.environ.get("DLP_VAULT_DIR", "/opt/dlp/compliance-agent-fbc/local_db")
COLLECTION = os.environ.get("DLP_VAULT_COLLECTION", "fbc_baseline")
EMBED_MODEL = os.environ.get("DLP_EMBED_MODEL", "all-MiniLM-L6-v2")

# MiniLM silently truncates past ~900 chars; a longer query is wasted work.
EMBED_CAP = 900
K_POLICY = 3

_db = None
_failed = False


def _get_db():
    """Load Chroma + the embedder ONCE. Doing this per prompt would load a
    sentence-transformer model hundreds of times a night."""
    global _db, _failed
    if _db is not None or _failed:
        return _db
    try:
        from langchain_chroma import Chroma
        try:
            from langchain_huggingface import HuggingFaceEmbeddings
        except ImportError:
            from langchain_community.embeddings import HuggingFaceEmbeddings
        _db = Chroma(
            collection_name=COLLECTION,
            persist_directory=VAULT_DIR,
            embedding_function=HuggingFaceEmbeddings(
                model_name=EMBED_MODEL,
                encode_kwargs={"normalize_embeddings": True}),
        )
    except Exception as e:
        # Grounding is an enhancement, never a dependency. If the vault is
        # missing the nightly pass must still run.
        print(f"[policy bridge] vault unavailable, scoring ungrounded: {e}")
        _failed = True
        _db = None
    return _db


def retrieve_policy(text: str) -> str:
    """Return county policy excerpts relevant to this prompt, or '' if none."""
    if not text or not text.strip():
        return ""
    db = _get_db()
    if db is None:
        return ""
    try:
        hits = db.similarity_search(
            text[:EMBED_CAP], k=K_POLICY, filter={"source_type": "county_policy"})
    except Exception as e:
        print(f"[policy bridge] query failed: {e}")
        return ""
    parts = []
    for h in hits:
        m = getattr(h, "metadata", {}) or {}
        label = f"{m.get('doc_name', 'county policy')} - {m.get('control_id', '')}".strip(" -")
        parts.append(f"[{label}]\n{h.page_content}")
    return "\n\n".join(parts)