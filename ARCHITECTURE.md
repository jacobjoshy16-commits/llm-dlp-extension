# What every file does, and how they fit together

A guided tour of the codebase. Written to be read top to bottom the first
time, then used as a reference.

Everything here was verified against the code, not written from memory. Where
a claim is checkable (load order, who calls what, which module owns which
database table), it was checked.

---

## The shape of it in one picture

```
   THE EMPLOYEE'S COMPUTER                    THE COUNTY'S SERVER
   ───────────────────────                    ───────────────────

   browser add-on                             receiver.py
   ├── reads what's typed                     ├── accepts reports
   ├── decides: allow / warn / block   ──────▶├── stores them
   └── decides LOCALLY, always                └── serves policy back

                                              then, on a schedule:
                                              ├── eod_review.py    17:45
                                              ├── morning_report.py 07:00
                                              └── archive.py purge  03:15
```

Two rules explain most of the design:

1. **The block/allow decision happens on the employee's computer.** Nothing is
   sent anywhere to make it. The server is told *that* something happened, not
   asked *whether* it should.
2. **The server is a record-keeper, not a gatekeeper.** If it is down, the
   add-on keeps working and keeps blocking. Reports queue up and go later.

---

# Part 1 — The browser add-on

Lives in `extension/`. Seven files load into every AI website the employee
visits, **in this exact order**:

```
1. browser-compat.js    2. sites.js      3. policy.js     4. discovery.js
5. rules.js             6. conversation.js               7. content.js
```

Order is not cosmetic. Each file publishes a shared object that later files
read. Load `conversation.js` before `rules.js` and it finds nothing to work
with — and fails *silently*, which is worse than crashing.

| File | Publishes | Reads |
|---|---|---|
| `browser-compat.js` | `DLP_BROWSER` | — |
| `sites.js` | `DLP_SITES` | — |
| `policy.js` | `DLP_POLICY` | `DLP_SITES` |
| `discovery.js` | `DLP_DISCOVERY` | — |
| `rules.js` | `DLP_RULES` | — |
| `conversation.js` | `DLP_CONTEXT` | `DLP_RULES` |
| `content.js` | — | all of the above |

Every consumer loads after its provider. That table is the dependency graph.

---

### `browser-compat.js` — smooths over browser differences

Chrome, Edge, and Firefox disagree on small things that break code loudly or,
worse, quietly. Firefox has no `chrome.identity`, so asking "who is signed in"
throws. Chrome and Firefox return results differently.

This file wraps those differences once so no other file has to care.

> **Why it matters:** version one called Chrome's interfaces directly. On
> Firefox that threw an error on every single report, and the error was caught
> and ignored — so Firefox machines silently reported nothing at all. Nobody
> would have noticed until an audit asked why.

---

### `sites.js` — the list of AI websites

99 sites in 10 groups: general chat, work assistants, search, coding help,
document readers, writing tools, image generators, meeting recorders,
developer consoles, browser agents.

**This file is data, not logic.** Adding a site is one line. It is also the
single source of truth: the browser's configuration file is *generated* from
it, so the two cannot drift apart.

> **Why a list at all?** Because running on every website would be a much
> bigger ask of the employee's privacy, and would slow every page down. A list
> is narrower and defensible — you can hand it to a reviewer.

Each entry can carry a `sanctioned: true` flag for tools the county has
approved, and optional hints about where that site's "send" button lives.

---

### `policy.js` — decides how strict to be

Takes a finding and answers: allow it, ask the user, or block it.

Five levels, from `off` through `monitor`, `warn`, `enforce`, to `strict`.
Which one applies depends on the department, the website, and the category —
resolved in that order of priority.

**The most important thing in this file is a list called `ALWAYS_ENFORCE`.**

Social Security numbers, payment cards, bank accounts, driver's licenses,
passwords, access keys, bulk record exports. These block **for every
department, on every site, at every level.** No setting reaches them, and no
exemption can switch them off.

> **Why it's absolute:** a resident whose Social Security number leaks is
> harmed identically whichever department sent it. And no job at the county
> requires typing one into a public AI website — so a hard floor costs nobody
> anything.
>
> This was not always true. A 100-machine test showed the *same* Social
> Security number resolving to blocked in one department, a dismissible
> warning in another, and allowed in a third. Three separate settings were
> each quietly softening it.

Everything else — dates of birth, medical words, case numbers, internal server
addresses — stays adjustable per department, because *"patient"* is a
disclosure in Health and an ordinary word in Facilities.

---

### `rules.js` — recognizes sensitive text

16 patterns. 9 block, 7 warn.

More careful than a plain search. A 16-digit number is only treated as a
payment card if it passes the checksum real card numbers have. A 9-digit
number is only a Social Security number if the surrounding words suggest it.
This is what stops the tool crying wolf on ordinary case numbers.

It also measures *shape*: a large pasted spreadsheet is treated as a bulk
disclosure even when no single cell matches anything, because a table of names
and addresses contains no recognizable pattern anywhere.

**This file is unchanged from version one.** Everything built since surrounds
it rather than replacing it.

---

### `conversation.js` — catches what's split across messages

Pattern matching reads one message at a time. That misses the obvious dodge:

```
Message 1:  "her ssn is 123-45"      → nothing matches
Message 2:  "6789"                    → nothing matches
Together:   a Social Security number
```

This file keeps the last few messages and checks whether they combine into
something sensitive. It also notices when identifying details accumulate — a
name here, a birth date there, a case number in the next message.

Deliberately **off by default**, because it costs more than plain matching.
Measured at 0.18 milliseconds per message, against a 16-millisecond budget.

> **A design constraint worth understanding:** it never re-reports history. If
> message 1 held a Social Security number, message 5 is not blocked for it —
> message 1 was already blocked on its own. Otherwise every message after a
> flagged one would be refused and people would rightly call it broken.

---

### `discovery.js` — spots AI sites nobody listed

A list of 99 is always behind. New AI tools appear weekly.

This watches for pages that *behave* like a chat site — a big text box, a send
button beside it, alternating messages — and reports them.

**It reports; it does not block.** A guess that blocks would eventually take
out the county's own intranet search box across every machine at once. Someone
reviews what turns up and adds it to the list deliberately.

---

### `content.js` — the part that actually intercepts

The largest file, and where all the others meet.

It watches for the Enter key, clicks on send buttons, pastes, and file
attachments. When something is about to be sent, it asks `rules.js` what's in
the text, asks `policy.js` what to do about it, optionally asks
`conversation.js` about recent messages, and then either steps aside or shows
the warning box.

Two details that carry real weight:

**It scans while you type, not when you press Enter.** The obvious approach —
intercept Enter, check, then re-send if clean — creates an infinite loop: the
re-sent keystroke hits the same handler, which blocks it and re-sends again.
An early version did exactly that and pinned a processor core. Scanning
continuously means the answer is already known when Enter arrives.

**It can read attached spreadsheets and documents.** A `.xlsx` file is a
compressed archive, not text, so nothing in the text path can see inside it.
This file unpacks it in the browser and reads the cells.

---

### `background.js` — the bookkeeper

Runs quietly behind all tabs. Never sees the block/allow decision — it only
handles what comes after.

- Collects reports from every tab
- Sends summary information every 30 seconds
- Sends the day's stored text at 5:30pm, or when the machine is locked
- Fetches policy updates hourly
- Deletes anything stuck for more than 72 hours, and records the gap

> **One safety rule lives here:** policy pushed from the server can make things
> *stricter*, never looser. A compromised server can annoy people. It cannot
> quietly switch the protection off.

---

### `options.js` / `options.html` — the status page

Read-only, on purpose. No off switch — one would make the whole thing
optional.

It exists because every failure this add-on can have is silent: a missing
permission, a queue that never empties, policy that never arrived. Without
this page, "the AI blocker isn't working" is unanswerable.

---

### `server-config.example.js` and `policy_schema.json`

The first is where the server address and shared password go. The second
describes every setting the technology team can control centrally, so those
settings can be pushed to every machine without shipping new software.

---

# Part 2 — The server

Lives in `server/`. Four programs sharing one database file.

### `receiver.py` — the only thing always running

Listens for reports. Nine addresses, but the important two:

| Address | Carries |
|---|---|
| `/api/events` | summaries — site, time, what matched, no actual text |
| `/api/review-batch` | the day's stored text, for overnight review |

Plus `/api/policy` (settings out to machines), `/api/coverage` (which AI tools
the county is actually using), and four for the optional long-term store.

It owns four database tables: `events`, `review_items`, `user_reviews`,
`site_coverage`.

### `eod_review.py` — the 5:45pm pass

Takes everything the pattern rules could not clear and asks a local AI to read
it properly. Patterns catch formatted numbers; this catches an employee
*describing* a resident's situation in ordinary prose, where there's no pattern
to find.

**Then it deletes the text.** Only items judged high-risk keep their words, and
those are removed after 30 days whether or not anyone looked.

> The AI runs **on this same machine**. Sending the text to an outside AI
> service to check whether it was sent to an outside AI service would defeat
> the entire point — and is the first thing an auditor would find.

Imports `agent_client.py`. That is the only import between server programs.

### `agent_client.py` — talks to the local AI

Sends text to the AI running on the same machine, gets back a judgment.
Verifies that any quote the AI claims to have found is actually present in the
text — models sometimes invent supporting evidence.

### `morning_report.py` — the 7am email

Writes **two** files, and the split is deliberate:

| File | Contains | Emailed |
|---|---|---|
| `dlp-report-DAY.html` | counts, reasons, categories | **yes** |
| `dlp-review-DAY.html` | the actual text | **no** — stays locked on the server |

A reviewer cannot judge "needs review" without seeing what was submitted, so
the text must exist somewhere. It does not have to exist in *email*, which gets
forwarded, syncs to phones, and sits in inboxes forever.

### `archive.py` — the optional long-term store

**Off unless deliberately switched on.** Keeps every prompt for 60 days for
records-retention obligations, then deletes permanently.

Because this is exactly the "one big pile of everything sensitive" the design
otherwise avoids, it is heavily fenced: encrypted with the key stored outside
the database, no way to read everyone's history at once, every read logged
with a name and a reason, and a hard delete at 60 days.

Owns `prompt_archive`, `archive_access`, `legal_hold`.

### Supporting files

`setup.sh` sets up a fresh server. The `.service` and `.timer` files tell the
operating system what to run and when. `nginx-dlp.conf` handles encrypted
connections. `dlp_policy_bridge.py` optionally connects the overnight AI to the
county's existing policy documents.

---

# Part 3 — Build and test

| File | Purpose |
|---|---|
| `tools/build.mjs` | generates browser configuration files from `sites.js` |
| `tools/test.mjs` | 86 checks of the site matcher, policy resolver, conversation logic |
| `tools/e2e/run.mjs` | 56 checks — 3 machines, real server, full day |
| `tools/e2e/fleet.mjs` | 45 checks — 40 machines, 9 departments, 60 days |
| `tools/e2e/archive_test.py` | 36 checks of encryption and deletion |
| `tools/e2e/demo.mjs` | prints the decision path for a walkthrough |

> **Why generate the configuration file?** Version one listed 12 websites by
> hand, in two places. Adding one meant editing both — and forgetting one meant
> the add-on silently never ran on that site, with no error anywhere. At 99
> sites and 4 browsers that is a certainty rather than a risk.

The tests exist in layers because each catches something the others cannot.
`test.mjs` checks logic in isolation. `run.mjs` checks that the pieces talk to
each other over a real network. `fleet.mjs` checks behavior at scale — and it
is the one that found the inconsistent-enforcement problem, which was invisible
with three machines.

---

# Part 4 — Deployment

`enterprise/` holds installation instructions for the machines, not code that
runs.

| Path | For |
|---|---|
| `windows/deploy-chrome-edge.ps1` | installs it so employees cannot remove it |
| `windows/firefox-policies.json` | same, Firefox — a different mechanism entirely |
| `linux/install-policies.sh` | all four browsers on Linux in one pass |
| `macos/*.md` | Mac instructions, plus an honest note that Safari needs a paid Apple developer account |
| `samples/policy-baseline.json` | starting settings for the whole county |
| `samples/policy-departments.json` | per-department differences, with reasoning |

**None of this ships inside the add-on.** You can ignore the entire folder and
the add-on still works with sensible defaults — you just have to install it by
hand on each machine.

---

# How a single message flows through everything

Someone types a resident's Social Security number into ChatGPT and presses
Enter.

1. `content.js` has already been scanning as they typed
2. `rules.js` recognized the number — flagged as *block* severity
3. `policy.js` checks the department's settings, finds the rule on the
   never-soften list, answers **block**
4. `content.js` stops the keystroke and shows the warning box
5. `background.js` records what happened — the type of match, not the text
6. 30 seconds later that summary reaches `receiver.py`
7. At 5:30pm the stored text is sent; at 5:45pm `eod_review.py` reads it,
   records a judgment, deletes the text
8. At 7am `morning_report.py` emails a summary with no sensitive content in it

**The resident's number never left the building.** Steps 5 through 8 are
record-keeping. Step 4 is the actual protection, and it happened entirely on
that one computer in a fraction of a second.
