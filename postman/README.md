# Postman collection

## Files

| File | Purpose |
|---|---|
| `square-whatsapp.postman_collection.json` | Health, Square webhook, WhatsApp webhook and support-inbox requests |
| `local.postman_environment.json` | Local variables with placeholder values only |

## Setup

1. Start the Worker locally with `npm run dev` (needs `wrangler.toml` and `.dev.vars`
   copied from the `.example` files).
2. In Postman, import both files and select the **Square WhatsApp - Local
   (wrangler dev)** environment.
3. Make these environment values equal to the ones in `.dev.vars` / `wrangler.toml`:

   | Environment variable | Must match |
   |---|---|
   | `square_webhook_signature_key` | `SQUARE_WEBHOOK_SIGNATURE_KEY` |
   | `square_webhook_url` | `SQUARE_WEBHOOK_URL` (exact string) |
   | `meta_app_secret` | `META_APP_SECRET` |
   | `meta_verify_token` | `META_VERIFY_TOKEN` |
   | `meta_phone_number_id` | `META_PHONE_NUMBER_ID` |
   | `admin_username` / `admin_password` | `ADMIN_USERNAME` / `ADMIN_PASSWORD` |

4. Run the collection folder by folder, or individual requests.

## How signing works

Webhook requests carry pre-request scripts that compute the signatures, so the
body can be edited freely:

- Square: `base64(HMAC-SHA256(key, square_webhook_url + body))`
- Meta: `sha256=` + `hex(HMAC-SHA256(app_secret, body))`

The `Invalid signature` requests intentionally skip signing and expect `403`.

## Safety

- Outgoing WhatsApp and Square calls are real if the Worker has real tokens.
  Use test credentials, or keep `customer_phone` on a `555` number.
- Never save real tokens, phone numbers or order data into the environment
  or export it back to the repository.
- `Reply to customer` and `Return to bot` accept `200` or `409`; `409` means no
  human conversation is open. Run `List: HUMAN_HELP (opens support)` first.
- Support POST requests send an `Origin` header equal to `base_url`, as the
  Worker requires.
