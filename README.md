# County LLM DLP (v1)

The problem
County employees use AI chat websites — ChatGPT, Copilot, Gemini and others — to help with everyday work. Drafting a letter, summarizing a document, rewriting something in plainer words. This is genuinely useful, and people do it because it saves time.

The catch is where that text goes. When you type into one of these websites, your words are sent over the internet to a company's computers. They are not staying on your desk.

So imagine a clerk is answering a resident's question and types:

"Help me write a letter to Maria Gonzalez, Social Security number 123-45-6789, about her benefits application."

That resident's Social Security number has now left the county and is sitting on a private company's computers. The clerk wasn't careless — they were trying to do their job well. But the county now has a data breach it has to report, and Maria's number is somewhere nobody can retrieve it from.

This happens by accident, by helpful people, and nobody finds out. That last part is the real problem. There's no alarm, no record, no way to know it happened at all.

Chrome/Edge MV3 extension that inspects text before it is submitted to public AI
chat services and blocks submissions containing protected county data.

## Load it

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder.
2. Open chatgpt.com, type `SSN: 123-45-6789`, press Enter. It should be blocked.
3. Type an ordinary question. It should go through with a short delay.

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

All three run at `document_start` in the capture phase so they fire before the
page's own handlers. Running after means the request is already in flight.

## Before you deploy

- **Tune the rules.** Run `DLP_RULES.scan()` over a corpus of real county
  documents and a corpus of ordinary work questions. Measure false positives.
  A tool that blocks legitimate work gets uninstalled or worked around within a
  week — that is how DLP pilots die.
- **Selector rot.** `data-testid*="send"` will break when OpenAI or Anthropic
  ships a UI change. Budget for monthly checks, and add a synthetic test that
  loads each site and confirms a known-bad string is still blocked.
- **Give people an approved alternative.** Blocking without offering the county's
  internal AI tool converts employees into adversaries who will use their phones.

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
extension/            load-unpacked target
  manifest.json
  server-config.js    <- the only file you edit to point at your server
  rules.js  content.js  background.js  policy_schema.json
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
your real hostname into `server-config.js`, and add that hostname to
`host_permissions` in `manifest.json`.

**The failure you will hit:** if the endpoint host is missing from
`host_permissions`, the service worker's fetch is blocked and events queue up
locally with no error anywhere the user can see. It looks exactly like a server
outage. Check `chrome.storage.local.get('queue', console.log)` in the service
worker console first.

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

## What this does not cover

Be explicit about this with your supervisor. The extension protects against
**accidental disclosure by cooperating employees**. It does not stop:

- Desktop apps (ChatGPT for Windows, Claude Desktop)
- Personal phones and home computers
- Other browsers or browser profiles without the extension
- Anyone who disables the extension, unless it is force-installed via policy

Force-install via Chrome/Edge group policy (`ExtensionInstallForcelist`) closes
the last one. The rest need network-layer controls or acceptable-use policy.

## Open items that are not code

- Written employee notice and acceptable-use policy, not just verbal supervisor
  approval.
- Records retention schedule for the event log.
- Texas Public Information Act analysis: captured prompt metadata created on
  county systems may be subject to disclosure. Ask county counsel before you
  collect the first event, not after.


## extension (prompt data) -> ubuntu linux server -> compliance agent (linux server) -> EOD analysis (linux server) -> EOD morning report (linux server)
