# Troubleshooting guide

Failure guide for the Square + WhatsApp Worker. Organized by **symptom**, with
the probable cause and the fix. All checks rely on logs and D1 records; the Worker
deliberately does not log names, phone numbers or addresses.

## 0. First diagnostic steps

1. **Is the Worker up?** `GET /` must return
   `Sabor do Brasil automation online | <BUILD_VERSION>`.
2. **Tail production logs** while reproducing the problem:

   ```bash
   npx wrangler tail --format pretty
   ```

3. **Inspect D1** (add `--remote` for production):

   ```bash
   npx wrangler d1 execute square-whatsapp-support --remote \
     --command "SELECT order_id, status, error_code, updated_at FROM order_notifications ORDER BY updated_at DESC LIMIT 10"
   ```

4. Remember that both webhooks answer `200` **before** processing
   (`ctx.waitUntil`). A `200` from the Worker does not mean a message was sent;
   the outcome is only visible in logs and D1.

### Log reference

| `source` in log | Meaning |
|---|---|
| `square` | Webhook accepted (event type and id) |
| `square-payment` | Payment event; shows payment status |
| `square-order` | Completed payment resolved to an order |
| `square-order-status` | Fulfillment/order update; may show `skipped` |
| `order-notification` | First (payment) notification result |
| `order-status-notification` | Status-change notification result |
| `whatsapp-delivery` | Meta delivery receipt (sent/delivered/read/failed) |
| `whatsapp` | Incoming customer message processed |

## 1. Square webhook

| Symptom | Probable cause | Fix |
|---|---|---|
| `403 Invalid Square signature` | `SQUARE_WEBHOOK_URL` differs from the notification URL registered in Square by even one byte (`http` vs `https`, trailing `/`, different domain) | Make both identical; the URL is part of the HMAC input |
| `403 Invalid Square signature` | Wrong `SQUARE_WEBHOOK_SIGNATURE_KEY` (sandbox key used in production, or key of another subscription) | Copy the key from the correct Square subscription and run `wrangler secret put SQUARE_WEBHOOK_SIGNATURE_KEY` |
| `403` only through a proxy/CDN | Proxy rewrites the body | Send the raw body unchanged; disable body-modifying rules |
| `500 Square webhook is not configured` | `SQUARE_WEBHOOK_SIGNATURE_KEY` or `SQUARE_WEBHOOK_URL` missing | Set both |
| `500 Validation error` | Signature header is not valid base64 or crypto failure | Check the `x-square-hmacsha256-signature` header |
| `400 Invalid JSON` | Body is not JSON | Check the sender |
| Square shows delivery failures | Worker unreachable or non-2xx | Open the root URL, check deployment and route |

## 2. Customer did not receive the first message

Check the `order-notification` / `square-order` logs in this order:

| Log evidence | Cause | Fix |
|---|---|---|
| No `square-payment` entry | Event not subscribed | Subscribe `payment.created`, `payment.updated` |
| `status: "..."` not `COMPLETED` | Payment still pending | Wait for `payment.updated` with `COMPLETED` |
| `Completed payment has no order ID` | Payment not linked to an order | Check how the sale was created in Square |
| nothing at all after `square-order` | `AUTO_ORDER_UPDATES_ENABLED` is not exactly `true` | Set it to `"true"` and redeploy |
| `Automatic order update skipped: SUPPORT_DB is missing` | D1 binding absent | Bind D1 as `SUPPORT_DB` |
| `reason: missing_customer_phone` | No valid phone (8-15 digits) on the fulfillment recipient or the Square customer profile | Make the phone mandatory at checkout; confirm the customer profile has it |
| `reason: customer_opted_out` | Customer sent `STOP` earlier | Customer must re-enable via menu > Order updates > Enable updates |
| `reason: already_processed` | Duplicate event; order already `ACCEPTED`/`SENDING` | Expected. Only `FAILED` rows are retried |
| `Automatic order update failed: WhatsApp API returned ...` | See section 4 | Use the code table |

To force a retry of a failed notification, the next payment event for the order
retries it automatically because `FAILED` rows can be re-reserved. Never delete
`ACCEPTED` rows to resend; that duplicates messages.

## 3. Status updates (preparing / ready / delivered) not sent

| Cause | Detail |
|---|---|
| Events not subscribed | Need `order.updated` and `order.fulfillment.updated` |
| `reason: order_not_linked_to_completed_payment` | Intentional. Orders are only notified after a completed payment created the tracking link (`order_tracking_links`). Link rows are deleted after 30 days |
| Fulfillment state ignored | Only `RESERVED`, `PREPARED`, `COMPLETED`, `CANCELED`, `FAILED` notify. `PROPOSED` is covered by the first message |
| Order has no fulfillment | Only order states `COMPLETED` and `CANCELED` notify |
| `already_processed` | One message per `(order_id, status_key)`. Moving a fulfillment back and forth to the same state does not resend |
| Customer opted out | See section 2 |

## 4. WhatsApp API errors

Errors appear as `WhatsApp API returned <HTTP>: <code>`. The code is stored in
`order_notifications.error_code` / `order_status_notifications.error_code`.

| Code | Meaning | Fix |
|---|---|---|
| `190` / HTTP 401 | Access token invalid or expired | Generate a System User token set to **Never expires**; `wrangler secret put META_ACCESS_TOKEN` |
| `100` | Invalid parameter (often wrong `META_PHONE_NUMBER_ID`) | Verify the phone number ID, not the WABA ID |
| `132001` | Template not found for that name/language | Names are lowercase and must match `META_ORDER_TEMPLATE_NAME`, `META_STATUS_TEMPLATE_NAME` and language (`en_US`) exactly; template must be approved |
| `132000` | Parameter count mismatch | Templates must have exactly 3 body variables: code, status, total |
| `132012` | Parameter format mismatch | Variables cannot contain newlines/tabs or long runs of spaces |
| `132015` / `132016` | Template paused or disabled for quality | Review the template in Meta Business Manager |
| `131030` | Recipient not in allowed list | Test numbers only; add the recipient or use a production number |
| `131047` | Outside the 24 h window for free-form text | Use a template, or wait for the customer to message first |
| `131026` | Message undeliverable | Number not on WhatsApp or invalid |
| `130429` / `131056` | Rate limit | Retry later; avoid bursts |

Delivery receipts that arrive later with `failed` update the same rows through
`message_id` (`whatsapp-delivery` log).

## 5. Meta webhook / bot does not answer

| Symptom | Cause | Fix |
|---|---|---|
| Meta cannot verify callback (`403 Verification failed`) | `hub.verify_token` differs from `META_VERIFY_TOKEN`, or `hub.mode` is not `subscribe` | Use the same token in both places |
| `403 Invalid Meta signature` | Wrong `META_APP_SECRET` (secret of another app) or modified body | Use the App Secret of the app that owns the number |
| `500 WhatsApp webhook is not configured` | `META_APP_SECRET` missing | Set it |
| Callback verified but no messages arrive | Field `messages` not subscribed | Subscribe the `messages` field on the WABA |
| Log `configured_phone_matches: false` | Webhook comes from a different number than `META_PHONE_NUMBER_ID` | Fix the variable or the subscription |
| Bot silent for one customer | Customer is in human support (`support_conversations.status = 'HUMAN'`); bot is intentionally silent up to 24 h after the customer's last message | Customer sends `BOT`, or use **Return to bot** in `/support` |
| Same message ignored twice | 24 h deduplication cache by message id | Expected; send a new message |
| `WhatsApp deduplication cache is unavailable` | Cache API failed | Harmless warning; duplicates may be reprocessed |
| Incoming interactive replies ignored | `message.type` unsupported (audio, image) | Only text, interactive and template-button replies are routed |

## 6. Order tracking

| Symptom | Cause | Fix |
|---|---|---|
| "couldn't link this WhatsApp number to exactly one recent order" | No order, or several active orders, for the phone in the last 7 days | Customer sends the 4-character receipt code and total, e.g. `F0Tl 17.00` |
| Receipt code not found | Payment older than 7 days (`PAYMENT_LOOKBACK_DAYS`), wrong `SQUARE_LOCATION_ID`, or payment not yet visible | Check the location; retry after a few seconds |
| Long `#` number from Square Online rejected | It is not exposed by the public API | Use the receipt code |
| Asked to resend with total | Several matching orders | Add the exact total |
| `Square API returned 401: UNAUTHORIZED` | `SQUARE_ACCESS_TOKEN` invalid | Rotate the token |
| `Square API returned 404: NOT_FOUND` | Order in another environment/location | Confirm production vs sandbox |
| `Square API variables are missing` | `SQUARE_API_BASE_URL` or `SQUARE_API_VERSION` unset | Set them |

## 7. Support inbox (`/support`)

| Response | Cause | Fix |
|---|---|---|
| `503 ADMIN_PASSWORD is not configured` | Secret missing | `wrangler secret put ADMIN_PASSWORD` |
| `503 SUPPORT_DB is not configured` | D1 not bound | Add the `[[d1_databases]]` binding |
| `401 Authentication required` | Wrong user/password (`ADMIN_USERNAME` defaults to `admin`) | Check credentials |
| `403 Invalid request origin` on POST | `Origin` (or `Sec-Fetch-Site: same-origin`) missing or different from the Worker origin | From browsers it is automatic; from Postman/curl send `Origin: https://<worker-domain>` |
| `400 Invalid phone` | Phone is not 8-15 digits | Send digits only, no `+` |
| `409 This conversation is no longer open` | Session expired (24 h) or returned to bot | Customer must request **Talk to us** again |
| `502 WhatsApp could not send this reply` | 24 h service window closed or token problem | See section 4 (`131047`, `190`) |
| `502 ... could not close this conversation` | Same as above | Close is only possible inside the window |
| Conversation list empty | Retention or session expiry cleanup ran | Expected after 24 h/30 days |

## 8. Database

| Symptom | Cause | Fix |
|---|---|---|
| `SUPPORT_DB binding is missing` | Binding name differs | It must be exactly `SUPPORT_DB` |
| Tables missing | First request failed | Worker creates them on first use; or run `migrations/0001_initial.sql` |
| Old records vanished | Cleanup removes support data and order records after 30 days | By design; adjust constants only with a privacy review |
| `Support database is unavailable` | D1 outage or schema creation error | Check Cloudflare status; retry |

## 9. Local tests

| Symptom | Fix |
|---|---|
| `Cannot find module 'node:sqlite'` | Use Node.js 22.5 or newer (24 recommended) |
| `node src/worker.mjs` prints nothing | Expected; the Worker is a module, not a server. Use `npm run validate` or `wrangler dev` |
| Tests need no credentials | They use synthetic `555` numbers; failing tests are code problems, not secrets |

## 10. Escalation checklist

Before opening an issue, collect: timestamp, event type and `event_id`, the
relevant `source` log lines, `error_code` from D1, and the build version from
`GET /`. **Never** include phone numbers, names, addresses or tokens.
