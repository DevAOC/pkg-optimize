# Security Policy

Thanks for taking the time to report security issues responsibly. This
document explains what's in scope, how to report a vulnerability, and what to
expect after you do.

## Supported versions

`pkg-optimize` is pre-1.0, so only the latest released `0.x` minor line
receives security fixes. Older `0.x` minors are not patched — upgrade to the
latest `0.x` release.

| Version       | Supported          |
| ------------- | ------------------ |
| Latest `0.x`  | :white_check_mark: |
| Older `0.x`   | :x:                |

This will change once `1.0.0` ships; the table will be updated to cover the
current major + previous major at that point.

## Reporting a vulnerability

**Please do not open a public GitHub issue, discussion, or PR for security
reports.** Public reports give attackers a head-start on users who haven't
upgraded yet.

Use one of the following private channels instead:

### Preferred: GitHub private vulnerability reporting

1. Go to <https://github.com/DevAOC/pkg-optimize/security/advisories/new>.
2. Click **Report a vulnerability**.
3. Fill in the form. The report opens a private advisory visible only to you
   and the maintainers.

This is the preferred channel because the entire triage, fix, and disclosure
conversation happens in one place, and we can request a CVE for the resulting
advisory through GitHub.

### Fallback: email

If you can't use GitHub's reporting flow, email
**antoineocharette@gmail.com** with the subject line prefixed `[pkg-optimize
security]`.

PGP is not currently set up. If you need an encrypted channel, mention that in
a short initial email and we'll arrange one.

## What to include in a report

The more of the following you can provide, the faster we can triage and fix:

- A clear description of the issue and the impact (RCE, path traversal,
  denial of service, supply-chain risk, etc.).
- The version of `pkg-optimize` and the Node.js version you reproduced on.
- A minimal reproduction: a config snippet, a tiny fixture package, or a
  failing test case is ideal. If the issue requires a specific layout under
  `node_modules`, describe or attach it.
- Any proof-of-concept code, exploit script, or attacker-controlled input.
- Whether you've already disclosed the issue to anyone else, and any
  embargo or coordinated-disclosure constraints we should know about.
- How you'd like to be credited in the advisory (or "anonymous" if you'd
  rather not be named).

## What to expect from us

This is a small project with a single maintainer, so the timelines below are
best-effort rather than contractual:

- **Acknowledgement**: within 3 business days of the initial report.
- **Initial triage**: within 7 days — we'll confirm the issue, assess
  severity, and tell you whether we accept it as a security issue or treat it
  as a regular bug.
- **Fix and release**: severity-dependent. Critical issues get an out-of-band
  patch release as fast as we can turn one around. High-severity issues
  target a release within 30 days. Lower-severity issues may be batched into
  the next regular release.
- **Public advisory**: published via GitHub Security Advisories at the same
  time as the patched release, with a CVE if appropriate. We'll credit the
  reporter unless they've asked otherwise.

## Coordinated disclosure

We follow standard coordinated-disclosure practice:

- We won't publish details of the issue or the fix until a patched version is
  available on npm.
- We ask reporters to keep the issue private for at least 90 days from the
  initial report, or until we ship a fix — whichever comes first. If 90 days
  pass without a fix, we'll work with you on a sensible disclosure timeline
  rather than asking for an indefinite embargo.

## Out of scope

The following generally aren't treated as `pkg-optimize` security issues:

- Vulnerabilities in target packages that `pkg-optimize` prunes — those
  belong to the upstream package.
- Vulnerabilities in transitive dependencies — please report those upstream;
  we'll bump our dependency once a fix is published.
- Issues that require an attacker to already have local write access to the
  repository's `node_modules` or source files. `pkg-optimize` operates on the
  trusted code in your project; an attacker who can already modify that code
  has a much bigger problem than this tool.

If you're unsure whether something qualifies, send the report anyway — we'd
rather decline an out-of-scope report than miss a real issue.
