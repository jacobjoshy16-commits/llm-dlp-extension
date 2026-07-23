/*
 * Local detection ruleset.
 *
 * Everything here runs inside the browser. This is deliberate: the extension
 * must be able to decide "this is sensitive" WITHOUT first shipping the text
 * to a server. Otherwise the tool leaks the same data it exists to protect.
 *
 * Bulk pastes are handled separately by assessBulk() -- see the note there.
 *
 * Two severities:
 *   "block" - high confidence identifier. Submission is stopped.
 *   "warn"  - plausible but noisy. User sees a confirm step and can proceed.
 *
 * Tune these against real county document samples before you deploy. The
 * numbers below are starting points, not validated thresholds.
 */

const DLP_RULES = (() => {
  // Luhn check keeps 16-digit case numbers from being flagged as credit cards.
  function luhn(digits) {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = parseInt(digits[i], 10);
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  // Requires a nearby keyword. Cuts false positives on bare number strings.
  function nearKeyword(text, index, words, window = 40) {
    const start = Math.max(0, index - window);
    const slice = text.slice(start, index + window).toLowerCase();
    return words.some((w) => slice.includes(w));
  }

  const RULES = [
    {
      id: "ssn",
      label: "Social Security number",
      severity: "block",
      pattern: /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g,
    },
    {
      id: "ssn_bare",
      label: "possible Social Security number",
      severity: "block",
      pattern: /\b\d{9}\b/g,
      validate: (m, text, i) =>
        nearKeyword(text, i, ["ssn", "social security", "soc sec", "ss#", "tin"]),
    },
    {
      id: "credit_card",
      label: "payment card number",
      severity: "block",
      pattern: /\b(?:\d[ -]*?){13,19}\b/g,
      validate: (m) => {
        const d = m.replace(/\D/g, "");
        return d.length >= 13 && d.length <= 19 && luhn(d);
      },
    },
    {
      id: "tx_dl",
      label: "Texas driver license number",
      severity: "block",
      pattern: /\b\d{8}\b/g,
      validate: (m, text, i) =>
        nearKeyword(text, i, ["dl", "driver", "license", "licence", "dln", "tdl"]),
    },
    {
      id: "bank_account",
      label: "bank account or routing number",
      severity: "block",
      pattern: /\b\d{9,17}\b/g,
      validate: (m, text, i) =>
        nearKeyword(text, i, ["routing", "aba", "account no", "acct", "account #", "iban"]),
    },
    {
      id: "credential",
      label: "password or API credential",
      severity: "block",
      pattern:
        /\b(password|passwd|pwd|api[_ -]?key|secret[_ -]?key|access[_ -]?token|bearer)\b\s*[:=]\s*\S{6,}/gi,
    },
    {
      id: "private_key",
      label: "private key material",
      severity: "block",
      pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    },
    {
      id: "dob",
      label: "date of birth",
      severity: "warn",
      pattern: /\b(0?[1-9]|1[0-2])[\/\-](0?[1-9]|[12]\d|3[01])[\/\-](19|20)\d{2}\b/g,
      validate: (m, text, i) =>
        nearKeyword(text, i, ["dob", "date of birth", "born", "birthdate", "b-day"]),
    },
    {
      id: "case_number",
      label: "case or cause number",
      severity: "warn",
      pattern: /\b\d{2}-[A-Z]{2,4}-\d{4,8}\b/g,
    },
    {
      id: "medical",
      label: "medical or health information",
      severity: "warn",
      pattern:
        /\b(diagnos(is|ed)|patient|medical record|mrn|prescription|icd-?10|hipaa|treatment plan)\b/gi,
    },
    {
      id: "cjis",
      label: "criminal justice information",
      severity: "warn",
      // Vocabulary ABOUT criminal-justice data. Kept broad-ish because the
      // severity is warn (a confirm step), not block.
      pattern:
        /\b(cjis|ncic|tcic|tlets|criminal history|rap sheet|arrest record|warrant number|booking (number|no|#|date|sheet)|arrestee|probable cause|incident report|case disposition|probation|parole|offense (code|date|report))\b/gi,
    },
    {
      id: "cjis_id",
      label: "criminal justice identifier",
      severity: "warn",
      // Record content itself: bare numeric identifiers near CJIS context.
      // Keyword proximity keeps ordinary numbers from firing.
      pattern: /\b\d{6,12}\b/g,
      validate: (m, text, i) =>
        nearKeyword(text, i, [
          "sid", "fbi", "booking", "warrant", "incident", "citation",
          "cause no", "offense", "arrest",
        ]),
    },
    {
      id: "internal_host",
      label: "internal system or network detail",
      severity: "warn",
      pattern:
        /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
    },
    {
      id: "gov_email",
      label: "county email address",
      severity: "warn",
      pattern: /\b[\w.+-]+@(?:[\w-]+\.)*fortbendcountytx\.gov\b/gi,
    },
  ];

  /* ---------- scanning ----------
   *
   * Two entry points:
   *   scan(text)        synchronous, for normal-sized composer content
   *   scanChunked(text) async, yields between chunks so a 200KB spreadsheet
   *                     paste cannot freeze the tab
   *
   * Both apply the same rules. Chunking never lowers coverage: chunks overlap
   * by OVERLAP chars so a match straddling a boundary is still caught.
   */

  const CHUNK = 40000;
  const OVERLAP = 128;
  const MAX_PER_RULE = 5;

  function scanInto(slice, offset, findings, counts) {
    for (const rule of RULES) {
      if ((counts[rule.id] || 0) >= MAX_PER_RULE) continue;
      rule.pattern.lastIndex = 0;
      let m;
      while ((m = rule.pattern.exec(slice)) !== null) {
        if (rule.validate && !rule.validate(m[0], slice, m.index)) continue;
        counts[rule.id] = (counts[rule.id] || 0) + 1;
        findings.push({
          id: rule.id,
          label: rule.label,
          severity: rule.severity,
          index: offset + m.index,
          length: m[0].length,
          sample: redact(m[0]),
        });
        if (counts[rule.id] >= MAX_PER_RULE) break;
      }
    }
  }

  function dedupe(findings) {
    const seen = new Set();
    return findings.filter((f) => {
      const k = f.id + ":" + f.index;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /*
   * Structural check. Microseconds regardless of size, because it never runs a
   * regex -- it measures shape, not content.
   *
   * A 300KB tab-delimited paste into a public chat service is a bulk
   * disclosure whether or not any single cell matches a pattern. Checking
   * shape is both faster than scanning AND catches more: a sheet of names and
   * addresses contains no formatted identifier anywhere, and a content-only
   * ruleset waves it straight through.
   */
  function assessBulk(text) {
    if (!text || text.length < 8000) return null;
    const bytes = text.length;

    const head = text.slice(0, 4000);
    const lines = (head.match(/\n/g) || []).length;
    const tabs = (head.match(/\t/g) || []).length;
    const commas = (head.match(/,/g) || []).length;
    const tabular = lines >= 8 && (tabs >= lines * 2 || commas >= lines * 3);

    if (bytes >= 60000 || (tabular && bytes >= 8000)) {
      return {
        id: "bulk_paste",
        label: tabular
          ? `bulk tabular data (~${Math.round(bytes / 1024)}KB)`
          : `large text block (~${Math.round(bytes / 1024)}KB)`,
        severity: "block",
        index: 0,
        length: bytes,
        sample: "",
      };
    }
    return null;
  }

  function scan(text) {
    if (!text || text.length < 4) return [];
    const findings = [];
    const bulk = assessBulk(text);
    if (bulk) findings.push(bulk);
    scanInto(text, 0, findings, {});
    return dedupe(findings);
  }

  async function scanChunked(text) {
    if (!text || text.length < 4) return [];

    // Cheapest possible check first. If the payload is bulk, the verdict is
    // already "block" and there is nothing a full scan could add.
    const bulk = assessBulk(text);
    if (bulk) return [bulk];

    if (text.length <= CHUNK) return scan(text);

    const findings = [];
    const counts = {};
    for (let start = 0; start < text.length; start += CHUNK) {
      const end = Math.min(text.length, start + CHUNK + OVERLAP);
      scanInto(text.slice(start, end), start, findings, counts);

      // Once anything blocks, the verdict cannot get worse. Stopping here is
      // security-neutral -- the submission is already refused -- and it is what
      // makes a huge paste feel instant instead of hanging.
      if (findings.some((f) => f.severity === "block")) break;

      if (end < text.length) await new Promise((r) => setTimeout(r, 0));
    }
    return dedupe(findings);
  }

  // Keeps enough shape to be recognizable, not enough to be re-identifying.
  function redact(value) {
    if (value.length <= 4) return "*".repeat(value.length);
    return value.slice(0, 2) + "*".repeat(Math.min(value.length - 4, 12)) + value.slice(-2);
  }

  function worstSeverity(findings) {
    if (findings.some((f) => f.severity === "block")) return "block";
    if (findings.length) return "warn";
    return "clean";
  }

  return { scan, scanChunked, assessBulk, redact, worstSeverity, RULES };
})();