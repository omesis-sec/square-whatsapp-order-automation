# Security policy

## Reporting a vulnerability

Please do not disclose a vulnerability in a public issue. Contact the repository
owner through the GitHub profile associated with this repository and include a
short reproduction, affected endpoint and expected impact.

## Operational requirements

- Store API tokens, webhook signature keys and passwords as encrypted
  Cloudflare secrets.
- Never commit `.dev.vars`, `.env`, production IDs, customer phone numbers or
  webhook payloads containing personal data.
- Rotate any credential immediately if it appears in a screenshot, log, commit
  or support conversation.
- Keep both Square HMAC and Meta `X-Hub-Signature-256` verification enabled.
- Protect `/support` with a unique administrator password and HTTPS.
- Use least-privilege Meta system-user tokens and review access periodically.
- Keep the D1 retention policy aligned with the business privacy policy.

The public test suite uses reserved `555` example phone numbers and synthetic
orders only.

