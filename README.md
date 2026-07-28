# County LLM DLP

MV3 extension that inspects text before it is submitted to AI services and
blocks submissions containing protected county data.

Covers **~99 AI applications** across **Chrome, Edge, Firefox, Chromium, and
Safari**, force-installable by enterprise policy, with per-department
enforcement modes and heuristic detection of AI sites that are not in the
catalog.

For fleet deployment — GPO, Intune, MDM, Ansible — see
**[enterprise/README.md](enterprise/README.md)**. Everything below describes how
the thing works.

## Load it (development)

```bash
npm test           # 67 tests: matcher, policy resolver, and conversation context
npm run build      # generates dist/chrome-catalog, dist/firefox-catalog, ...
```

1. `chrome://extensions` → Developer mode → **Load unpacked** → `dist/chrome-catalog`.
   (Firefox: `about:debugging` → Load Temporary Add-on → `dist/firefox-catalog/manifest.json`)
2. Open chatgpt.com, type `SSN: 123-45-6789`, press Enter. It should be blocked.
3. Type an ordinary question. It should go through with a short delay.
4. Open the extension's options page to see mode, coverage, and queue depth.

**Do not load the `extension/` folder directly.** It has no manifest — the
manifest is generated per browser target from the site catalog, because
maintaining ninety-nine hostnames in two lists by hand guarantees drift.

## How it decides

`rules.js` runs entirely in the browser. Nothing is sent to the server in order
to make the block/allow decision. The service worker forwards **event metadata
only**: site, timestamp, character count, a SHA-256 of the prompt, and redacted
samples of what matched. Prompt bodies never leave the workstation.

This is the single most important design constraint. If you forward full prompt
text for server-side classification, your event database becomes a searchable
archive of every SSN and case file an employee ever pasted — a higher-value
target than the thing you were protecting.

## Interception points

| Point | Why |
|---|---|
| `keydown` Enter, capture phase | Primary submit path on every major LLM site |
| Send-button `click`, capture phase | Mouse users and mobile-width layouts |
| `paste`, capture phase | Highest-yield signal — bulk leaks are pasted, not typed |
| `change` on file inputs / `drop` | Attached .xlsx and .docx, parsed in-browser |

All run at `document_start` in the capture phase so they fire before the page's
own handlers. Running after means the request is already in flight.

Every handler is installed immediately but no-ops until policy resolves. Waiting
to attach until the policy arrives would lose the first submit on a fast-loading
page — which is the one submit a user notices.

## Before you deploy

- **Tune the rules.** Run `DLP_RULES.scan()` over a corpus of real county
  documents and a corpus of ordinary work questions. Measure false positives.
  A tool that blocks legitimate work gets uninstalled or worked around within a
  week — that is how DLP pilots die.
- **Start in `monitor`, not `enforce`.** Run a pilot department for two weeks
  and count how many blocks would have been false positives. That number is
  what you bring to the meeting where someone asks whether this is ready. The
  point above is unmeasurable without it.
- **Selector rot.** `data-testid*="send"` will break when OpenAI or Anthropic
  ships a UI change. Budget for monthly checks, and add a synthetic test that
  loads each site and confirms a known-bad string is still blocked. When it
  does break, the fix is a policy push (an `extraSites` entry reusing the
  catalog `id` replaces its selectors) rather than a build cycle.
- **Give people an approved alternative.** Blocking without offering the county's
  internal AI tool converts employees into adversaries who will use their phones.
  This is why sanctioned tools default to `monitor` instead of `enforce`: the
  internal assistant is the destination you *want* traffic going to, and
  blocking there pushes it somewhere you cannot see.
- **Extend `neverScan`.** Your payroll, benefits, and case-management vendors
  belong on it before pilot. A case management system is exactly where an
  employee legitimately types an SSN all day, and it is a page where the
  extension reading composer text is itself the privacy problem.

## Two-tier design

| | Tier 1 — real time | Tier 2 — end of day |
|---|---|---|
| Runs | In the browser, before submit | On the Ubuntu box, 17:45 CT |
| Sees | Every prompt | Only prompts tier 1 could not clear |
| Method | Regex / pattern match | Compliance agent, semantic read |
| Catches | Formatted identifiers (SSN, cards, keys) | Prose leaks with no pattern |
| Can block? | Yes | No — detection only, after the fact |
| Retains | Metadata + hash | Verdict + hash; **body deleted after scoring** |

Clean prompts never enter tier 2. Their text is never written to disk and never
reaches the server. That is what keeps the review corpus small enough to defend
to an auditor: it is the set that already looked risky, not a transcript of
everything every employee typed.

### When the batch ships

The extension pushes staged items on whichever comes first:

- 17:30 local time (`eodHour` / `eodMinute`, settable by group policy)
- Workstation lock — the practical "session ended" signal on a shared desktop
- Browser startup, if a previous batch never made it out

Staged text is purged locally the moment the server returns 200, and hard-purged
after 72 hours if the server stays unreachable, with a `gap` event recorded.
Holding sensitive text on a workstation indefinitely because a server is down is
worse than losing the audit trail.

### Server

```
pip install fastapi uvicorn
uvicorn receiver:app --host 127.0.0.1 --port 8787   # front with nginx + mTLS
```

Wire `score_with_agent()` in `eod_review.py` to your existing compliance agent,
then enable the timer:

```
systemctl enable --now dlp-eod.timer
```

`OnCalendar` uses the server's timezone. Confirm with `timedatectl` that the box
is on `America/Chicago`, or the pass runs at the wrong hour.

## Repo layout

```
extension/            source (NOT a load-unpacked target -- no manifest here)
  sites.js            AI application catalog, ~99 entries. Source of truth.
  policy.js           mode resolution: site/category/department precedence
  discovery.js        heuristic detector for AI sites not in the catalog
  browser-compat.js   chrome/browser namespace + Firefox API gaps
  rules.js            local detection ruleset (unchanged from v1)
  conversation.js     cross-message context: split identifiers, cumulative ID
  content.js          interception layer
  background.js       forwarder + policy distribution + dynamic registration
  options.js/.html    read-only status page
  server-config.js    <- the only file you edit to point at your server
  policy_schema.json  managed-policy schema
tools/
  build.mjs           generates per-browser manifests from the catalog
  test.mjs            67 tests: matcher, policy resolver, conversation context
  patch_lan.py        point a dev build at a LAN backend
enterprise/           fleet deployment
  README.md           the deployment guide -- start here for rollout
  windows/            Chrome+Edge PowerShell, Firefox policies.json
  macos/              MDM payloads, Safari assessment
  linux/              one script for all four browsers
  samples/            baseline and per-department policy
dist/                 generated, gitignored
server/               everything that runs on Ubuntu
  receiver.py         HTTP intake for both tiers
  eod_review.py       17:45 pass -- pulls pending, scores, deletes bodies
  agent_client.py     Ollama client; retrieve_policy() is your ChromaDB hook
  morning_report.py   07:00 HTML brief
  setup.sh            one-shot provisioning
  dlp-receiver.service
  dlp-eod.service  dlp-eod.timer        17:45 scoring
  dlp-report.service  dlp-report.timer  07:00 report
  nginx-dlp.conf      TLS terminator
  requirements.txt
```

## Standing up the backend

`receiver.py` is the backend. It owns both endpoints and the SQLite database at
`/var/lib/dlp/dlp.db`. `eod_review.py` is a scheduled job against that same
database, not a second service.

**Test the whole loop on your laptop first — no Ubuntu box needed:**

```bash
cd server
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
DLP_DB=./dev.db DLP_TOKEN=dev-token-change-me \
  ./venv/bin/uvicorn receiver:app --port 8787
```

`server-config.js` already points at `http://127.0.0.1:8787` with that token, so
reload the extension, trigger a block, and watch the request land. Confirm with:

```bash
curl -s http://127.0.0.1:8787/health
sqlite3 dev.db "SELECT severity, site, prompt_hash FROM events;"
```

**Then on the real box:**

```bash
scp -r server/ ubuntu@yourhost:~/dlp-server
ssh ubuntu@yourhost 'cd dlp-server && sudo ./setup.sh'
```

`setup.sh` installs the venv, creates the `dlp` service account, generates a
shared token, and enables both systemd units. It prints the token — paste it and
your real hostname into `server-config.js`, then add the origin to
`DEFAULT_BACKEND_ORIGINS` in `tools/build.mjs` and rebuild. (For a LAN box,
`python3 tools/patch_lan.py <ip>` does both.)

**The failure you will hit:** if the endpoint host is missing from
`host_permissions`, the service worker's fetch is blocked and events queue up
locally with no error anywhere the user can see. It looks exactly like a server
outage. Open the extension's **options page** — it shows queue depth, last
successful batch, and whether managed policy was detected. That page exists
because every failure this extension has is silent by nature.

### Auth, honestly

The bearer token stops a random LAN host injecting fake events. It is not
authentication — every workstation carries the same secret, and anyone who can
read the extension folder can read it. Before pilot, move to client certificates
issued per device, and bind uvicorn to localhost with nginx doing mTLS. Put this
on your known-gaps slide rather than waiting for security to find it.

## The daily cycle

```
all day    extension blocks locally, ships metadata every 30s
17:30      workstations push staged prompts (or on lock / next startup)
17:45      dlp-eod.timer  -> eod_review.py -> agent_client.py -> Ollama
                            verdict stored, prompt body DELETED
07:00      dlp-report.timer -> morning_report.py -> HTML brief emailed
```

Tuesday's 07:00 report covers Monday. `dlp-report.timer` runs Tue–Sat so
Friday's activity lands Saturday morning; change `OnCalendar` if you'd rather
Friday roll into Monday.

### The agent

`agent_client.py` calls Ollama on localhost. `DLP_MODEL` in `/etc/dlp/dlp.env`
picks the model. `retrieve_policy()` is an empty hook — point it at your existing
ChromaDB policy index and the verdict comes back grounded in an actual county
policy rather than a bare model opinion.

**Inference must stay on this box.** The text being scored is precisely the
county data the project exists to keep out of third-party LLMs. Sending it to a
hosted model to check whether it was sent to a hosted model defeats the whole
control and is the first thing an auditor will find. If anyone later proposes
swapping Ollama for an API to gain accuracy, that is the objection.

An item the agent fails to score stays `pending` **with its body intact** and
retries the next night. It is never recorded as clean. The morning report shows
the pending count in the footer, because a report that silently omits failures
trains people to trust a number that isn't true.

### Test the report without waiting a day

```bash
DLP_DB=./dev.db DLP_REPORTS=./out python3 morning_report.py 2026-07-21
```

Writes `out/dlp-report-2026-07-21.html`. Open it in a browser. Set `DLP_SMTP`
and `DLP_MAIL_TO` in `/etc/dlp/dlp.env` to enable delivery.

### Two artifacts, on purpose

`morning_report.py` writes two files:

| File | Contains | Perms | Emailed |
|---|---|---|---|
| `dlp-report-DAY.html` | Counts, rationales, categories | 0644 | Yes |
| `dlp-review-DAY.html` | **Full submitted text** | 0600 | No |

A reviewer cannot adjudicate "requires review" without seeing what was actually
submitted, so the text has to exist somewhere. It does not have to exist in
email. An emailed report gets forwarded, syncs to phones, sits in Exchange
indefinitely, and becomes discoverable — putting unredacted resident data in it
recreates the exact leak this project prevents, in a channel with worse controls.

So the summary goes out; the review file stays on the box at 0600, owned by
`dlp`, and the email points at its path.

### Body retention

Only items scored `high` keep their text. Everything the agent clears is
`body=NULL` immediately. Retained bodies purge after `DLP_BODY_RETENTION_DAYS`
(default 30) whether or not anyone reviewed them — an unreviewed backlog is not
a reason to hold county records on this box forever. Status moves to `expired`
and the review file says so rather than showing a blank.

## Coverage model

Three layers, because no single one is sufficient.

**1. The catalog** (`extension/sites.js`) — ~99 AI applications in ten
categories: public chat, enterprise/tenant-bound assistants, answer engines,
coding assistants, document analysis, writing and translation, media
generation, meeting capture, model playgrounds, and browser agents.

v1 covered twelve, and only the obvious ones. The categories that were missing
matter more than the count:

- **Translation.** Pasting a resident's letter into a free translator ships it
  to a third party exactly like pasting it into a chatbot does. Most AI
  acceptable-use policies do not mention it.
- **AI app builders** (v0, Bolt, Lovable, Replit). People paste config files
  and connection strings into these.
- **Document analysis** (ChatPDF, Humata). These exist to have a file uploaded
  to them, and for a county that file is a case record about as often as it is
  a manual.
- **Model playgrounds** (OpenAI Platform, AI Studio, Bedrock). Low headcount,
  high blast radius — whoever is in there is pasting production data to test a
  prompt.
- **Meeting notetakers.** Interception does little here, but reporting their
  presence means somebody notices a bot sitting in closed-session meetings.

**2. Discovery** (`extension/discovery.js`) — a catalog is permanently one step
behind, and the gap is widest the week a new tool trends. In `discover`
coverage the extension scores every page against chat-UI signals and treats
anything over threshold as an AI surface. Default is monitor-and-report, never
block: a heuristic that blocks is a heuristic that will one day take out the
county intranet search box fleet-wide.

**3. Policy** (`extension/policy.js`) — sites can be added, disabled, or
re-scoped without a rebuild, so covering a newly discovered tool is a policy
push the same afternoon rather than a build-sign-deploy cycle.

## Conversation context

`rules.js` reads one string: whatever is in the composer now. That is
structurally blind to the obvious evasion — type `her SSN is 123-45`, send,
then type `6789`. Neither message matches anything. The disclosure happened.

`agent_client.py` already describes this analysis in `HISTORY_SYSTEM`
("details spread across prompts that individually look harmless"), but it runs
at 17:45 and the two-tier table says tier 2 **can't block**. `conversation.js`
brings a bounded version forward to the submit gate, where it still can.

Four findings, each only firing when single-message scanning cannot see it:

| Finding | Fires when |
|---|---|
| `split_identifier` | a tuned regex matches across a message boundary |
| `cumulative_identity` | 3+ distinct identity *classes* spread over 2+ messages (4+ blocks) |
| `evasion_retry` | a split identifier for a rule already blocked this session |
| `sensitive_thread` | anaphora pointing back at a sensitive subject (warn only) |

**It never re-reports history.** If message 1 held an SSN, message 5 isn't
blocked for it — message 1 was already blocked on its own. A context layer that
re-flagged the window would refuse every message after the first flagged one,
and users would rightly call it broken.

**Off by default** (`contextMode: "off"`). It runs on the submit path and is
newer than the tuned regexes. Turn it on in `monitor`, read a week, then decide.

Cost discipline, because this is the interaction people perform hundreds of
times a day:

- Skipped entirely when the per-message verdict already blocks — the verdict
  can't get worse, so scanning further is pure latency
- Extraction is driven by a dirty flag from a `MutationObserver` whose callback
  does nothing but set a boolean
- Bounded at 5 turns × 4KB, 16KB total
- Self-disables after 3 budget overruns and writes a `gap` event — degrading to
  v1 behavior is acceptable; hanging the composer is not

Measured: **0.18ms** per submit at the documented worst case, against a 16ms
frame budget.

Conversation text never leaves the workstation. Findings carry rule ids,
redacted samples, and message indices — never surrounding text. Staging still
ships only the current prompt.

## Enforcement modes

One behavior for everyone is right for a twelve-site pilot and wrong for a
county. Legal handles privileged material all day; IT pastes stack traces as a
job function; Communications drafts press releases. Configure for the strictest
population and everyone else lives with false positives.

| Mode | block finding | warn finding |
|---|---|---|
| `off` | — | — |
| `monitor` | logged | logged |
| `warn` | confirm | confirm |
| `enforce` | **refused** | confirm |
| `strict` | **refused** | **refused** |

Resolved per site, per category, or per department. `enforce` is the default
and reproduces v1 exactly. See
[enterprise/README.md](enterprise/README.md#4-configure).

Rule exemptions (IT exempting `internal_host`, say) suppress *enforcement*, not
*detection* — the finding is still scanned, still reported, still counted, and
marked `exempt: true`. An exemption that erased its own evidence would be
indistinguishable from a detection failure, and nobody could ever tell that one
was too broad.

## What this does not cover

Be explicit about this with your supervisor. The extension protects against
**accidental disclosure by cooperating employees**. It does not stop:

- Desktop apps (ChatGPT for Windows, Claude Desktop, Copilot in Office clients)
- Personal phones and home computers
- Browsers you did not deploy to — the catalog is browser-agnostic, the
  *deployment* is not. Someone who installs Vivaldi is uncovered until the
  force-install policy is extended to it.
- Anyone who disables the extension, unless it is force-installed via policy

Force-install closes the last one on all of Chrome, Edge, and Firefox — see
[enterprise/README.md](enterprise/README.md#3-deploy). Discovery narrows the
"site we never heard of" gap. Nothing here touches the first two; those need
network-layer controls or acceptable-use policy.

## Open items that are not code

- Written employee notice and acceptable-use policy, not just verbal supervisor
  approval.
- Records retention schedule for the event log.
- Texas Public Information Act analysis: captured prompt metadata created on
  county systems may be subject to disclosure. Ask county counsel before you
  collect the first event, not after.


## extension (prompt data) -> ubuntu linux server -> compliance agent (linux server) -> EOD analysis (linux server) -> EOD morning report (linux server)
