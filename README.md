# County LLM Data Guard

---

# Start here: 

*This section assumes you know nothing about data security software. No
background needed. If you're a developer, skip to [For developers](#for-developers).*

## The problem

County employees use AI chat websites — ChatGPT, Copilot, Gemini and others —
to help with everyday work. Drafting a letter, summarizing a document,
rewriting something in plainer words. This is genuinely useful, and people do
it because it saves time.

The catch is where that text goes. When you type into one of these websites,
your words are sent over the internet to a company's computers. They are not
staying on your desk.

So imagine a clerk is answering a resident's question and types:

> *"Help me write a letter to Maria Gonzalez, Social Security number
> 123-45-6789, about her benefits application."*

That resident's Social Security number has now left the county and is sitting
on a private company's computers. The clerk wasn't careless — they were trying
to do their job well. But the county now has a data breach it has to report,
and Maria's number is somewhere nobody can retrieve it from.

**This happens by accident, by helpful people, and nobody finds out.** That
last part is the real problem. There's no alarm, no record, no way to know it
happened at all.

## What this software does

It's a small add-on for the web browser — the program you use to visit
websites. Once installed, it watches for one specific thing: sensitive
information about to be sent to an AI website.

When it sees some, it stops the message before it's sent and shows a note
explaining why.

Three things worth understanding:

**It checks the text on your own computer.** Nothing is sent anywhere to
decide whether to block. Your words are examined right there on the machine,
the way a spell-checker works. The alternative — sending everything to a
central server to be inspected — would mean building one giant collection of
every sensitive thing anyone ever typed. That collection would be a far more
attractive target for a thief than the thing we set out to protect.

**It's quiet almost all the time.** Ordinary questions go through untouched.
You only see it when something is genuinely about to leak.

**It can't be switched off by the person using it.** Not because anyone is
untrusted, but because a safety measure that turns off when it's inconvenient
isn't a safety measure. Same reason a fire door closes on its own.

## What counts as sensitive

Two different kinds, treated differently on purpose.

### Kind 1: things that are never okay to send

Social Security numbers. Credit card numbers. Bank account and routing
numbers. Driver's license numbers. Passwords and access keys. Spreadsheets
exported from county record systems.

These are **always blocked, for everyone, with no exceptions.**

Not "usually." Not "unless your department has a reason." Always.

Here's the thinking. Suppose the Legal department is careful and the
Communications department is a bit more relaxed. If a resident's Social
Security number leaks, does it matter which department sent it? No. That
resident is harmed exactly the same. The county's legal duty to notify them is
exactly the same. The number is exactly as exposed.

So there's no version of this where one team gets to be looser about it.

There's also a practical reason this can be absolute: **there is no job at the
county that requires typing a live Social Security number into a public AI
website.** None. Because the honest answer is never "yes, I needed to do
that," blocking it costs nobody anything.

### Kind 2: things that depend on context

Now consider the word *"patient."*

In the Health department, "patient" next to a description of someone's
condition is a real problem. In the Facilities department, "the patient
elevator repair schedule" is a completely ordinary sentence.

Same word. One is a leak; the other is a Tuesday.

Other examples: a date of birth, a case number, an internal server address, a
county email address. Each of these is sensitive in some jobs and routine in
others.

If we blocked all of them everywhere, people in the departments where they're
routine would get stopped constantly for no reason. And here's what actually
happens then — this is the single most common way software like this fails:

> People stop trusting it. They find ways around it. They use their personal
> phone instead. Now the leak still happens, but it's completely invisible.

A tool that annoys people into avoiding it protects less than a tool that
never existed, because it also creates false confidence.

So for this second kind, each department sets its own level. Health treats
medical words strictly. Facilities doesn't need to.

**To put the whole idea in one line:**

> **What counts as a leak is the same for everyone. How much everyday
> background noise a department puts up with is up to that department.**

## Who this actually protects

Not the county's reputation, in the first instance. The resident.

Maria Gonzalez never chose to have her Social Security number typed into a
chat website. She gave it to the county because she had to, to get a service
she was entitled to. She has no way of knowing where it went and no way of
getting it back.

Everything else here — the reports, the audit records, the retention
schedule — exists because of that.

## What happens when something is blocked

1. **You see a message.** It says what was found — "Social Security number" —
   and that the text was not sent. Your words are still in the box; nothing is
   lost. You can edit and try again.

2. **A note is recorded.** Not your text — just that something was blocked, on
   which website, at what time. It's the difference between a security camera
   logging "a door opened at 3pm" and filming the inside of the room.

3. **Nothing is forwarded anywhere.** The blocked text stays on your computer.

For the borderline cases — the context-dependent kind — you get a "are you
sure?" step instead of a hard stop. You can continue if you know it's fine.
That choice is recorded too, so if there's ever a question later, there's an
honest record of what happened and who decided.

## What it cannot do

Being straight about this matters more than a longer feature list. Anyone
evaluating this deserves to know where the edges are.

- **It only works in the web browser.** If someone installs a desktop AI
  program, this can't see it.
- **It can't touch personal phones or home computers.** That needs a written
  policy, not software.
- **It can't read pictures.** Photograph a document and upload the photo, and
  the text inside is invisible to this.
- **It only knows the AI websites it's been told about** — about 99 of them
  today. New ones appear constantly. It tries to recognize unfamiliar ones by
  how they behave, but it reports those rather than blocking them, because
  guessing wrong and blocking a legitimate county website would be worse.

This handles honest mistakes by people trying to do their jobs. It is not
designed to stop someone deliberately trying to steal data — that's a
different problem needing different tools.

## The one thing to take away

**Nobody has to remember anything.** No training to sit through, no rules to
memorize, no judgment call in the moment about whether this particular thing
is okay to paste.

If it's genuinely sensitive, it just doesn't go. Even if you're in a hurry.
Even if it's 4:55 on a Friday. Even if you didn't realize the number was in
there.

That's the whole idea.

---

# For developers

**New to the codebase? Read [ARCHITECTURE.md](ARCHITECTURE.md) first** — it
walks through what every file does and how they connect, in plain language.

Browser extension that inspects text before it is submitted to AI services and
blocks submissions containing protected county data.

Covers **99 AI applications** across **Chrome, Edge, Firefox, Chromium, and
Safari**, force-installable by enterprise policy, with per-department
enforcement modes and heuristic detection of AI sites that are not in the
catalog.

Test suites: **86 unit · 56 end-to-end · 45 fleet · 36 archive.**

For fleet deployment — group policy, Intune, mobile device management,
Ansible — see **[enterprise/README.md](enterprise/README.md)**. Everything
below describes how the thing works.

## Load it (development)

`chrome://extensions` → Developer mode → **Load unpacked** → select **`extension/`**.

That works straight from a clone — no build step. `extension/manifest.json` is
committed and covers all 99 sites on Chrome/Edge.

1. Open chatgpt.com, type `SSN: 123-45-6789`, press Enter. It should be blocked.
2. Type an ordinary question. It should go through with a short delay.
3. Open the extension's options page to see mode, coverage, and queue depth.

```bash
npm test           # 67 tests: matcher, policy resolver, conversation context
npm run build      # regenerates extension/manifest.json + all dist/ targets
```

### extension/ vs dist/

| | `extension/` | `dist/<target>-<coverage>/` |
|---|---|---|
| Purpose | development and demos | shipping |
| Manifest | committed, chrome + catalog | generated per browser |
| Firefox event page, Safari perms, broad coverage | no | yes |
| Needs a build | no | yes |

`extension/manifest.json` is **generated** — it is rewritten on every
`npm run build` from `extension/sites.js`, so it cannot drift from the catalog.
Change site coverage in `sites.js`, not in the manifest; hand edits are
overwritten.

Firefox needs a build (`npm run build`, then load
`dist/firefox-catalog/manifest.json` via `about:debugging`), because Firefox
MV3 uses an event page rather than a service worker.

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
  manifest.json       GENERATED load-unpacked target (chrome + catalog)
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

## Prompt archive (optional, 60-day retention)

**Off by default.** Enable only with a records-retention obligation and county
counsel sign-off, because this is the thing the section above warns about:

> your event database becomes a searchable archive of every SSN and case file
> an employee ever pasted — a higher-value target than the thing you were
> protecting

That objection is still correct. `server/archive.py` exists because a retention
schedule can override it, not because it stopped being true. If metadata alone
ever satisfies the requirement, delete the file.

```bash
head -c 32 /dev/urandom | base64 > /etc/dlp/archive.key
chmod 400 /etc/dlp/archive.key && chown dlp:dlp /etc/dlp/archive.key
# then set DLP_ARCHIVE=1 in /etc/dlp/dlp.env
```

What makes it survivable:

| Control | Why |
|---|---|
| **AES-256-GCM at rest**, key outside the DB | a stolen `dlp.db` is hashes and timestamps, not resident PII. Without this the backup tape *is* the breach |
| **No bulk read path** | per-employee only, reason required, capped. An archive you can grep is one that will be grepped |
| **Every read logged**, log outlives the data | answers "has anyone been reading my prompts" — the question that decides whether this is trusted |
| **Hard purge at 60 days** | `WAL checkpoint` + `VACUUM`, so purged ciphertext is gone from disk rather than sitting in freed pages |
| **Legal hold**, named and visible | suspends purge for one employee; shows in retention stats until lifted, so an indefinite hold cannot hide |

`include_text` defaults to **false** — most retention questions (how often,
which tools, what fired) are answerable from metadata, and answering them
without decrypting is the difference between a records system and a reading room.

Purge runs nightly at 03:15 via `dlp-purge.timer`, enabled unconditionally: if
the archive is ever switched on, retention is already being enforced.

```bash
python3 server/archive.py stats            # posture + size projection
python3 server/archive.py purge --dry-run  # what would go
```

**Two open gaps, both real:**

- **Auth.** The shared bearer token proves the caller is on the LAN, nothing
  more. Tolerable for ingest; **not** tolerable for an endpoint returning
  readable prompt history. Put these behind mTLS or SSO before enabling.
  `X-DLP-Actor` is a self-asserted audit label, not an identity.
- **Scale.** SQLite holds to roughly a few hundred workstations at this
  retention. `retention_stats()` projects size and warns before the box becomes
  the problem; the store/history/purge interface is narrow so Postgres can
  replace it without touching callers.

Note `review_items` still holds brief plaintext while the nightly agent scores
it — that is pre-existing and unchanged, and those bodies are nulled minutes
later.

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

## What every department is held to

Hard identifiers **block everywhere, for everyone, in every mode**:

`ssn` · `ssn_bare` · `ssn_labeled` · `credit_card` · `bank_account` · `tx_dl` ·
`record_header` · `bulk_paste` · `credential` · `private_key`

No departmental overlay can soften them, `exemptRules` cannot reach them, and
`monitor` does not exempt them. Verified across all 9 sample departments and
every catalog site.

This is not a tuning decision. A resident whose SSN reaches a public LLM is
harmed identically whether Legal or Communications sent it, and the county's
notification obligation is the same either way. There is also no job function
that requires pasting a live SSN into ChatGPT — so a hard floor costs nothing
in false positives, which is exactly why it can be absolute.

Overriding it means emptying `alwaysEnforceRules` in managed policy: a visible,
auditable act by whoever owns the GPO, not a side effect of a mode chosen for
an unrelated reason.

**Departments still tune contextual rules** — `dob`, `medical`, `cjis`,
`internal_host`, `gov_email`, `case_number`. Those are genuinely ambiguous
("patient" is a disclosure in Health and a noun in Facilities), and forcing
them fleet-wide produces the false positives that get a tool uninstalled.

So: **what counts as a leak is fixed. How much ambient noise a department
tolerates is tunable.**

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
