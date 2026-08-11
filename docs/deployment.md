# Deployment guide

This guide describes the production shape used by the case study. Use separate
applications and credentials for every client deployment.

## 1. Cloudflare resources

Create:

1. One Cloudflare Worker.
2. One D1 database.
3. A D1 binding named exactly `SUPPORT_DB`.

The Worker creates missing tables on first use. The SQL in
`migrations/0001_initial.sql` is included as a reviewable schema reference.

## 2. Meta permanent access token

For production, use a **Meta System User access token configured to never
expire**. Do not rely on the temporary token shown in the WhatsApp Getting
Started panel.

In Meta Business Settings:

1. Open **Users → System users** and create or select a system user with the
   **Admin** role.
2. Under **Assigned assets**, assign the Meta app used by this integration and
   grant **Full control**.
3. Assign the production **WhatsApp Business Account (WABA)** to the same system
   user and grant **Full control**.
4. Click **Generate token** for that system user and choose the application.
5. When Meta presents the token expiration option, select **Never expires**.
6. Grant both required WhatsApp permissions:
   - `whatsapp_business_management`
   - `whatsapp_business_messaging`
7. Generate the token, copy it immediately, and store it as the Cloudflare
   encrypted secret `META_ACCESS_TOKEN`.

With Wrangler:

```bash
npx wrangler secret put META_ACCESS_TOKEN
```

The generated credential must never be committed to source control. A token
configured with no scheduled expiration can still be invalidated if it is
revoked, the system user is removed, or its access to the app/WABA is changed.

## 3. Encrypted secrets

Configure these as **Secret** values, never plaintext:

- `ADMIN_PASSWORD`
- `META_ACCESS_TOKEN`
- `META_APP_SECRET`
- `META_VERIFY_TOKEN`
- `SQUARE_ACCESS_TOKEN`
- `SQUARE_WEBHOOK_SIGNATURE_KEY`

With Wrangler:

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put META_ACCESS_TOKEN
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_VERIFY_TOKEN
npx wrangler secret put SQUARE_ACCESS_TOKEN
npx wrangler secret put SQUARE_WEBHOOK_SIGNATURE_KEY
```

## 4. Plaintext variables

Use the names from `.env.example`. The important production values are:

| Variable | Example / meaning |
|---|---|
| `AUTO_ORDER_UPDATES_ENABLED` | `true` after both templates are approved |
| `BUSINESS_TIME_ZONE` | `America/Toronto` |
| `MENU_URL` | Public Square Online URL |
| `META_ORDER_TEMPLATE_NAME` | `order_received_update` |
| `META_ORDER_TEMPLATE_LANGUAGE` | `en_US` |
| `META_PHONE_NUMBER_ID` | ID of the registered production number |
| `META_STATUS_TEMPLATE_NAME` | `order_status_update` |
| `META_STATUS_TEMPLATE_LANGUAGE` | `en_US` |
| `SQUARE_API_BASE_URL` | `https://connect.squareup.com` |
| `SQUARE_API_VERSION` | Version used by the Square application |
| `SQUARE_LOCATION_ID` | Production location ID |
| `SQUARE_WEBHOOK_URL` | Exact `/webhooks/square` notification URL |

The optional variables `BUSINESS_HOURS`, `DELIVERY_INFO`, `ALLERGEN_INFO` and
`PAYMENT_INFO` override customer-facing bot responses.

## 5. Meta webhook

- Callback URL: `https://<worker-domain>/webhooks/whatsapp`
- Verify token: the value stored in `META_VERIFY_TOKEN`
- Subscribed field: `messages`

The Worker verifies `X-Hub-Signature-256` using `META_APP_SECRET`.

## 6. Square webhook

- Notification URL: `https://<worker-domain>/webhooks/square`
- Events:
  - `payment.created`
  - `payment.updated`
  - `order.updated`
  - `order.fulfillment.updated`

`SQUARE_WEBHOOK_URL` must match the notification URL byte for byte because it is
part of Square's HMAC input.

## 7. Initial-order template

Create a Meta **Utility** template in **English (US)** named
`order_received_update`.

```text
We received your Sabor do Brasil order {{1}}.
Status: {{2}}
Total: {{3}}

Use the options below for order information. Reply STOP to stop WhatsApp order updates.
```

Quick replies, in order:

1. `Track order`
2. `More options`
3. `Talk to us`

## 8. Status-update template

Create a second Meta **Utility** template in **English (US)** named
`order_status_update`.

```text
Your Sabor do Brasil order {{1}} has been updated.

New status: {{2}}
Total: {{3}}

Use the options below for more information. Reply STOP to stop WhatsApp order updates.
```

Use the same three quick replies and the same order. Template names are
lowercase and must match the Cloudflare variables exactly.

## 9. Deploy and verify

```bash
cp wrangler.toml.example wrangler.toml
# Replace placeholder IDs and URLs in wrangler.toml.
npm run validate
npx wrangler deploy
```

Expected root response:

```text
Sabor do Brasil automation online | 2026-08-06.5-launch-hardening
```

## 10. Production acceptance test

Use a real zero-value or low-value test item and a Canadian WhatsApp number.

1. Place an order using a number that has never contacted the bot.
2. Confirm the initial template arrives.
3. Change the Square fulfillment to **In progress**.
4. Confirm **Being prepared** arrives automatically.
5. Change it to **Ready** and confirm **Ready for delivery**.
6. Complete delivery and confirm **Delivered**.
7. Use **Track order** and verify the current Square status.
8. Use **Talk to us**, reply in `/support`, then select **Return to bot**.
9. Send `STOP`, place another order and confirm no automatic notification.
10. Reactivate updates from the bot menu and verify delivery resumes.

Do not enable public ordering until all ten checks pass.
