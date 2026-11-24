# Security policy

Distinct handles logins and acts on websites for its owner, so security reports are very welcome.

## Reporting a vulnerability
Please **do not open a public issue**. Use GitHub's **"Report a vulnerability"** button on the repository's *Security* tab (private advisory). Include steps to reproduce and the impact you see.

## What is in scope
- Reading vault values without the master password, or the AI/model obtaining a secret value
- Reaching admin pages (vault, settings, data) from anywhere other than the local PC
- Bypassing webhook authentication (Meta signature, Twilio signature, iMessage URL secret, Siri bearer token) or owner-only checks
- Getting a vault value typed on a site that isn't in the entry's allowed sites, or into a payment field
- Getting bank/card data stored, typed or sent to a model despite the bank rule
- Prompt-injection paths that lead to an action the owner didn't approve (purchase, email, deletion)

## Design notes
- Vault: scrypt (N=2^17, r=8, p=1) → AES-256-GCM; header authenticated as AAD; atomic writes.
- Admin UI: bound to 127.0.0.1, loopback + Host + no-proxy-header checks, CSRF token, strict CSP, no JavaScript.
- Secrets are never part of tool results; snapshots and screenshots mask password and vault-filled fields.
- Never commit your `data/` folder: it contains your encrypted vault, settings and activity log (it is git-ignored).
