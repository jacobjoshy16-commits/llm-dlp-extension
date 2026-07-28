# End-to-end test

Simulated fleet → real HTTP → real server → nightly agent → morning report.

```bash
npm run e2e:setup    # once: venv + fastapi/uvicorn
npm run e2e          # ~4 seconds, 41 assertions
npm run e2e -- --keep    # retain the database and generated reports
```

## What is real, and what is not

The point of this test is that it can **fail because the extension is broken**.
A harness that reimplements the extension's logic only proves the harness
works, so nothing here reimplements anything.

| Real | Faked |
|---|---|
| `rules.js`, `sites.js`, `policy.js`, `conversation.js` loaded verbatim into a `vm` context | `chrome.*` — in-memory storage over a Map |
| `background.js` imported as a genuine ES module (its alarms and listeners actually register) | the DOM — text goes straight to the decision path |
| `receiver.py` under uvicorn on a real port | the clock — alarms are fired by hand |
| Genuine `fetch()` over TCP | the model — a deterministic stub replaces Ollama |
| `eod_review.py` and `morning_report.py`, byte-identical | |
| SQLite, the real schema, the real migration | |

Content scripts load through `vm.createContext`, which reproduces Chrome's
isolated world: separate top-level scripts, one shared global, top-level
`const` staying in script scope. That is the same harness that caught
`DLP_RULES` never reaching `globalThis`.

## What it covers

**The day** — clean prompts, an SSN block, a warn plus override, a sanctioned
enterprise tool that monitors instead of blocking, a `neverScan` host that is
never inspected, CJIS vocabulary, and an identifier split across two messages
that only the context layer can see.

**The pipeline** — tier 1 metadata flushed on the alarm, tier 2 bodies shipped
on workstation lock, local queues draining only after a 200, per-employee and
per-engine attribution surviving the round trip.

**The jobs** — `eod_review.py` scoring every staged item, `morning_report.py`
producing both HTML artifacts.

**The promises**, checked against artifacts rather than asserted in prose:

- cleared bodies are `NULL` after scoring; flagged bodies are retained
- the emailed summary contains **no** raw SSN; the `0600` reviewer file does
- `chatgpt.com` and `chat.openai.com` roll up to one tool in coverage
- events survive an unreachable server instead of vanishing

## Three harness bugs worth knowing about

Each of these made the test lie before it was fixed, and each is a real
property of the runtime rather than a typo:

1. **Node 22's `navigator` is getter-only.** Plain assignment throws, and
   `browser-compat.js` reads `navigator.userAgent` at module scope to pick the
   engine. Needs `Object.defineProperty`.

2. **One `chrome` stub per workstation, memoized.** `browser-compat.js`
   captures the namespace at module scope. Handing out a fresh object per call
   left the worker writing into a storage area nobody read.

3. **A `?ws=` cache-buster on `background.js` is not enough.** Its static
   imports carry no query, so every workstation shared one instance of
   `browser-compat.js` — and therefore one captured `chrome`. The second box
   wrote into the first box's storage, which looked exactly like "only WS-101
   reports". Fixed by copying the extension into a per-workstation temp dir,
   giving each a distinct module graph, which is what separate browser
   processes have in reality.

## Stubbing the model

`PYTHONPATH` cannot shadow `agent_client`: Python puts the script's own
directory at the front of `sys.path`, so `from agent_client import ...` inside
`server/eod_review.py` always resolves to `server/agent_client.py` and tries to
reach Ollama on localhost.

So the jobs are copied into a sandbox directory next to a stub of the same
name. The scripts under test are byte-identical; only their neighbour changes.

## What it still does not prove

No browser is involved, so **DOM interception is untested** — Enter-key
capture, send-button clicks, the shadow-DOM overlay, `.xlsx` attachment
parsing. The README already calls for a synthetic test that loads each site and
confirms a known-bad string is blocked; that needs a headless browser and is
the remaining gap.

Nor is this a load test. Three workstations and a handful of prompts exercise
correctness, not throughput.
