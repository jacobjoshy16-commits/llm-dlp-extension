# Enterprise deployment

v1 was a load-unpacked extension covering twelve sites on three browsers, one
workstation at a time. This directory is what changes to make it a fleet
control.

Four things had to change, and none of them are detection logic:

| | v1 | now |
|---|---|---|
| Site list | 12, hard-coded in the manifest, twice | ~99 in a catalog, generated into the manifest, extendable by policy without a rebuild |
| Coverage of new tools | none until someone ships a build | heuristic discovery reports unknown AI surfaces the day they appear |
| Behavior | one mode for everyone | five modes, per site / per category / per department |
| Browsers | Chrome, Edge, Firefox (unpacked) | Chrome, Edge, Firefox, Chromium, Safari (build target), each force-installable |

---

## 1. Build

```bash
npm test                    # 67 tests: matcher, policy resolver, conversation context
npm run build               # all targets, catalog coverage -> dist/
npm run build:broad         # adds https://*/* for discover mode
npm run package             # both, zipped for upload
```

Output is `dist/<target>-<coverage>/`. **Never hand-edit a generated
manifest** — the catalog in `extension/sites.js` is the source of truth, and an
edit there is overwritten on the next build.

### Which coverage profile

| | `catalog` | `broad` |
|---|---|---|
| Host permissions | ~163 specific AI origins | `https://*/*` |
| Discovery works | no | yes |
| Permission warning | "read data on chatgpt.com and 98 other sites" | "read all your data on all websites" |
| Store review | routine | expect questions |
| Deployable unmanaged | yes | practically no |

Ship `catalog` unless you specifically need discovery. Ship `broad` only
force-installed, where the permission prompt is never shown to the user.

The honest tradeoff: `catalog` cannot see the tool that trends next month.
`broad` can, and pays for it with a permission grant broad enough that a
security reviewer is right to ask what the extension does with it. The answer —
that `rules.js` runs entirely locally and prompt bodies only leave the
workstation for flagged items — is the same answer as in v1, but at
`<all_urls>` scope somebody will want it in writing.

---

## 2. Pin the extension ID before writing any policy

On Chrome and Edge the ID is derived from the packing key. An unpacked load
generates a new one **every time**, and managed policy written against the old
ID applies to nothing — with no error, on either side. The extension reads an
empty managed store and falls back to compiled-in defaults, which looks
identical to "the policy didn't apply."

```bash
# generate once, keep in your secret store, never commit
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out dlp-guard.pem

# derive the ID
openssl rsa -in dlp-guard.pem -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | head -c16 | xxd -p | tr '0-9a-f' 'a-p'
```

Add the base64 public key as `"key"` in the manifest (or pack with the `.pem`)
so the ID is stable across builds.

Firefox is easier: the ID is `browser_specific_settings.gecko.id`, which the
build already sets to `dlp-guard@fortbendcountytx.gov` and which never changes.

---

## 3. Deploy

### Windows — Chrome and Edge

```powershell
.\windows\deploy-chrome-edge.ps1 `
  -ExtensionId <32-char-id> `
  -UpdateUrl https://dlp.internal.fortbendcountytx.gov/ext/update.xml `
  -PolicyJson ..\samples\policy-baseline.json
```

Run as SYSTEM from a GPO startup script, Intune platform script, or SCCM. Use
`-WhatIfOnly` first.

The script sets `workstationTag` to `$env:COMPUTERNAME`. Keep that. It is the
only attribution source that works identically on all three browsers, and
`chrome.identity` — the fallback — returns nothing on Firefox and is unreliable
on Edge.

### Windows — Firefox

Copy `windows/firefox-policies.json` to
`%ProgramFiles%\Mozilla Firefox\distribution\policies.json`, or load the
equivalent ADMX.

Read the `_comment` block in that file before you deploy it. Summary of what
differs from Chrome:

- **MV3 host permissions are optional in Firefox.** A normally-installed
  extension has no site access and reports nothing, silently. `force_installed`
  grants them from Firefox 138; `runtime_allowed_hosts` handles it explicitly
  from 153. On an older ESR, test this specifically — the failure is silent.
- **Unsigned XPIs will not install on release Firefox.** Submit to AMO as an
  unlisted add-on (Mozilla signs it, you self-host the file). Budget for this
  in the timeline; there is no supported bypass.
- **No `chrome.identity`.** `workstationTag` is mandatory, not optional.

### macOS

See `macos/com.google.Chrome.mobileconfig.md`. Chrome and Firefox are
straightforward MDM payloads. Safari requires a signed, notarized native app
bundle and a paid Apple Developer ID owned by the county — read the assessment
at the bottom of that file before committing to it.

### Linux

```bash
sudo ./linux/install-policies.sh <EXTENSION_ID> ../samples/policy-baseline.json
```

Covers Chrome, Chromium, Edge, and Firefox in one pass. Idempotent, safe to run
from Ansible or Puppet on every converge.

### Verify — the check that actually matters

`chrome://policy` → **Reload policies**. Look at the **extension** section, not
the browser section. Browser policy applying while the extension section is
empty means the ID in the registry path does not match the installed extension.

Then open the extension's options page. It reports engine, workstation tag,
whether managed policy was detected, active mode, site count, dynamic
registrations, and queue depth. Every silent failure this extension can have is
visible on that one page, which is the reason it exists.

---

## 4. Configure

### Modes

| Mode | block-severity finding | warn-severity finding | Use for |
|---|---|---|---|
| `off` | nothing | nothing | disabling a site without losing it from the catalog |
| `monitor` | logged only | logged only | rollout weeks 1–2; sanctioned tools |
| `warn` | confirm step | confirm step | departments that produce public material |
| `enforce` | refused | confirm step | **v1 behavior — the default** |
| `strict` | refused | refused | legal, HR, sheriff, health |

Precedence, highest first: `siteOverrides[id]` → `categoryModes[category]` →
sanctioned-site default (`monitor`) → `defaultMode`.

`neverScan` beats all of them, including `strict`.

### Start in monitor. Not enforce.

The README's warning about rule tuning — "a tool that blocks legitimate work
gets uninstalled or worked around within a week" — applies with more force once
the extension is force-installed, because now they *can't* uninstall it. They
use their phone instead, and you have traded a logged event for an invisible
one.

Run a department in `groupPolicies.pilot` for two weeks. Read the morning
report. Count how many blocks would have been false positives. That number is
the thing to bring to the meeting where someone asks whether this is ready.

### Departments

`samples/policy-departments.json` is one file for the whole fleet: the deploy
script sets `group` per OU and each workstation picks its overlay. One artifact
in change control instead of eleven that drift apart.

The reasoning for each department is in the `_why` key of its overlay. The two
worth reading before you copy the file:

- **IT** exempts `internal_host` — they paste stack traces and subnet plans as
  a job function. It does *not* exempt `credential` or `private_key`, because
  an API key in a paste is the highest-value thing this tool catches and IT is
  the group most likely to paste one.
- **Communications** exempts `gov_email` and runs in `warn`. Their job is
  producing material intended for release.

An exemption never deletes a finding. It is marked `exempt: true`, still
reported, and still counted — visible in the block dialog as "N exempt by
policy" and in the event log. An exemption that erased its own evidence would
be indistinguishable from a detection failure, and you could never tell that
one was too broad.

### Adding a site without a rebuild

```json
{
  "extraSites": [{
    "id": "internal_bot",
    "name": "County Assistant",
    "category": "enterprise_ai",
    "sanctioned": true,
    "hosts": ["ai.county.local"],
    "selectors": { "composer": "#prompt", "send": "#send-btn" }
  }]
}
```

Push it as policy. The service worker registers a content script for the new
origin at runtime via `chrome.scripting.registerContentScripts`. No build, no
re-sign, no redeploy.

Same mechanism fixes a rotted selector: an `extraSites` entry reusing an
existing catalog `id` replaces it. When OpenAI ships a UI change that breaks
`data-testid*="send"` — and the README is right that they will — the fix is a
policy push the same afternoon, not a build cycle.

**Requires 1:1 host permission.** In `catalog` coverage the extension does not
hold permission for an arbitrary new origin, so registration fails and a `gap`
event is written to the log. Either use the `broad` build or add the origin to
`host_permissions` and rebuild. The `gap` event exists because this failure is
otherwise completely silent.

---

## 5. Discovery

In `coverage: "discover"`, the extension scores every page against chat-UI
signals — a large non-search composer, a send affordance beside it, alternating
message roles, streaming containers, a model picker — and treats anything over
threshold as an AI surface under `unknownSiteMode`.

Default `unknownSiteMode` is `monitor`, deliberately. A heuristic produces false
positives; a false positive in monitor is a line in a report an analyst
dismisses in two seconds, and a false positive in enforce is a county intranet
search box that stops working fleet-wide.

Discovered hosts appear:
- on the options page, under "Unrecognized AI sites seen today"
- in the event log as `severity: "discovery"`, deduplicated to one per host per
  day
- in `GET /api/coverage`, in the `uncatalogued` array

Promote one by adding it to the catalog or to `siteOverrides` — deliberately,
after someone has looked at it.

Cost control, because this runs on every page in the fleet: the scorer reads
attributes rather than document text, samples on a decaying schedule for 20
seconds, and permanently disconnects its observer on verdict or timeout. Top
frame only. If you add a signal, add one that reads attributes.

---

## 6. Server-side policy push

Set `policyEndpoint` and the extension pulls `GET /api/policy` hourly. The
server reads `/etc/dlp/fleet-policy.json` (`DLP_POLICY_FILE`).

This exists because a GPO refresh on a county network takes hours, and the
scenario is "a new tool is trending and three departments are already pasting
into it."

**It cannot loosen enforcement.** `clampToManaged()` in `background.js` drops
any pushed mode weaker than what managed policy set, refuses pushed rule
exemptions unless `allowServerExemptions` is explicitly true, and ignores pushed
`disabledSites` and `neverScan` entirely. A compromised server can make the
fleet stricter and annoy people. It cannot blind the tool — which is the only
reason this channel is safe to have at all.

There is no write endpoint. Policy changes go through whatever review process
edits that file.

---

## 7. What this still does not cover

Unchanged from v1, and worth restating because broader browser coverage makes
it easy to assume otherwise:

- **Desktop apps.** ChatGPT for Windows, Claude Desktop, Copilot in Office
  clients. A browser extension cannot see them. Network-layer controls or
  application allowlisting.
- **Personal phones and home computers.** Policy, not technology.
- **Browsers with no extension support** or profiles outside management.
- **Anyone who uses a browser you did not deploy to.** The catalog is now
  browser-agnostic; the *deployment* is not. A user who installs Vivaldi is
  uncovered until you extend the force-install policy to it.

Discovery narrows the "site we never heard of" gap. It does not touch any of
the above.

---

## 8. Operational checklist

- [ ] Extension ID pinned; `.pem` in the secret store, not in git
- [ ] `server-config.js` created from the example with a real token and host
- [ ] Backend origin present in `host_permissions` — the #1 silent failure
- [ ] `workstationTag` set per machine (mandatory for Firefox attribution)
- [ ] Pilot OU in `groupPolicies.pilot` for two weeks before enforcing
- [ ] False-positive rate measured against real county documents
- [ ] `neverScan` extended with your payroll, benefits, and case-management
      vendors — a case management system is exactly where an employee types an
      SSN legitimately all day
- [ ] Firefox XPI signed through AMO unlisted
- [ ] Monthly selector check (`data-testid*="send"` rots; budget for it)
- [ ] Written employee notice and acceptable-use policy
- [ ] Records retention schedule covering the event log **and** `site_coverage`
- [ ] Texas Public Information Act analysis — ask county counsel before
      collecting the first event, not after
