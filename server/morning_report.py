"""
Morning report.

Runs at 07:00 CT, after the 17:45 scoring pass has finished. Summarizes the
previous working day and emails an HTML brief.

Report period is the last completed day, so what lands at 07:00 Tuesday covers
Monday. Anything still pending -- items the agent could not score -- is shown
explicitly rather than dropped. A report that silently omits failures teaches
people to trust a number that isn't true.
"""

import json
import os
import smtplib
import sqlite3
import sys
from contextlib import closing
from datetime import datetime, timedelta
from email.message import EmailMessage
from html import escape
from pathlib import Path

DB = Path(os.environ.get("DLP_DB", "/var/lib/dlp/dlp.db"))
OUT_DIR = Path(os.environ.get("DLP_REPORTS", "/var/lib/dlp/reports"))
SMTP_HOST = os.environ.get("DLP_SMTP", "")
MAIL_FROM = os.environ.get("DLP_MAIL_FROM", "dlp-noreply@fortbendcountytx.gov")
MAIL_TO = [a for a in os.environ.get("DLP_MAIL_TO", "").split(",") if a.strip()]


def collect(conn, day):
    # The extension writes ts as new Date().toISOString() -- ISO-8601 UTC with
    # a 'T' separator ("2026-07-21T18:30:00.000Z"). A string BETWEEN against
    # "<day> 00:00".."<day> 23:59" silently excludes EVERY such row, because
    # 'T' sorts after ' '. Compare on date(ts,'localtime') instead: it parses
    # the ISO form and converts the UTC instant to the server's local day, so
    # a 7pm CT prompt lands on the CT day it happened, not the next UTC day.
    # setup.sh already enforces that this box runs America/Chicago.
    q = lambda sql, *a: conn.execute(sql, a).fetchall()

    totals = dict(
        q(
            "SELECT severity, COUNT(*) FROM events "
            "WHERE date(ts,'localtime')=? GROUP BY severity",
            day,
        )
    )
    by_site = q(
        "SELECT site, COUNT(*) FROM events "
        "WHERE date(ts,'localtime')=? AND severity!='clean' "
        "GROUP BY site ORDER BY 2 DESC",
        day,
    )
    rules = {}
    for (findings,) in q(
        "SELECT findings FROM events WHERE date(ts,'localtime')=? AND findings!='[]'",
        day,
    ):
        for f in json.loads(findings):
            rules[f["label"]] = rules.get(f["label"], 0) + 1

    scored = q(
        "SELECT site, ts, verdict FROM review_items WHERE date(ts,'localtime')=? "
        "AND status IN ('cleared','needs_review','expired')",
        day,
    )
    high = q(
        "SELECT site, ts, verdict, body, prompt_hash, source, employee "
        "FROM review_items "
        "WHERE date(ts,'localtime')=? AND status='needs_review' ORDER BY ts",
        day,
    )
    high = [
        {"site": a, "ts": b, "v": json.loads(c_), "body": d, "hash": e,
         "source": f, "employee": g or "unattributed"}
        for a, b, c_, d, e, f, g in high
    ]
    overrides = q(
        "SELECT ts, site, employee FROM events "
        "WHERE date(ts,'localtime')=? AND severity='override' ORDER BY ts",
        day,
    )
    histories = q(
        "SELECT employee, prompt_count, risk, categories, rationale "
        "FROM user_reviews WHERE day=? ORDER BY "
        "CASE risk WHEN 'high' THEN 0 WHEN 'low' THEN 1 ELSE 2 END",
        day,
    )
    histories = [
        {"employee": a, "count": b, "risk": c_, "cats": json.loads(d or "[]"), "why": e}
        for a, b, c_, d, e in histories
    ]

    pending = q(
        "SELECT COUNT(*) FROM review_items "
        "WHERE date(ts,'localtime')=? AND status='pending'",
        day,
    )[0][0]

    return {
        "day": day,
        "totals": totals,
        "prompts": sum(totals.values()),
        "by_site": by_site,
        "rules": sorted(rules.items(), key=lambda kv: -kv[1])[:8],
        "scored": len(scored),
        "high": high,
        "overrides": overrides,
        "histories": histories,
        "pending": pending,
    }


def render(d) -> str:
    rows = lambda pairs: "".join(
        f"<tr><td>{escape(str(k))}</td><td class=n>{v}</td></tr>" for k, v in pairs
    )
    high_rows = (
        "".join(
            f"<tr><td>{escape(h['employee'])}</td>"
            f"<td>{escape(h['site'])}</td><td>{escape(h['ts'][11:16])}</td>"
            f"<td>{escape(', '.join(h['v'].get('categories', [])) or '—')}</td>"
            f"<td>{escape(h['v'].get('rationale', ''))}</td></tr>"
            for h in d["high"]
        )
        or "<tr><td colspan=5 class=none>Nothing flagged for review.</td></tr>"
    )
    history_rows = (
        "".join(
            f"<tr><td>{escape(h['employee'])}</td><td class=n>{h['count']}</td>"
            f"<td>{'<strong>HIGH</strong>' if h['risk'] == 'high' else escape(h['risk'])}</td>"
            f"<td>{escape(h['why'])}{(' — ' + escape(', '.join(h['cats']))) if h['cats'] else ''}</td></tr>"
            for h in d["histories"]
        )
        or "<tr><td colspan=4 class=none>No history assessments for this day.</td></tr>"
    )
    override_rows = (
        "".join(
            f"<tr><td>{escape(emp or 'unattributed')}</td>"
            f"<td>{escape(site)}</td><td>{escape(ts[11:16])}</td></tr>"
            for ts, site, emp in d["overrides"]
        )
        or "<tr><td colspan=3 class=none>No warnings were overridden.</td></tr>"
    )

    return f"""<!doctype html><meta charset=utf-8>
<title>LLM Data Guard — {d['day']}</title>
<style>
 body{{font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#14171c;
      max-width:760px;margin:32px auto;padding:0 20px}}
 .eyebrow{{font:600 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;
      text-transform:uppercase;color:#6b7280}}
 h1{{font-size:22px;margin:8px 0 2px}}
 .sub{{color:#6b7280;margin:0 0 28px}}
 .kpis{{display:flex;gap:0;border-top:2px solid #14171c;border-bottom:1px solid #e3e6ea;
      margin-bottom:28px}}
 .kpi{{flex:1;padding:14px 0}}
 .kpi b{{display:block;font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}}
 .kpi span{{font-size:12px;color:#6b7280}}
 .kpi.alert b{{color:#b31b1b}}
 h2{{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;
     margin:28px 0 8px}}
 table{{width:100%;border-collapse:collapse;font-size:13px}}
 th{{text-align:left;font-weight:600;border-bottom:1px solid #14171c;padding:6px 8px 6px 0}}
 td{{padding:7px 8px 7px 0;border-bottom:1px solid #eef0f3;vertical-align:top}}
 .n{{text-align:right;font-variant-numeric:tabular-nums;width:60px}}
 .none{{color:#6b7280}}
 footer{{margin-top:32px;padding-top:14px;border-top:1px solid #e3e6ea;
        font-size:12px;color:#6b7280}}
</style>
<div class=eyebrow>Fort Bend County · LLM Data Guard</div>
<h1>Daily disclosure report</h1>
<p class=sub>Activity for {d['day']}</p>

<div class=kpis>
  <div class=kpi><b>{d['prompts']}</b><span>Prompts seen</span></div>
  <div class=kpi><b>{d['totals'].get('block',0)}</b><span>Blocked</span></div>
  <div class="kpi{' alert' if d['totals'].get('override') else ''}">
    <b>{d['totals'].get('override',0)}</b><span>Sent anyway</span></div>
  <div class="kpi{' alert' if d['high'] else ''}">
    <b>{len(d['high'])}</b><span>Requires review</span></div>
</div>

<h2>Requires review</h2>
<table><tr><th>Employee</th><th>Service</th><th>Time</th><th>Category</th><th>Assessment</th></tr>
{high_rows}</table>

<h2>Daily history assessment (per employee)</h2>
<table><tr><th>Employee</th><th>Prompts</th><th>Risk</th><th>Assessment</th></tr>
{history_rows}</table>

<h2>Warnings overridden ("Send anyway")</h2>
<table><tr><th>Employee</th><th>Service</th><th>Time</th></tr>
{override_rows}</table>

<h2>Most-triggered rules</h2>
<table>{rows(d['rules']) or '<tr><td class=none>None</td></tr>'}</table>

<h2>Activity by service</h2>
<table>{rows(d['by_site']) or '<tr><td class=none>None</td></tr>'}</table>

<footer>
<strong>Assessments are machine-generated and unverified.</strong> This is a
triage queue, not a finding. Full submitted text for the items above is in the
review file on the DLP server; it is deliberately not included in this email.
<br><br>
{d['scored']} prompts received semantic review.
{'<strong>' + str(d['pending']) + ' could not be scored and will retry tonight.</strong>'
 if d['pending'] else 'All staged prompts were scored.'}
Blocked prompts were never transmitted. Prompt text is deleted after scoring;
this report retains assessments only.
</footer>"""


def render_review(d) -> str:
    """The reviewer's working file. Contains the full submitted text, so it is
    written to the server with restrictive permissions and NEVER emailed."""
    items = "".join(
        f"""<article>
  <div class=meta><b>{escape(h['ts'][11:16])}</b> · {escape(h['employee'])} ·
    {escape(h['site'])} · via {escape(h['source'])} ·
    <span class=hash>{escape(h['hash'][:12])}</span></div>
  <div class=assess><b>Assessment:</b> {escape(h['v'].get('rationale',''))}
    <span class=cats>{escape(', '.join(h['v'].get('categories', [])))}</span></div>
  <pre>{escape(h['body'] or '(text expired or already purged)')}</pre>
</article>"""
        for h in d["high"]
    ) or "<p class=none>Nothing flagged for review on this date.</p>"

    return f"""<!doctype html><meta charset=utf-8>
<title>Review file — {d['day']}</title>
<style>
 body{{font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;color:#14171c;
      max-width:820px;margin:32px auto;padding:0 20px}}
 .banner{{border-left:4px solid #b31b1b;background:#fdf3f3;padding:12px 16px;
      margin-bottom:28px;font-size:13px}}
 h1{{font-size:21px;margin:6px 0 2px}}
 .sub{{color:#6b7280;margin:0 0 26px}}
 article{{border-top:1px solid #14171c;padding:16px 0 20px}}
 .meta{{font:12px ui-monospace,Menlo,monospace;color:#6b7280}}
 .hash{{color:#9aa1ab}}
 .assess{{margin:10px 0 12px;font-size:13px}}
 .cats{{display:block;color:#6b7280;font-size:12px;margin-top:3px}}
 pre{{background:#f6f7f9;border:1px solid #e3e6ea;padding:14px;overflow-x:auto;
     white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,Menlo,monospace}}
 .none{{color:#6b7280}}
</style>
<div class=banner>
  <b>Contains unredacted county data.</b> Do not forward, print, or paste into
  any AI service. Access is logged. Text is purged automatically after the
  retention window whether or not it has been reviewed.
</div>
<h1>Review file — {d['day']}</h1>
<p class=sub>{len(d['high'])} submissions flagged by the compliance agent.
Assessments are machine-generated and require human confirmation.</p>
{items}"""


def main():
    day = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    if len(sys.argv) > 1:
        day = sys.argv[1]

    with closing(sqlite3.connect(DB)) as conn:
        data = collect(conn, day)

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    html = render(data)
    path = OUT_DIR / f"dlp-report-{day}.html"
    path.write_text(html)
    print(f"wrote {path}")

    # Separate artifact. Full text lives here and only here.
    review_path = OUT_DIR / f"dlp-review-{day}.html"
    review_path.write_text(render_review(data))
    os.chmod(review_path, 0o600)
    print(f"wrote {review_path} (0600)")

    if not (SMTP_HOST and MAIL_TO):
        print("SMTP not configured; skipping send")
        return

    msg = EmailMessage()
    msg["Subject"] = (
        f"LLM Data Guard — {day} — {len(data['high'])} high risk, "
        f"{data['totals'].get('block',0)} blocked"
    )
    msg["From"] = MAIL_FROM
    msg["To"] = ", ".join(MAIL_TO)
    msg.set_content(
        "This report requires an HTML-capable mail client.\n"
        f"Full submitted text: {review_path} on the DLP server."
    )
    msg.add_alternative(html, subtype="html")

    with smtplib.SMTP(SMTP_HOST) as s:
        s.send_message(msg)
    print(f"sent to {len(MAIL_TO)} recipients")


if __name__ == "__main__":
    main()
