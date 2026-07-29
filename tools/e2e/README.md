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

---

# Fleet simulation (`fleet.mjs`)

`run.mjs` proves the pipeline is **correct** with three workstations. `fleet.mjs`
proves it **survives an enterprise**, which fails for different reasons.

```bash
npm run e2e:fleet                              # 40 boxes, 9 OUs, 60 days
node tools/e2e/fleet.mjs --boxes 100 --days 60 # push harder
```

Each box runs the real content scripts in its own `vm` context with its own
`background.js` module graph. 9 OUs mirror
`enterprise/samples/policy-departments.json`, each with a prompt profile
matching what that department actually types — the only way policy divergence
shows up as behavior rather than a config diff.

Covers: departmental modes resolving differently per OU, concurrent flush under
one SQLite writer, a whole-fleet lock storm, 60 days of accumulated archive,
purge at the boundary on a populated DB, investigator workflow, and the nightly
jobs at scale.

## Two real bugs this found

**1. Category mode silently downgraded secrets.** The same credential leak
resolved to `allow`, `warn`, or `block` depending only on which site the
employee happened to open. IT's overlay sets `code_ai: "warn"` so stack traces
stop being blocked and `enterprise_ai: "monitor"` because the tenant is
sanctioned — both also un-blocked API keys, which that overlay's own notes say
must "stay live".

Fixed with `ALWAYS_ENFORCE` in `policy.js`: `credential` and `private_key`
block in every mode above `off`. Explicit `exemptRules` still override — the
floor stops *silent* downgrades, not admin control.

The monitor case needed a second pass. Blocking on a sanctioned tenant seems
wrong until you separate the two things: a DPA governs how a vendor handles
data you *meant* to send. It says nothing about an API key you didn't. A pasted
credential is compromised regardless of destination.

**Only visible at 100 boxes.** At 40 the sanctioned-tenant path came up too
rarely to notice — the argument for running the fleet test larger than feels
necessary.

**2. A harness race that looked like an extension bug.** `submit()` set
`globalThis.chrome`, then awaited; another box overwrote it mid-await, so events
landed in the wrong storage. Presented as "only 3 of 12 workstations attributed"
— indistinguishable from broken attribution. Fixed by serializing the
ambient-global sections (`withBrowser`); the work still overlaps, which is what
the concurrency test is about. A real fleet has one process per box and no such
coupling.

## One assertion that was wrong, not the code

"Legal always blocks its leak" failed on `m365.cloud.microsoft`. That is correct
behavior — legal's overlay sets `enterprise_ai: "warn"` deliberately. The real
invariant is **never silently allowed**, which is what it now asserts.

## Measured (2-core sandbox — shape, not a benchmark)

| | 40 boxes | 100 boxes |
|---|---|---|
| Boot | 7ms/box | 6ms/box |
| Submit | ~1300/s | ~1960/s |
| Concurrent flush | 5.7s | 13.0s |
| Lock storm | 6.0s | 13.3s |
| Purge (60d) | 47ms | 60ms |
| Nightly scoring | 106 items / 37ms | 265 items / 42ms |

Flush time scales linearly with box count — SQLite serializes writers, and this
is where a real fleet will feel it first. `archive.py stats` projects storage
and warns before the box becomes the problem.

## Still not proven

No browser: DOM interception is untested. And this is a correctness test under
concurrency, not a load test — a 2-core sandbox is not a county server.
