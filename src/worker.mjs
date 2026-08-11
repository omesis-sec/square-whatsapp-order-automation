const DEFAULT_META_GRAPH_API_VERSION = "v23.0";
const DEFAULT_MENU_URL = "https://sabor-do-brasil.square.site";
const DEFAULT_TIME_ZONE = "America/Toronto";
const PAYMENT_LOOKBACK_DAYS = 7;
const MAX_PAYMENT_PAGES = 5;
const MAX_ORDER_PAGES = 3;
const SUPPORT_SESSION_HOURS = 24;
const SUPPORT_RETENTION_DAYS = 30;
const ORDER_AUTOMATION_RETENTION_DAYS = 30;
const SUPPORT_MESSAGE_MAX_LENGTH = 4096;
const DEFAULT_ORDER_TEMPLATE_NAME = "order_received_update";
const DEFAULT_ORDER_TEMPLATE_LANGUAGE = "en_US";
const BUILD_VERSION = "2026-08-06.5-launch-hardening";

let supportSchemaPromise;

async function verifySquareWebhook(
  signature,
  rawBody,
  notificationUrl,
  signatureKey
) {
  if (!signature || !notificationUrl || !signatureKey) {
    return false;
  }

  let signatureBytes;

  try {
    signatureBytes = Uint8Array.from(
      atob(signature),
      (character) => character.charCodeAt(0)
    );
  } catch {
    return false;
  }

  const encoder = new TextEncoder();

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signatureKey),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["verify"]
  );

  return crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    signatureBytes,
    encoder.encode(notificationUrl + rawBody)
  );
}

async function verifyMetaWebhook(signatureHeader, rawBody, appSecret) {
  if (
    !signatureHeader ||
    !appSecret ||
    !signatureHeader.startsWith("sha256=")
  ) {
    return false;
  }

  const signatureHex = signatureHeader.slice("sha256=".length);

  if (!/^[a-f0-9]{64}$/i.test(signatureHex)) {
    return false;
  }

  const signatureBytes = new Uint8Array(
    signatureHex.match(/.{2}/g).map((byte) => parseInt(byte, 16))
  );

  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["verify"]
  );

  return crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    signatureBytes,
    encoder.encode(rawBody)
  );
}

async function squareApiRequest(
  path,
  env,
  { method = "GET", body } = {}
) {
  if (
    !env.SQUARE_ACCESS_TOKEN ||
    !env.SQUARE_API_BASE_URL ||
    !env.SQUARE_API_VERSION
  ) {
    throw new Error("Square API variables are missing");
  }

  const response = await fetch(`${env.SQUARE_API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      "Square-Version": env.SQUARE_API_VERSION,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorCode =
      responseBody?.errors?.[0]?.code ?? "UNKNOWN_ERROR";

    throw new Error(
      `Square API returned ${response.status}: ${errorCode}`
    );
  }

  return responseBody;
}

async function processSquarePaymentEvent(event, env) {
  if (
    event.type !== "payment.created" &&
    event.type !== "payment.updated"
  ) {
    return;
  }

  let payment = event?.data?.object?.payment;

  if (!payment && event?.data?.id) {
    const paymentResponse = await squareApiRequest(
      `/v2/payments/${encodeURIComponent(event.data.id)}`,
      env
    );

    payment = paymentResponse.payment;
  }

  if (!payment) {
    console.warn("Square event contains no payment");
    return;
  }

  console.log(
    JSON.stringify({
      source: "square-payment",
      payment_id: payment.id ?? "unknown",
      status: payment.status ?? "unknown",
      has_order_id: Boolean(payment.order_id),
    })
  );

  if (payment.status !== "COMPLETED") {
    return;
  }

  if (!payment.order_id) {
    console.warn("Completed payment has no order ID");
    return;
  }

  const orderResponse = await squareApiRequest(
    `/v2/orders/${encodeURIComponent(payment.order_id)}`,
    env
  );

  const order = orderResponse.order;

  if (!order) {
    throw new Error("Square returned no order");
  }

  const fulfillment = getPrimaryFulfillment(order);
  const recipientResult = await resolveOrderRecipient(order, env);
  const recipient = recipientResult.recipient;

  console.log(
    JSON.stringify({
      source: "square-order",
      order_id: order.id ?? "unknown",
      state: order.state ?? "unknown",
      item_count: order.line_items?.length ?? 0,
      total_amount: order.total_money?.amount ?? null,
      currency: order.total_money?.currency ?? null,
      fulfillment_type: fulfillment?.type ?? null,
      has_customer_phone: Boolean(recipient?.phone_number),
      customer_phone_source: recipientResult.source,
    })
  );

  await rememberOrderTrackingLink(
    order,
    payment,
    recipient?.phone_number,
    env
  );

  await maybeSendAutomaticOrderUpdate(
    {
      payment,
      order,
      recipient,
    },
    env
  );
}

function extractOrderIdFromSquareEvent(event) {
  const object = event?.data?.object ?? {};

  return (
    object?.order_fulfillment_updated?.order_id ??
    object?.order_updated?.order_id ??
    event?.data?.id ??
    null
  );
}

async function processSquareOrderStatusEvent(event, env) {
  if (
    event.type !== "order.updated" &&
    event.type !== "order.fulfillment.updated"
  ) {
    return;
  }

  const orderId = extractOrderIdFromSquareEvent(event);

  if (!orderId) {
    console.warn("Square order event contains no order ID");
    return;
  }

  const orderResponse = await squareApiRequest(
    `/v2/orders/${encodeURIComponent(orderId)}`,
    env
  );
  const order = orderResponse.order;

  if (!order) {
    throw new Error("Square returned no order for status update");
  }

  const recipientResult = await resolveOrderRecipient(order, env);
  const rememberedPhone = await findRememberedPhoneByOrderId(
    order.id,
    env
  );

  // Only notify orders already linked by a completed-payment webhook.
  // This prevents pre-payment order edits from contacting the customer.
  if (!rememberedPhone) {
    console.log(
      JSON.stringify({
        source: "square-order-status",
        event_type: event.type,
        order_id: order.id,
        status: "skipped",
        reason: "order_not_linked_to_completed_payment",
      })
    );
    return;
  }

  const phone =
    recipientResult.recipient?.phone_number ?? rememberedPhone ?? null;
  const recipient = phone
    ? {
        ...(recipientResult.recipient ?? {}),
        phone_number: phone,
      }
    : recipientResult.recipient;

  await rememberOrderTrackingLink(order, null, phone, env);

  console.log(
    JSON.stringify({
      source: "square-order-status",
      event_type: event.type,
      order_id: order.id,
      order_state: order.state ?? "unknown",
      fulfillment_state:
        getPrimaryFulfillment(order)?.state ?? null,
      has_customer_phone: Boolean(phone),
      customer_phone_source: rememberedPhone
        ? "tracking_link"
        : recipientResult.source,
    })
  );

  await maybeSendAutomaticStatusChange(
    {
      order,
      recipient,
      eventId: event.event_id ?? null,
    },
    env
  );
}

async function processSquareWebhookEvent(event, env) {
  if (
    event.type === "payment.created" ||
    event.type === "payment.updated"
  ) {
    await processSquarePaymentEvent(event, env);
    return;
  }

  if (
    event.type === "order.updated" ||
    event.type === "order.fulfillment.updated"
  ) {
    await processSquareOrderStatusEvent(event, env);
  }
}

function getMetaGraphApiVersion(env) {
  const configured =
    env.META_GRAPH_API_VERSION ?? DEFAULT_META_GRAPH_API_VERSION;

  return configured.startsWith("v") ? configured : `v${configured}`;
}

async function whatsappApiRequest(payload, env) {
  if (!env.META_ACCESS_TOKEN || !env.META_PHONE_NUMBER_ID) {
    throw new Error("WhatsApp API variables are missing");
  }

  const graphVersion = getMetaGraphApiVersion(env);
  const endpoint =
    `https://graph.facebook.com/${graphVersion}/` +
    `${encodeURIComponent(env.META_PHONE_NUMBER_ID)}/messages`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorCode = responseBody?.error?.code ?? "UNKNOWN_ERROR";

    throw new Error(
      `WhatsApp API returned ${response.status}: ${errorCode}`
    );
  }

  return responseBody;
}

async function sendWhatsAppText(
  recipient,
  body,
  env,
  previewUrl = false
) {
  return whatsappApiRequest(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "text",
      text: {
        preview_url: previewUrl,
        body,
      },
    },
    env
  );
}

async function sendWhatsAppOrderTemplate(
  recipient,
  { orderCode, status, total },
  env,
  templateOverrides = {}
) {
  const templateName =
    templateOverrides.name ??
    env.META_ORDER_TEMPLATE_NAME ??
    DEFAULT_ORDER_TEMPLATE_NAME;
  const languageCode =
    templateOverrides.language ??
    env.META_ORDER_TEMPLATE_LANGUAGE ??
    DEFAULT_ORDER_TEMPLATE_LANGUAGE;

  return whatsappApiRequest(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "template",
      template: {
        name: templateName,
        language: {
          code: languageCode,
        },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: orderCode },
              { type: "text", text: status },
              { type: "text", text: total },
            ],
          },
          {
            type: "button",
            sub_type: "quick_reply",
            index: "0",
            parameters: [
              { type: "payload", payload: "TRACK_ORDER" },
            ],
          },
          {
            type: "button",
            sub_type: "quick_reply",
            index: "1",
            parameters: [
              { type: "payload", payload: "HELLO" },
            ],
          },
          {
            type: "button",
            sub_type: "quick_reply",
            index: "2",
            parameters: [
              { type: "payload", payload: "HUMAN_HELP" },
            ],
          },
        ],
      },
    },
    env
  );
}

async function sendWhatsAppOrderUpdatesPrompt(recipient, env) {
  return whatsappApiRequest(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "interactive",
      interactive: {
        type: "button",
        header: {
          type: "text",
          text: "Sabor do Brasil Toronto",
        },
        body: {
          text:
            "Receive automatic WhatsApp updates from Sabor do Brasil " +
            "about your orders? Use this same phone number at Square " +
            "checkout. You can stop at any time by sending STOP.\n\n" +
            "Deseja receber atualizações automáticas dos seus pedidos " +
            "pelo WhatsApp? Use este mesmo número no checkout do Square. " +
            "Você pode cancelar a qualquer momento enviando STOP.",
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: "ENABLE_UPDATES",
                title: "Enable updates",
              },
            },
            {
              type: "reply",
              reply: {
                id: "NO_UPDATES",
                title: "No thanks",
              },
            },
          ],
        },
      },
    },
    env
  );
}

async function sendWhatsAppMenu(recipient, env) {
  return whatsappApiRequest(
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "interactive",
      interactive: {
        type: "list",
        header: {
          type: "text",
          text: "Sabor do Brasil Toronto",
        },
        body: {
          text:
            "Welcome! How can we help?\n\n" +
            "Bem-vindo! Como podemos ajudar?",
        },
        footer: {
          text: "Freshly made in Toronto",
        },
        action: {
          button: "Choose / Escolher",
          sections: [
            {
              title: "Customer service",
              rows: [
                {
                  id: "TRACK_ORDER",
                  title: "Track my order",
                  description: "Check the current status of your order",
                },
                {
                  id: "VIEW_MENU",
                  title: "View menu",
                  description: "Browse dishes and order through Square",
                },
                {
                  id: "DELIVERY_INFO",
                  title: "Delivery",
                  description: "Area, availability and delivery information",
                },
                {
                  id: "HOURS_INFO",
                  title: "Opening hours",
                  description: "See when online ordering is available",
                },
                {
                  id: "ALLERGEN_INFO",
                  title: "Allergens",
                  description: "Important food allergy information",
                },
                {
                  id: "PAYMENT_INFO",
                  title: "Payments",
                  description: "How secure online payment works",
                },
                {
                  id: "HUMAN_HELP",
                  title: "Talk to us",
                  description: "Continue with a member of our team",
                },
                {
                  id: "ORDER_UPDATES",
                  title: "Order updates",
                  description: "Receive automatic WhatsApp notifications",
                },
              ],
            },
          ],
        },
      },
    },
    env
  );
}

function supportDatabaseAvailable(env) {
  return Boolean(env.SUPPORT_DB);
}

async function ensureSupportSchema(env) {
  if (!supportDatabaseAvailable(env)) {
    throw new Error("SUPPORT_DB binding is missing");
  }

  if (!supportSchemaPromise) {
    supportSchemaPromise = env.SUPPORT_DB.batch([
      env.SUPPORT_DB.prepare(
        `CREATE TABLE IF NOT EXISTS support_conversations (
          phone TEXT PRIMARY KEY,
          display_name TEXT,
          status TEXT NOT NULL DEFAULT 'BOT',
          opened_at TEXT,
          updated_at TEXT NOT NULL,
          last_customer_at TEXT,
          last_message_preview TEXT,
          unread_count INTEGER NOT NULL DEFAULT 0
        )`
      ),
      env.SUPPORT_DB.prepare(
        `CREATE TABLE IF NOT EXISTS support_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone TEXT NOT NULL,
          direction TEXT NOT NULL,
          message_type TEXT NOT NULL DEFAULT 'text',
          body TEXT NOT NULL,
          external_id TEXT UNIQUE,
          created_at TEXT NOT NULL
        )`
      ),
      env.SUPPORT_DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_support_messages_phone_created
         ON support_messages (phone, created_at)`
      ),
      env.SUPPORT_DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_support_conversations_status_updated
         ON support_conversations (status, updated_at)`
      ),
      env.SUPPORT_DB.prepare(
        `CREATE TABLE IF NOT EXISTS whatsapp_order_update_consents (
          phone TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          source TEXT NOT NULL,
          evidence_message_id TEXT,
          consented_at TEXT,
          opted_out_at TEXT,
          updated_at TEXT NOT NULL
        )`
      ),
      env.SUPPORT_DB.prepare(
        `CREATE TABLE IF NOT EXISTS order_notifications (
          order_id TEXT PRIMARY KEY,
          payment_id TEXT,
          phone TEXT NOT NULL,
          message_id TEXT UNIQUE,
          status TEXT NOT NULL,
          error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`
      ),
      env.SUPPORT_DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_order_notifications_message_id
         ON order_notifications (message_id)`
      ),
      env.SUPPORT_DB.prepare(
        `CREATE TABLE IF NOT EXISTS order_tracking_links (
          order_id TEXT PRIMARY KEY,
          payment_id TEXT,
          phone TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )`
      ),
      env.SUPPORT_DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_order_tracking_links_phone_updated
         ON order_tracking_links (phone, updated_at DESC)`
      ),
      env.SUPPORT_DB.prepare(
        `CREATE TABLE IF NOT EXISTS order_status_notifications (
          order_id TEXT NOT NULL,
          status_key TEXT NOT NULL,
          phone TEXT NOT NULL,
          message_id TEXT UNIQUE,
          status TEXT NOT NULL,
          error_code TEXT,
          event_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (order_id, status_key)
        )`
      ),
      env.SUPPORT_DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_order_status_notifications_message_id
         ON order_status_notifications (message_id)`
      ),
    ]).catch((error) => {
      supportSchemaPromise = undefined;
      throw error;
    });
  }

  await supportSchemaPromise;
}

function supportTimestamp() {
  return new Date().toISOString();
}

function supportPreview(body) {
  return String(body ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function automaticOrderUpdatesEnabled(env) {
  return String(env.AUTO_ORDER_UPDATES_ENABLED ?? "")
    .trim()
    .toLowerCase() === "true";
}

async function setOrderUpdateConsent(
  phone,
  optedIn,
  source,
  evidenceMessageId,
  env
) {
  await ensureSupportSchema(env);

  const normalizedPhone = normalizePhoneNumber(phone);

  if (!/^\d{8,15}$/.test(normalizedPhone)) {
    throw new Error("Invalid WhatsApp phone number");
  }

  const now = supportTimestamp();
  const status = optedIn ? "OPTED_IN" : "OPTED_OUT";

  await env.SUPPORT_DB.prepare(
    `INSERT INTO whatsapp_order_update_consents (
      phone, status, source, evidence_message_id,
      consented_at, opted_out_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      status = excluded.status,
      source = excluded.source,
      evidence_message_id = excluded.evidence_message_id,
      consented_at = CASE
        WHEN excluded.status = 'OPTED_IN' THEN excluded.consented_at
        ELSE consented_at
      END,
      opted_out_at = CASE
        WHEN excluded.status = 'OPTED_OUT' THEN excluded.opted_out_at
        ELSE NULL
      END,
      updated_at = excluded.updated_at`
  )
    .bind(
      normalizedPhone,
      status,
      source,
      evidenceMessageId || null,
      optedIn ? now : null,
      optedIn ? null : now,
      now
    )
    .run();
}

async function getOrderUpdateConsentStatus(phone, env) {
  if (!supportDatabaseAvailable(env)) {
    return null;
  }

  await ensureSupportSchema(env);

  const normalizedPhone = normalizePhoneNumber(phone);
  const record = await env.SUPPORT_DB.prepare(
    `SELECT status
     FROM whatsapp_order_update_consents
     WHERE phone = ?`
  )
    .bind(normalizedPhone)
    .first();

  return record?.status ?? null;
}

async function rememberOrderTrackingLink(
  order,
  payment,
  phone,
  env
) {
  if (!supportDatabaseAvailable(env)) {
    return;
  }

  const normalizedPhone = normalizePhoneNumber(phone);

  if (
    !order?.id ||
    !/^\d{8,15}$/.test(normalizedPhone)
  ) {
    return;
  }

  await ensureSupportSchema(env);

  const now = supportTimestamp();

  await env.SUPPORT_DB.prepare(
    `INSERT INTO order_tracking_links (
      order_id, payment_id, phone, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      payment_id = COALESCE(excluded.payment_id, payment_id),
      phone = excluded.phone,
      updated_at = excluded.updated_at`
  )
    .bind(
      order.id,
      payment?.id || null,
      normalizedPhone,
      order.created_at || now,
      now
    )
    .run();
}

async function findRememberedOrderIdsByPhone(phone, env) {
  if (!supportDatabaseAvailable(env)) {
    return [];
  }

  const normalizedPhone = normalizePhoneNumber(phone);

  if (!/^\d{8,15}$/.test(normalizedPhone)) {
    return [];
  }

  await ensureSupportSchema(env);

  const startAt = new Date(
    Date.now() - PAYMENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const result = await env.SUPPORT_DB.prepare(
    `SELECT order_id
     FROM order_tracking_links
     WHERE phone = ? AND created_at >= ?
     ORDER BY updated_at DESC
     LIMIT 20`
  )
    .bind(normalizedPhone, startAt)
    .all();

  return (result.results ?? [])
    .map((record) => record.order_id)
    .filter(Boolean);
}

async function findRememberedPhoneByOrderId(orderId, env) {
  if (!supportDatabaseAvailable(env) || !orderId) {
    return null;
  }

  await ensureSupportSchema(env);

  const record = await env.SUPPORT_DB.prepare(
    `SELECT phone
     FROM order_tracking_links
     WHERE order_id = ?`
  )
    .bind(orderId)
    .first();

  return record?.phone ?? null;
}

async function reserveOrderNotification(
  orderId,
  paymentId,
  phone,
  env
) {
  await ensureSupportSchema(env);

  const now = supportTimestamp();
  const result = await env.SUPPORT_DB.prepare(
    `INSERT INTO order_notifications (
      order_id, payment_id, phone, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'SENDING', ?, ?)
    ON CONFLICT(order_id) DO UPDATE SET
      payment_id = COALESCE(excluded.payment_id, payment_id),
      phone = excluded.phone,
      message_id = NULL,
      status = 'SENDING',
      error_code = NULL,
      updated_at = excluded.updated_at
    WHERE order_notifications.status = 'FAILED'`
  )
    .bind(orderId, paymentId || null, phone, now, now)
    .run();

  return result?.meta?.changes !== 0;
}

async function finishOrderNotification(
  orderId,
  status,
  messageId,
  errorCode,
  env
) {
  await ensureSupportSchema(env);

  await env.SUPPORT_DB.prepare(
    `UPDATE order_notifications
     SET status = ?, message_id = COALESCE(?, message_id),
         error_code = ?, updated_at = ?
     WHERE order_id = ?`
  )
    .bind(
      status,
      messageId || null,
      errorCode || null,
      supportTimestamp(),
      orderId
    )
    .run();
}

async function updateOrderNotificationDeliveryStatus(
  messageId,
  status,
  errorCode,
  env
) {
  if (!supportDatabaseAvailable(env) || !messageId) {
    return;
  }

  await ensureSupportSchema(env);

  const normalizedStatus = String(status ?? "unknown").toUpperCase();
  const normalizedError = errorCode ? String(errorCode) : null;
  const now = supportTimestamp();

  await env.SUPPORT_DB.batch([
    env.SUPPORT_DB.prepare(
      `UPDATE order_notifications
       SET status = ?, error_code = ?, updated_at = ?
       WHERE message_id = ?`
    ).bind(normalizedStatus, normalizedError, now, messageId),
    env.SUPPORT_DB.prepare(
      `UPDATE order_status_notifications
       SET status = ?, error_code = ?, updated_at = ?
       WHERE message_id = ?`
    ).bind(normalizedStatus, normalizedError, now, messageId),
  ]);
}

function formatOrderTotal(order) {
  const amount = order?.total_money?.amount;
  const currency = order?.total_money?.currency ?? "CAD";

  if (!Number.isSafeInteger(amount)) {
    return currency;
  }

  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency,
    }).format(amount / 100);
  } catch {
    return `${currency} ${(amount / 100).toFixed(2)}`;
  }
}

async function maybeSendAutomaticOrderUpdate(
  { payment, order, recipient },
  env
) {
  if (!automaticOrderUpdatesEnabled(env)) {
    return;
  }

  if (!supportDatabaseAvailable(env)) {
    console.warn("Automatic order update skipped: SUPPORT_DB is missing");
    return;
  }

  const phone = normalizePhoneNumber(recipient?.phone_number);

  if (!/^\d{8,15}$/.test(phone)) {
    console.log(
      JSON.stringify({
        source: "order-notification",
        order_id: order?.id ?? "unknown",
        status: "skipped",
        reason: "missing_customer_phone",
      })
    );
    return;
  }

  const consentStatus = await getOrderUpdateConsentStatus(phone, env);

  // Consent is collected in person before the customer places the order.
  // A previous STOP always takes priority and prevents future notifications.
  if (consentStatus === "OPTED_OUT") {
    console.log(
      JSON.stringify({
        source: "order-notification",
        order_id: order?.id ?? "unknown",
        status: "skipped",
        reason: "customer_opted_out",
      })
    );
    return;
  }

  if (consentStatus !== "OPTED_IN") {
    await setOrderUpdateConsent(
      phone,
      true,
      "in_person_before_square_order",
      null,
      env
    );
  }

  const reserved = await reserveOrderNotification(
    order.id,
    payment?.id,
    phone,
    env
  );

  if (!reserved) {
    console.log(
      JSON.stringify({
        source: "order-notification",
        order_id: order.id,
        status: "skipped",
        reason: "already_processed",
      })
    );
    return;
  }

  const orderCode = String(
    order.ticket_name ||
      payment?.receipt_number ||
      order.id.slice(-8)
  );
  const status = describeOrderStatus(order).en;
  const total = formatOrderTotal(order);

  try {
    const response = await sendWhatsAppOrderTemplate(
      phone,
      { orderCode, status, total },
      env
    );
    const messageId = response?.messages?.[0]?.id ?? null;

    await finishOrderNotification(
      order.id,
      "ACCEPTED",
      messageId,
      null,
      env
    );

    console.log(
      JSON.stringify({
        source: "order-notification",
        order_id: order.id,
        status: "accepted",
        has_message_id: Boolean(messageId),
      })
    );
  } catch (error) {
    const errorCode =
      String(error?.message ?? "").match(/:\s*([A-Z0-9_]+)$/)?.[1] ??
      "SEND_ERROR";

    await finishOrderNotification(
      order.id,
      "FAILED",
      null,
      errorCode,
      env
    );

    console.error(
      `Automatic order update failed: ${error.message}`
    );
  }
}

function getAutomaticStatusChange(order) {
  const fulfillment = getPrimaryFulfillment(order);

  if (fulfillment) {
    const state = fulfillment.state ?? "UNKNOWN";

    if (
      ![
        "RESERVED",
        "PREPARED",
        "COMPLETED",
        "CANCELED",
        "FAILED",
      ].includes(state)
    ) {
      return null;
    }

    return {
      key:
        `FULFILLMENT:${fulfillment.uid ?? fulfillment.type ?? "PRIMARY"}:` +
        state,
      status: describeOrderStatus(order).en,
    };
  }

  if (!["COMPLETED", "CANCELED"].includes(order?.state)) {
    return null;
  }

  return {
    key: `ORDER:${order.state}`,
    status: describeOrderStatus(order).en,
  };
}

async function reserveOrderStatusNotification(
  orderId,
  statusKey,
  phone,
  eventId,
  env
) {
  await ensureSupportSchema(env);

  const now = supportTimestamp();
  const result = await env.SUPPORT_DB.prepare(
    `INSERT INTO order_status_notifications (
      order_id, status_key, phone, status, event_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'SENDING', ?, ?, ?)
    ON CONFLICT(order_id, status_key) DO UPDATE SET
      phone = excluded.phone,
      message_id = NULL,
      status = 'SENDING',
      error_code = NULL,
      event_id = excluded.event_id,
      updated_at = excluded.updated_at
    WHERE order_status_notifications.status = 'FAILED'`
  )
    .bind(orderId, statusKey, phone, eventId, now, now)
    .run();

  return result?.meta?.changes !== 0;
}

async function finishOrderStatusNotification(
  orderId,
  statusKey,
  status,
  messageId,
  errorCode,
  env
) {
  await ensureSupportSchema(env);

  await env.SUPPORT_DB.prepare(
    `UPDATE order_status_notifications
     SET status = ?, message_id = COALESCE(?, message_id),
         error_code = ?, updated_at = ?
     WHERE order_id = ? AND status_key = ?`
  )
    .bind(
      status,
      messageId || null,
      errorCode || null,
      supportTimestamp(),
      orderId,
      statusKey
    )
    .run();
}

async function maybeSendAutomaticStatusChange(
  { order, recipient, eventId },
  env
) {
  if (!automaticOrderUpdatesEnabled(env)) {
    return;
  }

  if (!supportDatabaseAvailable(env)) {
    console.warn("Automatic status update skipped: SUPPORT_DB is missing");
    return;
  }

  const change = getAutomaticStatusChange(order);

  // PROPOSED/OPEN is covered by the initial payment notification.
  if (!change) {
    return;
  }

  const phone = normalizePhoneNumber(recipient?.phone_number);

  if (!/^\d{8,15}$/.test(phone)) {
    console.log(
      JSON.stringify({
        source: "order-status-notification",
        order_id: order?.id ?? "unknown",
        status: "skipped",
        reason: "missing_customer_phone",
      })
    );
    return;
  }

  const consentStatus = await getOrderUpdateConsentStatus(phone, env);

  if (consentStatus === "OPTED_OUT") {
    console.log(
      JSON.stringify({
        source: "order-status-notification",
        order_id: order.id,
        status: "skipped",
        reason: "customer_opted_out",
      })
    );
    return;
  }

  if (consentStatus !== "OPTED_IN") {
    await setOrderUpdateConsent(
      phone,
      true,
      "in_person_before_square_order",
      null,
      env
    );
  }

  const reserved = await reserveOrderStatusNotification(
    order.id,
    change.key,
    phone,
    eventId,
    env
  );

  if (!reserved) {
    console.log(
      JSON.stringify({
        source: "order-status-notification",
        order_id: order.id,
        status_key: change.key,
        status: "skipped",
        reason: "already_processed",
      })
    );
    return;
  }

  const orderCode = String(
    order.ticket_name || order.reference_id || order.id.slice(-8)
  );
  const total = formatOrderTotal(order);

  try {
    const response = await sendWhatsAppOrderTemplate(
      phone,
      {
        orderCode,
        status: change.status,
        total,
      },
      env,
      {
        name:
          env.META_STATUS_TEMPLATE_NAME ??
          env.META_ORDER_TEMPLATE_NAME ??
          DEFAULT_ORDER_TEMPLATE_NAME,
        language:
          env.META_STATUS_TEMPLATE_LANGUAGE ??
          env.META_ORDER_TEMPLATE_LANGUAGE ??
          DEFAULT_ORDER_TEMPLATE_LANGUAGE,
      }
    );
    const messageId = response?.messages?.[0]?.id ?? null;

    await finishOrderStatusNotification(
      order.id,
      change.key,
      "ACCEPTED",
      messageId,
      null,
      env
    );

    console.log(
      JSON.stringify({
        source: "order-status-notification",
        order_id: order.id,
        status_key: change.key,
        status: "accepted",
        has_message_id: Boolean(messageId),
      })
    );
  } catch (error) {
    const errorCode =
      String(error?.message ?? "").match(/:\s*([A-Z0-9_]+)$/)?.[1] ??
      "SEND_ERROR";

    await finishOrderStatusNotification(
      order.id,
      change.key,
      "FAILED",
      null,
      errorCode,
      env
    );

    console.error(
      `Automatic status update failed: ${error.message}`
    );
  }
}

async function openSupportConversation(phone, displayName, env) {
  await ensureSupportSchema(env);

  const now = supportTimestamp();

  await env.SUPPORT_DB.prepare(
    `INSERT INTO support_conversations (
      phone, display_name, status, opened_at, updated_at,
      last_customer_at, last_message_preview, unread_count
    ) VALUES (?, ?, 'HUMAN', ?, ?, ?, '', 0)
    ON CONFLICT(phone) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, display_name),
      status = 'HUMAN',
      opened_at = excluded.opened_at,
      updated_at = excluded.updated_at,
      last_customer_at = excluded.last_customer_at,
      unread_count = 0`
  )
    .bind(phone, displayName || null, now, now, now)
    .run();
}

async function closeSupportConversation(phone, env) {
  if (!supportDatabaseAvailable(env)) {
    return;
  }

  await ensureSupportSchema(env);

  await env.SUPPORT_DB.prepare(
    `UPDATE support_conversations
     SET status = 'BOT', updated_at = ?, unread_count = 0
     WHERE phone = ?`
  )
    .bind(supportTimestamp(), phone)
    .run();
}

async function getActiveSupportConversation(phone, env) {
  if (!supportDatabaseAvailable(env)) {
    return null;
  }

  await ensureSupportSchema(env);

  const conversation = await env.SUPPORT_DB.prepare(
    `SELECT phone, display_name, status, opened_at, updated_at,
            last_customer_at, last_message_preview, unread_count
     FROM support_conversations
     WHERE phone = ? AND status = 'HUMAN'`
  )
    .bind(phone)
    .first();

  if (!conversation) {
    return null;
  }

  // A janela de atendimento do WhatsApp conta a partir da última
  // mensagem enviada pelo cliente, não da última resposta da equipe.
  const lastActivity = Date.parse(
    conversation.last_customer_at ||
      conversation.opened_at ||
      conversation.updated_at
  );
  const expiresAfter = SUPPORT_SESSION_HOURS * 60 * 60 * 1000;

  if (
    Number.isFinite(lastActivity) &&
    Date.now() - lastActivity > expiresAfter
  ) {
    await closeSupportConversation(phone, env);
    return null;
  }

  return conversation;
}

async function storeSupportMessage(
  {
    phone,
    direction,
    body,
    messageType = "text",
    externalId = null,
    displayName = null,
  },
  env
) {
  await ensureSupportSchema(env);

  const normalizedBody = String(body ?? "")
    .trim()
    .slice(0, SUPPORT_MESSAGE_MAX_LENGTH);

  if (!normalizedBody) {
    return false;
  }

  const now = supportTimestamp();
  const insertResult = await env.SUPPORT_DB.prepare(
    `INSERT INTO support_messages (
      phone, direction, message_type, body, external_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO NOTHING`
  )
    .bind(
      phone,
      direction,
      messageType,
      normalizedBody,
      externalId,
      now
    )
    .run();

  if (insertResult?.meta?.changes === 0) {
    return false;
  }

  const isIncoming = direction === "IN";

  await env.SUPPORT_DB.prepare(
    `INSERT INTO support_conversations (
      phone, display_name, status, opened_at, updated_at,
      last_customer_at, last_message_preview, unread_count
    ) VALUES (?, ?, 'HUMAN', ?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, display_name),
      updated_at = excluded.updated_at,
      last_customer_at = CASE
        WHEN ? = 1 THEN excluded.last_customer_at
        ELSE last_customer_at
      END,
      last_message_preview = excluded.last_message_preview,
      unread_count = CASE
        WHEN ? = 1 THEN unread_count + 1
        ELSE unread_count
      END`
  )
    .bind(
      phone,
      displayName || null,
      now,
      now,
      isIncoming ? now : null,
      supportPreview(normalizedBody),
      isIncoming ? 1 : 0,
      isIncoming ? 1 : 0,
      isIncoming ? 1 : 0
    )
    .run();

  return true;
}

async function markSupportConversationRead(phone, env) {
  await ensureSupportSchema(env);

  await env.SUPPORT_DB.prepare(
    `UPDATE support_conversations SET unread_count = 0 WHERE phone = ?`
  )
    .bind(phone)
    .run();
}

async function listSupportConversations(env) {
  await ensureSupportSchema(env);

  const retentionModifier = `-${SUPPORT_RETENTION_DAYS} days`;
  const sessionModifier = `-${SUPPORT_SESSION_HOURS} hours`;
  const orderRetentionModifier =
    `-${ORDER_AUTOMATION_RETENTION_DAYS} days`;

  await env.SUPPORT_DB.batch([
    env.SUPPORT_DB.prepare(
      `UPDATE support_conversations
       SET status = 'BOT', updated_at = ?, unread_count = 0
       WHERE status = 'HUMAN'
         AND datetime(COALESCE(last_customer_at, opened_at, updated_at))
             < datetime('now', ?)`
    ).bind(supportTimestamp(), sessionModifier),
    env.SUPPORT_DB.prepare(
      `DELETE FROM support_messages
       WHERE datetime(created_at) < datetime('now', ?)`
    ).bind(retentionModifier),
    env.SUPPORT_DB.prepare(
      `DELETE FROM support_conversations
       WHERE status = 'BOT'
         AND datetime(updated_at) < datetime('now', ?)`
    ).bind(retentionModifier),
    env.SUPPORT_DB.prepare(
      `DELETE FROM order_tracking_links
       WHERE datetime(updated_at) < datetime('now', ?)`
    ).bind(orderRetentionModifier),
    env.SUPPORT_DB.prepare(
      `DELETE FROM order_notifications
       WHERE datetime(updated_at) < datetime('now', ?)`
    ).bind(orderRetentionModifier),
    env.SUPPORT_DB.prepare(
      `DELETE FROM order_status_notifications
       WHERE datetime(updated_at) < datetime('now', ?)`
    ).bind(orderRetentionModifier),
  ]);

  const result = await env.SUPPORT_DB.prepare(
    `SELECT phone, display_name, status, opened_at, updated_at,
            last_customer_at, last_message_preview, unread_count
     FROM support_conversations
     WHERE status = 'HUMAN'
     ORDER BY updated_at DESC
     LIMIT 100`
  ).all();

  return result.results ?? [];
}

async function listSupportMessages(phone, env) {
  await ensureSupportSchema(env);

  const result = await env.SUPPORT_DB.prepare(
    `SELECT id, phone, direction, message_type, body, created_at
     FROM (
       SELECT id, phone, direction, message_type, body, created_at
       FROM support_messages
       WHERE phone = ?
       ORDER BY id DESC
       LIMIT 200
     )
     ORDER BY id ASC`
  )
    .bind(phone)
    .all();

  return result.results ?? [];
}

function extractIncomingSupportText(message) {
  if (message?.type === "text") {
    return message.text?.body?.trim() ?? "";
  }

  if (message?.type === "interactive") {
    return (
      message.interactive?.button_reply?.title ??
      message.interactive?.list_reply?.title ??
      message.interactive?.button_reply?.id ??
      message.interactive?.list_reply?.id ??
      "Interactive response"
    );
  }

  if (message?.type === "button") {
    return message.button?.text ?? message.button?.payload ?? "Button";
  }

  const labels = {
    audio: "[Audio message / Mensagem de áudio]",
    image: "[Image / Imagem]",
    video: "[Video / Vídeo]",
    document: "[Document / Documento]",
    location: "[Location / Localização]",
    contacts: "[Contact / Contato]",
    sticker: "[Sticker / Figurinha]",
  };

  return labels[message?.type] ?? "[Unsupported message / Mensagem não suportada]";
}

async function sendAndStoreSupportText(phone, body, env) {
  const response = await sendWhatsAppText(phone, body, env);
  const externalId = response?.messages?.[0]?.id ?? null;

  await storeSupportMessage(
    {
      phone,
      direction: "OUT",
      body,
      externalId,
    },
    env
  );

  return response;
}

function adminCredentialsAreValid(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return false;
  }

  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Basic ")) {
    return false;
  }

  let decoded;

  try {
    decoded = atob(authorization.slice("Basic ".length));
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");

  if (separator < 0) {
    return false;
  }

  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  const expectedUsername = env.ADMIN_USERNAME ?? "admin";

  return username === expectedUsername && password === env.ADMIN_PASSWORD;
}

function supportAdminHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
}

function supportJsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: supportAdminHeaders("application/json; charset=UTF-8"),
  });
}

function supportAdminPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Sabor do Brasil | Support</title>
  <style>
    :root {
      color-scheme: light;
      --green: #245a3b;
      --green-dark: #173e29;
      --terracotta: #b85c30;
      --cream: #faf7f0;
      --paper: #ffffff;
      --ink: #212121;
      --muted: #6d665f;
      --line: #e5ddd2;
      --incoming: #f2eee7;
      --outgoing: #dcebdd;
      --danger: #9e2f2f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--cream);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 20px;
      color: #fff;
      background: var(--green);
      box-shadow: 0 2px 10px rgba(0,0,0,.12);
    }
    header h1 { margin: 0; font-size: 20px; }
    header p { margin: 3px 0 0; font-size: 12px; opacity: .82; }
    .status { font-size: 12px; white-space: nowrap; }
    main {
      display: grid;
      grid-template-columns: minmax(250px, 340px) 1fr;
      height: calc(100vh - 71px);
      max-width: 1400px;
      margin: 0 auto;
      background: var(--paper);
    }
    aside {
      min-width: 0;
      overflow-y: auto;
      border-right: 1px solid var(--line);
      background: #fff;
    }
    .aside-title {
      position: sticky;
      top: 0;
      z-index: 2;
      padding: 14px 16px;
      font-size: 13px;
      font-weight: 700;
      color: var(--muted);
      background: rgba(255,255,255,.96);
      border-bottom: 1px solid var(--line);
    }
    .conversation {
      width: 100%;
      display: grid;
      grid-template-columns: 44px 1fr auto;
      gap: 10px;
      align-items: center;
      padding: 13px 14px;
      border: 0;
      border-bottom: 1px solid var(--line);
      background: #fff;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }
    .conversation:hover, .conversation.active { background: #f4efe7; }
    .avatar {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      color: #fff;
      background: var(--green);
      font-weight: 800;
    }
    .conversation-name { font-weight: 750; overflow: hidden; text-overflow: ellipsis; }
    .conversation-preview {
      margin-top: 3px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .badge {
      min-width: 22px;
      padding: 3px 7px;
      border-radius: 99px;
      text-align: center;
      color: #fff;
      background: var(--terracotta);
      font-size: 11px;
      font-weight: 800;
    }
    .empty-list { padding: 28px 18px; color: var(--muted); text-align: center; }
    .chat { min-width: 0; display: grid; grid-template-rows: auto 1fr auto; }
    .chat-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      min-height: 64px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
    }
    .chat-name { font-weight: 800; }
    .chat-phone { margin-top: 3px; color: var(--muted); font-size: 12px; }
    .close-button {
      border: 1px solid #d7b3b3;
      border-radius: 9px;
      padding: 8px 10px;
      color: var(--danger);
      background: #fff;
      font-weight: 700;
      cursor: pointer;
    }
    .messages {
      overflow-y: auto;
      padding: 20px clamp(12px, 4vw, 50px);
      background:
        linear-gradient(rgba(250,247,240,.94), rgba(250,247,240,.94)),
        radial-gradient(circle at 20px 20px, #d9d1c5 1px, transparent 1px);
      background-size: auto, 28px 28px;
    }
    .message-row { display: flex; margin: 8px 0; }
    .message-row.out { justify-content: flex-end; }
    .bubble {
      max-width: min(78%, 680px);
      padding: 10px 12px 7px;
      border-radius: 13px;
      background: var(--incoming);
      box-shadow: 0 1px 2px rgba(0,0,0,.08);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .message-row.out .bubble { background: var(--outgoing); }
    .message-time { margin-top: 5px; color: var(--muted); font-size: 10px; text-align: right; }
    .composer {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      padding: 12px;
      border-top: 1px solid var(--line);
      background: #fff;
    }
    textarea {
      width: 100%;
      min-height: 48px;
      max-height: 130px;
      resize: vertical;
      border: 1px solid #cfc7bb;
      border-radius: 12px;
      padding: 12px;
      color: var(--ink);
      background: #fff;
      font: inherit;
    }
    textarea:focus { outline: 2px solid rgba(36,90,59,.22); border-color: var(--green); }
    .send-button {
      align-self: stretch;
      min-width: 92px;
      border: 0;
      border-radius: 12px;
      padding: 0 18px;
      color: #fff;
      background: var(--green);
      font-weight: 800;
      cursor: pointer;
    }
    .send-button:disabled, .close-button:disabled { opacity: .45; cursor: not-allowed; }
    .welcome {
      display: grid;
      place-items: center;
      height: 100%;
      padding: 30px;
      color: var(--muted);
      text-align: center;
    }
    @media (max-width: 760px) {
      header { padding: 12px 14px; }
      header h1 { font-size: 17px; }
      main { grid-template-columns: 1fr; grid-template-rows: minmax(130px, 30vh) 1fr; height: calc(100vh - 63px); }
      aside { border-right: 0; border-bottom: 1px solid var(--line); }
      .chat-header { min-height: 56px; }
      .bubble { max-width: 88%; }
      .composer { grid-template-columns: 1fr 78px; }
      .send-button { min-width: 0; padding: 0 10px; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Sabor do Brasil | Support</h1>
      <p>Human WhatsApp conversations</p>
    </div>
    <div class="status" id="status">Connecting...</div>
  </header>
  <main>
    <aside>
      <div class="aside-title">OPEN CONVERSATIONS</div>
      <div id="conversations"></div>
    </aside>
    <section class="chat">
      <div class="chat-header">
        <div>
          <div class="chat-name" id="chatName">Select a conversation</div>
          <div class="chat-phone" id="chatPhone"></div>
        </div>
        <button class="close-button" id="closeButton" disabled>Return to bot</button>
      </div>
      <div class="messages" id="messages">
        <div class="welcome">Select a customer to start.</div>
      </div>
      <form class="composer" id="composer">
        <textarea id="reply" maxlength="4096" placeholder="Write a reply..." disabled></textarea>
        <button class="send-button" id="sendButton" disabled>Send</button>
      </form>
    </section>
  </main>
  <script>
    var selectedPhone = null;
    var selectedName = null;
    var refreshing = false;

    async function api(path, options) {
      var response = await fetch(path, options || {});
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        throw new Error(data.error || "Request failed");
      }
      return data;
    }

    function setStatus(text) {
      document.getElementById("status").textContent = text;
    }

    function initials(name, phone) {
      var source = (name || phone || "?").trim();
      var pieces = source.split(/\s+/).filter(Boolean);
      return pieces.slice(0, 2).map(function (piece) {
        return piece.charAt(0).toUpperCase();
      }).join("") || "?";
    }

    function renderConversations(items) {
      var root = document.getElementById("conversations");
      root.textContent = "";

      if (!items.length) {
        var empty = document.createElement("div");
        empty.className = "empty-list";
        empty.textContent = "No customers are waiting.";
        root.appendChild(empty);
        return;
      }

      items.forEach(function (item) {
        var button = document.createElement("button");
        button.className = "conversation" + (item.phone === selectedPhone ? " active" : "");

        var avatar = document.createElement("div");
        avatar.className = "avatar";
        avatar.textContent = initials(item.display_name, item.phone);

        var content = document.createElement("div");
        var name = document.createElement("div");
        name.className = "conversation-name";
        name.textContent = item.display_name || ("+" + item.phone);
        var preview = document.createElement("div");
        preview.className = "conversation-preview";
        preview.textContent = item.last_message_preview || "Waiting for a message";
        content.appendChild(name);
        content.appendChild(preview);

        button.appendChild(avatar);
        button.appendChild(content);

        if (Number(item.unread_count) > 0) {
          var badge = document.createElement("span");
          badge.className = "badge";
          badge.textContent = String(item.unread_count);
          button.appendChild(badge);
        } else {
          button.appendChild(document.createElement("span"));
        }

        button.addEventListener("click", function () {
          selectedPhone = item.phone;
          selectedName = item.display_name || ("+" + item.phone);
          document.getElementById("chatName").textContent = selectedName;
          document.getElementById("chatPhone").textContent = "+" + item.phone;
          document.getElementById("reply").disabled = false;
          document.getElementById("sendButton").disabled = false;
          document.getElementById("closeButton").disabled = false;
          loadMessages(true);
          loadConversations(false);
        });

        root.appendChild(button);
      });
    }

    function renderMessages(items, scrollToBottom) {
      var root = document.getElementById("messages");
      root.textContent = "";

      if (!items.length) {
        var empty = document.createElement("div");
        empty.className = "welcome";
        empty.textContent = "The customer has not sent a question yet.";
        root.appendChild(empty);
        return;
      }

      items.forEach(function (item) {
        var row = document.createElement("div");
        row.className = "message-row " + (item.direction === "OUT" ? "out" : "in");
        var bubble = document.createElement("div");
        bubble.className = "bubble";
        var text = document.createElement("div");
        text.textContent = item.body;
        var time = document.createElement("div");
        time.className = "message-time";
        time.textContent = new Date(item.created_at).toLocaleString();
        bubble.appendChild(text);
        bubble.appendChild(time);
        row.appendChild(bubble);
        root.appendChild(row);
      });

      if (scrollToBottom) {
        root.scrollTop = root.scrollHeight;
      }
    }

    async function loadConversations(selectFirst) {
      try {
        var data = await api("/support/api/conversations");
        var items = data.conversations || [];

        if (selectedPhone && !items.some(function (item) { return item.phone === selectedPhone; })) {
          selectedPhone = null;
          selectedName = null;
        }

        if (!selectedPhone && selectFirst && items.length) {
          selectedPhone = items[0].phone;
          selectedName = items[0].display_name || ("+" + items[0].phone);
          document.getElementById("chatName").textContent = selectedName;
          document.getElementById("chatPhone").textContent = "+" + selectedPhone;
          document.getElementById("reply").disabled = false;
          document.getElementById("sendButton").disabled = false;
          document.getElementById("closeButton").disabled = false;
        }

        renderConversations(items);
        setStatus("Online | " + items.length + " open");
      } catch (error) {
        setStatus("Error: " + error.message);
      }
    }

    async function loadMessages(scrollToBottom) {
      if (!selectedPhone) return;
      try {
        var data = await api("/support/api/messages?phone=" + encodeURIComponent(selectedPhone));
        renderMessages(data.messages || [], scrollToBottom);
      } catch (error) {
        setStatus("Error: " + error.message);
      }
    }

    async function refresh() {
      if (refreshing) return;
      refreshing = true;
      await loadConversations(true);
      await loadMessages(false);
      refreshing = false;
    }

    document.getElementById("composer").addEventListener("submit", async function (event) {
      event.preventDefault();
      var input = document.getElementById("reply");
      var body = input.value.trim();
      if (!selectedPhone || !body) return;

      document.getElementById("sendButton").disabled = true;
      try {
        await api("/support/api/reply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: selectedPhone, body: body })
        });
        input.value = "";
        await loadMessages(true);
        await loadConversations(false);
      } catch (error) {
        alert(error.message);
      } finally {
        document.getElementById("sendButton").disabled = false;
      }
    });

    document.getElementById("closeButton").addEventListener("click", async function () {
      if (!selectedPhone) return;
      if (!confirm("Return this customer to the automated bot?")) return;
      try {
        await api("/support/api/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: selectedPhone })
        });
        selectedPhone = null;
        selectedName = null;
        document.getElementById("chatName").textContent = "Select a conversation";
        document.getElementById("chatPhone").textContent = "";
        document.getElementById("reply").disabled = true;
        document.getElementById("sendButton").disabled = true;
        document.getElementById("closeButton").disabled = true;
        document.getElementById("messages").innerHTML = '<div class="welcome">Select a customer to start.</div>';
        await loadConversations(true);
        await loadMessages(true);
      } catch (error) {
        alert(error.message);
      }
    });

    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

function mutationOriginIsValid(request) {
  const origin = request.headers.get("origin");

  if (origin) {
    return origin === new URL(request.url).origin;
  }

  return request.headers.get("sec-fetch-site") === "same-origin";
}

async function readSupportRequestJson(request) {
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("Expected JSON request");
  }

  return request.json();
}

async function handleSupportAdminRequest(request, env, url) {
  if (!env.ADMIN_PASSWORD) {
    return new Response("ADMIN_PASSWORD is not configured", {
      status: 503,
      headers: supportAdminHeaders("text/plain; charset=UTF-8"),
    });
  }

  if (!supportDatabaseAvailable(env)) {
    return new Response("SUPPORT_DB is not configured", {
      status: 503,
      headers: supportAdminHeaders("text/plain; charset=UTF-8"),
    });
  }

  if (!adminCredentialsAreValid(request, env)) {
    return new Response("Authentication required", {
      status: 401,
      headers: {
        ...supportAdminHeaders("text/plain; charset=UTF-8"),
        "WWW-Authenticate": 'Basic realm="Sabor do Brasil Support", charset="UTF-8"',
      },
    });
  }

  try {
    await ensureSupportSchema(env);
  } catch {
    return supportJsonResponse({ error: "Support database is unavailable" }, 503);
  }

  if (url.pathname === "/support" && request.method === "GET") {
    return new Response(supportAdminPage(), {
      status: 200,
      headers: {
        ...supportAdminHeaders("text/html; charset=UTF-8"),
        "Content-Security-Policy":
          "default-src 'self'; style-src 'unsafe-inline'; " +
          "script-src 'unsafe-inline'; connect-src 'self'; " +
          "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
      },
    });
  }

  if (
    request.method === "POST" &&
    !mutationOriginIsValid(request)
  ) {
    return supportJsonResponse({ error: "Invalid request origin" }, 403);
  }

  if (
    url.pathname === "/support/api/conversations" &&
    request.method === "GET"
  ) {
    const conversations = await listSupportConversations(env);
    return supportJsonResponse({ conversations });
  }

  if (
    url.pathname === "/support/api/messages" &&
    request.method === "GET"
  ) {
    const phone = url.searchParams.get("phone") ?? "";

    if (!/^\d{8,15}$/.test(phone)) {
      return supportJsonResponse({ error: "Invalid phone" }, 400);
    }

    const messages = await listSupportMessages(phone, env);
    await markSupportConversationRead(phone, env);
    return supportJsonResponse({ messages });
  }

  if (
    url.pathname === "/support/api/reply" &&
    request.method === "POST"
  ) {
    let payload;

    try {
      payload = await readSupportRequestJson(request);
    } catch {
      return supportJsonResponse({ error: "Invalid JSON" }, 400);
    }

    const phone = String(payload?.phone ?? "");
    const body = String(payload?.body ?? "").trim();

    if (!/^\d{8,15}$/.test(phone)) {
      return supportJsonResponse({ error: "Invalid phone" }, 400);
    }

    if (!body || body.length > SUPPORT_MESSAGE_MAX_LENGTH) {
      return supportJsonResponse({ error: "Reply must contain 1 to 4096 characters" }, 400);
    }

    const conversation = await getActiveSupportConversation(phone, env);

    if (!conversation) {
      return supportJsonResponse({ error: "This conversation is no longer open" }, 409);
    }

    try {
      await sendAndStoreSupportText(phone, body, env);
      await markSupportConversationRead(phone, env);
    } catch (error) {
      console.error(`Human support reply failed: ${error.message}`);
      return supportJsonResponse(
        { error: "WhatsApp could not send this reply. Check the 24-hour service window." },
        502
      );
    }

    return supportJsonResponse({ ok: true });
  }

  if (
    url.pathname === "/support/api/close" &&
    request.method === "POST"
  ) {
    let payload;

    try {
      payload = await readSupportRequestJson(request);
    } catch {
      return supportJsonResponse({ error: "Invalid JSON" }, 400);
    }

    const phone = String(payload?.phone ?? "");

    if (!/^\d{8,15}$/.test(phone)) {
      return supportJsonResponse({ error: "Invalid phone" }, 400);
    }

    const conversation = await getActiveSupportConversation(phone, env);

    if (!conversation) {
      return supportJsonResponse(
        { error: "This conversation is no longer open" },
        409
      );
    }

    try {
      await sendAndStoreSupportText(
        phone,
        "Human support has ended. The automated assistant is active " +
          "again.\n\nO atendimento humano foi encerrado. O assistente " +
          "automático está ativo novamente.",
        env
      );
    } catch (error) {
      console.error(`Human support closing message failed: ${error.message}`);
      return supportJsonResponse(
        {
          error:
            "WhatsApp could not close this conversation. Check the " +
            "24-hour service window.",
        },
        502
      );
    }

    await closeSupportConversation(phone, env);

    let menuSent = true;

    try {
      await sendWhatsAppMenu(phone, env);
    } catch (error) {
      menuSent = false;
      console.error(`Return-to-bot menu failed: ${error.message}`);
    }

    return supportJsonResponse({ ok: true, menu_sent: menuSent });
  }

  return supportJsonResponse({ error: "Not found" }, 404);
}

function extractIncomingMessageValue(message) {
  if (message?.type === "text") {
    return message.text?.body?.trim() ?? "";
  }

  if (message?.type === "interactive") {
    return (
      message.interactive?.button_reply?.id ??
      message.interactive?.list_reply?.id ??
      ""
    );
  }

  if (message?.type === "button") {
    return message.button?.payload ?? message.button?.text ?? "";
  }

  return "";
}

function parseAmountToMinorUnits(value) {
  const normalized = value.replace(",", ".");

  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(normalized)) {
    return null;
  }

  const [wholePart, decimalPart = ""] = normalized.split(".");
  const whole = Number(wholePart);
  const decimals = Number(decimalPart.padEnd(2, "0"));

  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(decimals)) {
    return null;
  }

  const total = whole * 100 + decimals;

  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

function normalizeTrackingCode(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizePhoneNumber(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function phoneNumbersMatch(first, second) {
  const normalizedFirst = normalizePhoneNumber(first);
  const normalizedSecond = normalizePhoneNumber(second);

  if (!normalizedFirst || !normalizedSecond) {
    return false;
  }

  if (normalizedFirst === normalizedSecond) {
    return true;
  }

  if (normalizedFirst.length >= 10 && normalizedSecond.length >= 10) {
    return normalizedFirst.slice(-10) === normalizedSecond.slice(-10);
  }

  return false;
}

function getPrimaryFulfillment(order) {
  const fulfillments = order?.fulfillments ?? [];

  return (
    fulfillments.find(
      (candidate) =>
        candidate.state !== "CANCELED" &&
        candidate.state !== "FAILED"
    ) ??
    fulfillments[0] ??
    null
  );
}

function getOrderRecipient(order) {
  const fulfillment = getPrimaryFulfillment(order);

  return (
    fulfillment?.delivery_details?.recipient ??
    fulfillment?.pickup_details?.recipient ??
    fulfillment?.shipment_details?.recipient ??
    fulfillment?.in_store_details?.recipient ??
    null
  );
}

async function resolveOrderRecipient(order, env) {
  const fulfillmentRecipient = getOrderRecipient(order);

  if (
    /^\d{8,15}$/.test(
      normalizePhoneNumber(fulfillmentRecipient?.phone_number)
    )
  ) {
    return {
      recipient: fulfillmentRecipient,
      source: "fulfillment",
    };
  }

  if (!order?.customer_id) {
    return {
      recipient: fulfillmentRecipient,
      source: "missing",
    };
  }

  try {
    const customerResponse = await squareApiRequest(
      `/v2/customers/${encodeURIComponent(order.customer_id)}`,
      env
    );
    const customer = customerResponse.customer;

    if (
      /^\d{8,15}$/.test(normalizePhoneNumber(customer?.phone_number))
    ) {
      return {
        recipient: {
          display_name:
            [customer?.given_name, customer?.family_name]
              .filter(Boolean)
              .join(" ") || fulfillmentRecipient?.display_name || null,
          phone_number: customer.phone_number,
        },
        source: "customer_profile",
      };
    }
  } catch (error) {
    console.warn(`Square customer lookup failed: ${error.message}`);
  }

  return {
    recipient: fulfillmentRecipient,
    source: "missing",
  };
}

async function findSquareCustomerIdsByPhoneNumber(phoneNumber, env) {
  const normalizedPhone = normalizePhoneNumber(phoneNumber);

  if (!/^\d{8,15}$/.test(normalizedPhone)) {
    return new Set();
  }

  const customerIds = new Set();
  const searches = [
    { exact: `+${normalizedPhone}` },
    { exact: normalizedPhone },
    { fuzzy: normalizedPhone.slice(-10) },
  ];

  for (const phoneFilter of searches) {
    try {
      const response = await squareApiRequest(
        "/v2/customers/search",
        env,
        {
          method: "POST",
          body: {
            limit: 100,
            query: {
              filter: {
                phone_number: phoneFilter,
              },
            },
          },
        }
      );

      for (const customer of response.customers ?? []) {
        if (
          customer.id &&
          phoneNumbersMatch(customer.phone_number, normalizedPhone)
        ) {
          customerIds.add(customer.id);
        }
      }

      if (customerIds.size > 0) {
        break;
      }
    } catch (error) {
      console.warn(`Square customer phone search failed: ${error.message}`);
    }
  }

  return customerIds;
}

function orderMatchesCustomerIds(order, customerIds) {
  if (!customerIds.size) {
    return false;
  }

  if (order?.customer_id && customerIds.has(order.customer_id)) {
    return true;
  }

  return (order?.tenders ?? []).some(
    (tender) =>
      tender?.customer_id && customerIds.has(tender.customer_id)
  );
}

function parseTrackingLookup(value) {
  const match = value
    .trim()
    .match(
      /^#?([a-z0-9][a-z0-9-]{3,59})(?:\s+(?:CAD\s*)?\$?\s*(\d{1,7}(?:[.,]\d{1,2})?))?$/i
    );

  if (!match) {
    return null;
  }

  if (!/\d/.test(match[1]) && match[2] === undefined) {
    return null;
  }

  const totalMinorUnits =
    match[2] === undefined ? null : parseAmountToMinorUnits(match[2]);

  if (match[2] !== undefined && totalMinorUnits === null) {
    return null;
  }

  return {
    code: normalizeTrackingCode(match[1]),
    totalMinorUnits,
  };
}

async function listRecentOrders(env, customerIds = []) {
  const startAt = new Date(
    Date.now() - PAYMENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const orders = [];
  let cursor;

  for (let page = 0; page < MAX_ORDER_PAGES; page += 1) {
    const requestBody = {
      limit: 100,
      query: {
        filter: {
          date_time_filter: {
            created_at: {
              start_at: startAt,
            },
          },
        },
        sort: {
          sort_field: "CREATED_AT",
          sort_order: "DESC",
        },
      },
    };

    if (env.SQUARE_LOCATION_ID) {
      requestBody.location_ids = [env.SQUARE_LOCATION_ID];
    }

    if (customerIds.length > 0) {
      requestBody.query.filter.customer_filter = {
        customer_ids: customerIds.slice(0, 10),
      };
    }

    if (cursor) {
      requestBody.cursor = cursor;
    }

    const response = await squareApiRequest(
      "/v2/orders/search",
      env,
      {
        method: "POST",
        body: requestBody,
      }
    );

    orders.push(...(response.orders ?? []));
    cursor = response.cursor;

    if (!cursor) {
      break;
    }
  }

  return orders;
}

async function findRecentPaymentsByLookup(
  lookupCode,
  totalMinorUnits,
  env
) {
  const beginTime = new Date(
    Date.now() - PAYMENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const matches = [];
  let cursor;

  for (let page = 0; page < MAX_PAYMENT_PAGES; page += 1) {
    const query = new URLSearchParams({
      begin_time: beginTime,
      sort_order: "DESC",
      limit: "100",
    });

    if (totalMinorUnits !== null && totalMinorUnits > 0) {
      query.set("total", String(totalMinorUnits));
    }

    if (env.SQUARE_LOCATION_ID) {
      query.set("location_id", env.SQUARE_LOCATION_ID);
    }

    if (cursor) {
      query.set("cursor", cursor);
    }

    const response = await squareApiRequest(
      `/v2/payments?${query.toString()}`,
      env
    );

    matches.push(
      ...(response.payments ?? []).filter(
        (candidate) => {
          if (
            candidate.status !== "COMPLETED" ||
            !candidate.order_id
          ) {
            return false;
          }

          const candidateCodes = [
            candidate.receipt_number,
            candidate.reference_id,
            candidate.id,
            candidate.order_id,
          ].map(normalizeTrackingCode);

          return candidateCodes.includes(lookupCode);
        }
      )
    );

    cursor = response.cursor;

    if (!cursor) {
      break;
    }
  }

  return matches;
}

function isActiveOrder(order) {
  const fulfillment = getPrimaryFulfillment(order);

  if (fulfillment) {
    return !["COMPLETED", "CANCELED", "FAILED"].includes(
      fulfillment.state
    );
  }

  return !["COMPLETED", "CANCELED"].includes(order?.state);
}

async function findOrderByWhatsAppNumber(phoneNumber, env) {
  const orders = await listRecentOrders(env);
  const matchingOrdersById = new Map();

  const rememberedOrderIds = await findRememberedOrderIdsByPhone(
    phoneNumber,
    env
  );

  for (const orderId of rememberedOrderIds) {
    try {
      const response = await squareApiRequest(
        `/v2/orders/${encodeURIComponent(orderId)}`,
        env
      );

      if (response.order) {
        matchingOrdersById.set(response.order.id, response.order);
      }
    } catch (error) {
      console.warn(
        `Remembered Square order lookup failed: ${error.message}`
      );
    }
  }

  for (const order of orders) {
    if (
      phoneNumbersMatch(
        getOrderRecipient(order)?.phone_number,
        phoneNumber
      )
    ) {
      matchingOrdersById.set(order.id, order);
    }
  }

  const customerIds = await findSquareCustomerIdsByPhoneNumber(
    phoneNumber,
    env
  );

  if (customerIds.size > 0) {
    const customerOrders = await listRecentOrders(
      env,
      [...customerIds]
    );

    for (const order of customerOrders) {
      matchingOrdersById.set(order.id, order);
    }
  }

  for (const order of orders) {
    if (orderMatchesCustomerIds(order, customerIds)) {
      matchingOrdersById.set(order.id, order);
    }
  }

  const matchingOrders = [...matchingOrdersById.values()];

  const activeOrders = matchingOrders.filter(isActiveOrder);

  if (activeOrders.length === 1) {
    return {
      result: "found",
      order: activeOrders[0],
    };
  }

  if (activeOrders.length > 1) {
    return {
      result: "needs_code",
    };
  }

  if (matchingOrders.length === 1) {
    return {
      result: "found",
      order: matchingOrders[0],
    };
  }

  return {
    result: matchingOrders.length > 1 ? "needs_code" : "not_found",
  };
}

async function resolveOrderByTrackingLookup(lookup, phoneNumber, env) {
  const recordsByOrderId = new Map();
  const recentOrders = await listRecentOrders(env);

  for (const order of recentOrders) {
    const orderCodes = [
      order.ticket_name,
      order.reference_id,
      order.id,
      ...Object.values(order.metadata ?? {}),
    ].map(normalizeTrackingCode);

    if (orderCodes.includes(lookup.code)) {
      recordsByOrderId.set(order.id, {
        order,
        payment: null,
      });
    }
  }

  const payments = await findRecentPaymentsByLookup(
    lookup.code,
    lookup.totalMinorUnits,
    env
  );

  for (const payment of payments) {
    if (recordsByOrderId.has(payment.order_id)) {
      recordsByOrderId.get(payment.order_id).payment = payment;
      continue;
    }

    const orderResponse = await squareApiRequest(
      `/v2/orders/${encodeURIComponent(payment.order_id)}`,
      env
    );

    if (orderResponse.order) {
      recordsByOrderId.set(payment.order_id, {
        order: orderResponse.order,
        payment,
      });
    }
  }

  let records = [...recordsByOrderId.values()];

  if (lookup.totalMinorUnits !== null) {
    records = records.filter(({ order, payment }) => {
      const amount =
        payment?.total_money?.amount ?? order?.total_money?.amount;

      return amount === lookup.totalMinorUnits;
    });
  }

  const phoneVerifiedRecords = [];

  for (const record of records) {
    const recipientResolution = await resolveOrderRecipient(
      record.order,
      env
    );

    if (
      phoneNumbersMatch(
        recipientResolution.recipient?.phone_number,
        phoneNumber
      )
    ) {
      phoneVerifiedRecords.push(record);
    }
  }

  if (phoneVerifiedRecords.length === 1) {
    return {
      result: "found",
      order: phoneVerifiedRecords[0].order,
    };
  }

  if (phoneVerifiedRecords.length > 1) {
    return {
      result: "needs_total",
    };
  }

  const recordsWithoutPhone = [];

  for (const record of records) {
    const recipientResolution = await resolveOrderRecipient(
      record.order,
      env
    );

    if (!recipientResolution.recipient?.phone_number) {
      recordsWithoutPhone.push(record);
    }
  }

  if (
    recordsWithoutPhone.length === 1 &&
    (lookup.totalMinorUnits !== null || lookup.code.length >= 8)
  ) {
    return {
      result: "found",
      order: recordsWithoutPhone[0].order,
    };
  }

  if (
    recordsWithoutPhone.length > 0 &&
    lookup.totalMinorUnits === null
  ) {
    return {
      result: "needs_total",
    };
  }

  return {
    result: "not_found",
  };
}

function describeOrderStatus(order) {
  const fulfillment = getPrimaryFulfillment(order);

  if (fulfillment) {
    const state = fulfillment.state ?? "UNKNOWN";
    const type = fulfillment.type ?? "UNKNOWN";

    const messages = {
      PROPOSED: {
        en: "Order received",
        pt: "Pedido recebido",
      },
      RESERVED: {
        en: "Being prepared",
        pt: "Em preparo",
      },
      PREPARED: {
        en:
          type === "DELIVERY"
            ? "Ready for delivery"
            : type === "PICKUP"
              ? "Ready for pickup"
              : "Ready",
        pt:
          type === "DELIVERY"
            ? "Pronto para entrega"
            : type === "PICKUP"
              ? "Pronto para retirada"
              : "Pronto",
      },
      COMPLETED: {
        en: type === "DELIVERY" ? "Delivered" : "Completed",
        pt: type === "DELIVERY" ? "Entregue" : "Concluído",
      },
      CANCELED: {
        en: "Canceled",
        pt: "Cancelado",
      },
      FAILED: {
        en: "Needs assistance",
        pt: "Precisa de atendimento",
      },
    };

    return (
      messages[state] ?? {
        en: "Status unavailable",
        pt: "Status indisponível",
      }
    );
  }

  const orderMessages = {
    OPEN: {
      en: "Order received and processing",
      pt: "Pedido recebido e em processamento",
    },
    COMPLETED: {
      en: "Payment confirmed",
      pt: "Pagamento confirmado",
    },
    CANCELED: {
      en: "Canceled",
      pt: "Cancelado",
    },
  };

  return (
    orderMessages[order.state] ?? {
      en: "Status unavailable",
      pt: "Status indisponível",
    }
  );
}

function formatEstimatedTime(order, env) {
  const fulfillment = getPrimaryFulfillment(order);
  const scheduledAt =
    fulfillment?.delivery_details?.deliver_at ??
    fulfillment?.pickup_details?.pickup_at ??
    null;

  if (!scheduledAt) {
    return null;
  }

  const date = new Date(scheduledAt);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: env.BUSINESS_TIME_ZONE ?? DEFAULT_TIME_ZONE,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  } catch {
    return null;
  }
}

function buildOrderStatusMessage(order, suppliedCode, env) {
  const status = describeOrderStatus(order);
  const estimatedTime = formatEstimatedTime(order, env);
  const displayCode =
    order.ticket_name?.trim() || suppliedCode?.trim() || null;

  const lines = [];

  if (displayCode) {
    lines.push(`Order / Pedido: *${displayCode}*`, "");
  }

  lines.push(
    `Status: *${status.en}*`,
    `Status: *${status.pt}*`
  );

  if (estimatedTime) {
    lines.push(
      "",
      `Estimated time / Horário estimado: *${estimatedTime}*`
    );
  }

  lines.push(
    "",
    "Reply TRACK to check again or MENU to view the menu.",
    "Responda TRACK para consultar novamente ou MENU para ver o cardápio."
  );

  return lines.join("\n");
}

function getInformationResponse(command, originalValue, env) {
  const value = originalValue.toLowerCase();

  if (
    command === "DELIVERY_INFO" ||
    /\b(delivery|deliver|entrega|entregar|radius|raio)\b/i.test(value)
  ) {
    return (
      env.DELIVERY_INFO ??
      "We offer free local delivery within up to 3 km, where available. " +
        "Enter your address at checkout to confirm availability.\n\n" +
        "Oferecemos entrega local gratuita em um raio de até 3 km, " +
        "quando disponível. Informe o endereço no checkout para confirmar."
    );
  }

  if (
    command === "HOURS_INFO" ||
    /\b(hours?|open|opening|close|hor[aá]rio|aberto|fecha)\b/i.test(
      value
    )
  ) {
    return (
      env.BUSINESS_HOURS ??
      "Current ordering availability and the next available delivery time " +
        "are always shown on our online menu.\n\n" +
        "A disponibilidade atual e o próximo horário de entrega aparecem " +
        "sempre no nosso cardápio online."
    );
  }

  if (
    command === "ALLERGEN_INFO" ||
    /\b(allerg|allergy|allergies|alerg|gluten|lactose|dairy|nuts?)\b/i.test(
      value
    )
  ) {
    return (
      env.ALLERGEN_INFO ??
      "Please tell us about any food allergy before ordering. Our kitchen " +
        "handles common allergens, so we cannot guarantee zero cross-contact." +
        "\n\nInforme qualquer alergia alimentar antes de pedir. Nossa cozinha " +
        "manuseia alérgenos comuns e não pode garantir ausência de contato cruzado."
    );
  }

  if (
    command === "PAYMENT_INFO" ||
    /\b(payment|pay|card|credit|debit|pagamento|pagar|cart[aã]o)\b/i.test(
      value
    )
  ) {
    return (
      env.PAYMENT_INFO ??
      "Online payments are processed securely by Square. We will never ask " +
        "for your complete card number or security code in WhatsApp.\n\n" +
        "Os pagamentos online são processados com segurança pelo Square. " +
        "Nunca pediremos o número completo ou o código de segurança do cartão."
    );
  }

  return null;
}

async function hasProcessedWhatsAppMessage(messageId) {
  if (!messageId) {
    return false;
  }

  const cacheKey = new Request(
    `https://dedupe.sabor-do-brasil.invalid/whatsapp/${encodeURIComponent(
      messageId
    )}`
  );

  try {
    return Boolean(await caches.default.match(cacheKey));
  } catch {
    console.warn("WhatsApp deduplication cache is unavailable");
    return false;
  }
}

async function markWhatsAppMessageProcessed(messageId) {
  if (!messageId) {
    return;
  }

  const cacheKey = new Request(
    `https://dedupe.sabor-do-brasil.invalid/whatsapp/${encodeURIComponent(
      messageId
    )}`
  );

  try {
    await caches.default.put(
      cacheKey,
      new Response("processed", {
        headers: {
          "Cache-Control": "public, max-age=86400",
        },
      })
    );
  } catch {
    console.warn("WhatsApp message could not be cached for deduplication");
  }
}

async function handleIncomingWhatsAppMessage(message, env) {
  const recipient = message?.from;

  if (!recipient) {
    return;
  }

  const value = extractIncomingMessageValue(message);
  const command = value.trim().toUpperCase();
  const displayName = message?._contactName ?? null;

  const directOrderUpdateOptIn =
    ["ENABLE_UPDATES", "START_UPDATES"].includes(command) ||
    (/(receive|get)\s+(automatic\s+)?order updates/i.test(value) &&
      /sabor do brasil/i.test(value));

  if (directOrderUpdateOptIn) {
    if (!supportDatabaseAvailable(env)) {
      await sendWhatsAppText(
        recipient,
        "Order updates are temporarily unavailable. Please try again later.\n\n" +
          "As atualizações de pedidos estão temporariamente indisponíveis. " +
          "Tente novamente mais tarde.",
        env
      );
      return;
    }

    await setOrderUpdateConsent(
      recipient,
      true,
      "whatsapp_explicit_opt_in",
      message.id ?? null,
      env
    );
    await sendWhatsAppText(
      recipient,
      "Order updates are enabled. Use this same phone number at Square " +
        "checkout. We will notify you after payment is confirmed. Send STOP " +
        "at any time to disable updates.\n\n" +
        "As atualizações de pedidos estão ativadas. Use este mesmo número " +
        "no checkout do Square. Avisaremos quando o pagamento for confirmado. " +
        "Envie STOP a qualquer momento para desativar.",
      env
    );
    await sendWhatsAppMenu(recipient, env);
    return;
  }

  if (["STOP", "STOP_UPDATES", "UNSUBSCRIBE"].includes(command)) {
    if (supportDatabaseAvailable(env)) {
      await setOrderUpdateConsent(
        recipient,
        false,
        "whatsapp_opt_out",
        message.id ?? null,
        env
      );
      await closeSupportConversation(recipient, env);
    }

    await sendWhatsAppText(
      recipient,
      "Automatic WhatsApp order updates have been disabled. You can enable " +
        "them again from the menu.\n\nAs atualizações automáticas de pedidos " +
        "foram desativadas. Você pode ativá-las novamente pelo menu.",
      env
    );
    return;
  }

  if (command === "ORDER_UPDATES") {
    await sendWhatsAppOrderUpdatesPrompt(recipient, env);
    return;
  }

  if (command === "NO_UPDATES") {
    await sendWhatsAppText(
      recipient,
      "No changes were made. / Nenhuma alteração foi realizada.",
      env
    );
    await sendWhatsAppMenu(recipient, env);
    return;
  }

  if (
    ["BOT", "ROBOT", "AUTOMATION", "VOLTAR", "RETURN TO BOT"].includes(
      command
    )
  ) {
    await closeSupportConversation(recipient, env);
    await sendWhatsAppMenu(recipient, env);
    return;
  }

  let activeSupportConversation = null;

  try {
    activeSupportConversation = await getActiveSupportConversation(
      recipient,
      env
    );
  } catch (error) {
    console.error(`Support state lookup failed: ${error.message}`);
  }

  if (activeSupportConversation) {
    try {
      await storeSupportMessage(
        {
          phone: recipient,
          direction: "IN",
          body: extractIncomingSupportText(message),
          messageType: message.type ?? "unknown",
          externalId: message.id ?? null,
          displayName,
        },
        env
      );
    } catch (error) {
      console.error(`Human support message storage failed: ${error.message}`);
    }

    return;
  }

  const wantsTracking =
    ["TRACK", "TRACK_ORDER", "STATUS", "RASTREAR", "ACOMPANHAR"].includes(
      command
    ) ||
    /\b(track|tracking|order status|rastrear|acompanhar|status do pedido)\b/i.test(
      value
    );

  if (wantsTracking) {
    const automaticLookup = await findOrderByWhatsAppNumber(
      recipient,
      env
    );

    if (automaticLookup.result === "found") {
      await sendWhatsAppText(
        recipient,
        buildOrderStatusMessage(automaticLookup.order, null, env),
        env
      );
      return;
    }

    await sendWhatsAppText(
      recipient,
      "We couldn't link this WhatsApp number to exactly one recent order. " +
        "Send the 4-character Square receipt code followed by the order " +
        "total, for example: *F0Tl 17.00*\n\n" +
        "Não conseguimos vincular este WhatsApp a um único pedido recente. " +
        "Envie o código de 4 caracteres do recibo Square seguido do total, " +
        "por exemplo: *F0Tl 17.00*\n\n" +
        "The longer number beginning with # shown by Square Online is not " +
        "available through its public API. / O número longo iniciado por # " +
        "não é disponibilizado pela API pública do Square.\n\n" +
        "Never send card details. / Nunca envie dados do cartão.",
      env
    );
    return;
  }

  if (
    command === "MENU" ||
    command === "VIEW_MENU" ||
    command === "CARDAPIO" ||
    command === "CARDÁPIO"
  ) {
    await sendWhatsAppText(
      recipient,
      `View our menu / Veja nosso cardápio:\n${
        env.MENU_URL ?? DEFAULT_MENU_URL
      }`,
      env,
      true
    );
    return;
  }

  const informationResponse = getInformationResponse(
    command,
    value,
    env
  );

  if (informationResponse) {
    await sendWhatsAppText(recipient, informationResponse, env);
    return;
  }

  if (
    command === "HUMAN" ||
    command === "HELP" ||
    command === "AJUDA" ||
    command === "HUMAN_HELP"
  ) {
    if (!supportDatabaseAvailable(env)) {
      await sendWhatsAppText(
        recipient,
        "Human support is temporarily unavailable. Please try again later.\n\n" +
          "O atendimento humano está temporariamente indisponível. " +
          "Tente novamente mais tarde.",
        env
      );
      return;
    }

    try {
      await openSupportConversation(recipient, displayName, env);
      await storeSupportMessage(
        {
          phone: recipient,
          direction: "IN",
          body: extractIncomingSupportText(message),
          messageType: message.type ?? "interactive",
          externalId: message.id ?? null,
          displayName,
        },
        env
      );

      await sendAndStoreSupportText(
        recipient,
        "Human support is now active. Send your question here in text and " +
          "a team member will reply during business hours. To return to " +
          "the automated menu, send *BOT*.\n\n" +
          "O atendimento humano está ativo. Envie sua dúvida por texto e " +
          "uma pessoa da equipe responderá durante o horário de atendimento. " +
          "Para voltar ao menu automático, envie *BOT*.",
        env
      );
    } catch (error) {
      console.error(`Human support activation failed: ${error.message}`);
      await sendWhatsAppText(
        recipient,
        "We couldn't start human support right now. Please try again shortly.\n\n" +
          "Não foi possível iniciar o atendimento humano agora. " +
          "Tente novamente em instantes.",
        env
      );
    }

    return;
  }

  if (
    ["HI", "HELLO", "HEY", "OI", "OLÁ", "OLA", "START", "INÍCIO"].includes(
      command
    )
  ) {
    await sendWhatsAppMenu(recipient, env);
    return;
  }

  const lookup = parseTrackingLookup(value);

  if (lookup) {
    const resolution = await resolveOrderByTrackingLookup(
      lookup,
      recipient,
      env
    );

    if (resolution.result === "found") {
      await sendWhatsAppText(
        recipient,
        buildOrderStatusMessage(
          resolution.order,
          lookup.code,
          env
        ),
        env
      );
      return;
    }

    if (resolution.result === "needs_total") {
      await sendWhatsAppText(
        recipient,
        `To confirm receipt *${lookup.code}*, send it again followed by ` +
          `the order total.\n\nExample: *${lookup.code} 17.00*\n\n` +
          `Para confirmar o recibo *${lookup.code}*, envie novamente ` +
          `seguido do total do pedido.\n\nExemplo: *${lookup.code} 17.00*`,
        env
      );
      return;
    }

    await sendWhatsAppText(
      recipient,
      "We couldn't confirm that receipt among payments from the last 7 days. " +
        "Use the 4-character receipt code and total, then try again. A very " +
        "recent payment can take a few seconds to appear.\n\nNão conseguimos " +
        "confirmar esse recibo nos pagamentos dos últimos 7 dias. Use o " +
        "código de 4 caracteres e o total e tente novamente.",
      env
    );
    return;
  }

  await sendWhatsAppMenu(recipient, env);
}

async function processWhatsAppWebhook(payload, env) {
  const messages = [];
  const deliveryStatuses = [];

  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      const webhookPhoneNumberId =
        value?.metadata?.phone_number_id ?? null;
      const contactNames = new Map(
        (value?.contacts ?? []).map((contact) => [
          String(contact?.wa_id ?? ""),
          contact?.profile?.name ?? null,
        ])
      );

      for (const message of value?.messages ?? []) {
        messages.push({
          ...message,
          _contactName:
            contactNames.get(String(message?.from ?? "")) ?? null,
        });
      }

      for (const status of value?.statuses ?? []) {
        deliveryStatuses.push({
          status,
          webhookPhoneNumberId,
        });
      }
    }
  }

  for (const { status, webhookPhoneNumberId } of deliveryStatuses) {
    const primaryError = status?.errors?.[0] ?? null;
    const errorDetails =
      primaryError?.error_data?.details ??
      primaryError?.message ??
      null;

    console.log(
      JSON.stringify({
        source: "whatsapp-delivery",
        status: status?.status ?? "unknown",
        configured_phone_matches:
          webhookPhoneNumberId === null
            ? null
            : String(webhookPhoneNumberId) ===
              String(env.META_PHONE_NUMBER_ID ?? ""),
        error_code: primaryError?.code ?? null,
        error_title: primaryError?.title ?? null,
        error_details:
          typeof errorDetails === "string"
            ? errorDetails.slice(0, 300)
            : null,
      })
    );

    try {
      await updateOrderNotificationDeliveryStatus(
        status?.id ?? null,
        status?.status ?? "unknown",
        primaryError?.code ?? null,
        env
      );
    } catch (error) {
      console.error(
        `Order notification status update failed: ${error.message}`
      );
    }
  }

  for (const message of messages) {
    if (await hasProcessedWhatsAppMessage(message.id)) {
      continue;
    }

    await handleIncomingWhatsAppMessage(message, env);
    await markWhatsAppMessageProcessed(message.id);

    console.log(
      JSON.stringify({
        source: "whatsapp",
        message_type: message.type ?? "unknown",
        processed: true,
      })
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const textResponse = (body, status = 200) =>
      new Response(body, {
        status,
        headers: {
          "Content-Type": "text/plain; charset=UTF-8",
          "Cache-Control": "no-store",
        },
      });

    if (
      url.pathname === "/support" ||
      url.pathname.startsWith("/support/")
    ) {
      return handleSupportAdminRequest(request, env, url);
    }

    if (url.pathname === "/") {
      return textResponse(
        `Sabor do Brasil automation online | ${BUILD_VERSION}`
      );
    }

    if (url.pathname === "/webhooks/whatsapp") {
      if (request.method === "GET") {
        const mode = url.searchParams.get("hub.mode");
        const receivedToken = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");

        if (
          mode === "subscribe" &&
          receivedToken === env.META_VERIFY_TOKEN &&
          challenge
        ) {
          return textResponse(challenge);
        }

        return textResponse("Verification failed", 403);
      }

      if (request.method === "POST") {
        if (!env.META_APP_SECRET) {
          console.error("META_APP_SECRET is missing");
          return textResponse("WhatsApp webhook is not configured", 500);
        }

        const rawBody = await request.text();
        const signature = request.headers.get("x-hub-signature-256");

        let validSignature = false;

        try {
          validSignature = await verifyMetaWebhook(
            signature,
            rawBody,
            env.META_APP_SECRET
          );
        } catch {
          console.error("Meta signature validation error");
          return textResponse("Validation error", 500);
        }

        if (!validSignature) {
          console.warn("Rejected WhatsApp webhook");
          return textResponse("Invalid Meta signature", 403);
        }

        let payload;

        try {
          payload = JSON.parse(rawBody);
        } catch {
          return textResponse("Invalid JSON", 400);
        }

        ctx.waitUntil(
          processWhatsAppWebhook(payload, env).catch((error) => {
            console.error(
              `WhatsApp event processing failed: ${error.message}`
            );
          })
        );

        return textResponse("EVENT_RECEIVED", 200);
      }

      return textResponse("Method not allowed", 405);
    }

    if (url.pathname === "/webhooks/square") {
      if (request.method === "GET") {
        return textResponse("Square webhook endpoint online");
      }

      if (request.method === "HEAD") {
        return new Response(null, { status: 200 });
      }

      if (request.method === "POST") {
        if (
          !env.SQUARE_WEBHOOK_SIGNATURE_KEY ||
          !env.SQUARE_WEBHOOK_URL
        ) {
          console.error("Square webhook variables are missing");

          return textResponse("Square webhook is not configured", 500);
        }

        const rawBody = await request.text();
        const signature = request.headers.get(
          "x-square-hmacsha256-signature"
        );

        let validSignature = false;

        try {
          validSignature = await verifySquareWebhook(
            signature,
            rawBody,
            env.SQUARE_WEBHOOK_URL,
            env.SQUARE_WEBHOOK_SIGNATURE_KEY
          );
        } catch {
          console.error("Square signature validation error");
          return textResponse("Validation error", 500);
        }

        if (!validSignature) {
          console.warn("Rejected Square webhook");
          return textResponse("Invalid Square signature", 403);
        }

        let event;

        try {
          event = JSON.parse(rawBody);
        } catch {
          return textResponse("Invalid JSON", 400);
        }

        console.log(
          JSON.stringify({
            source: "square",
            environment:
              request.headers.get("square-environment") ?? "unknown",
            type: event.type ?? "unknown",
            event_id: event.event_id ?? "unknown",
          })
        );

        ctx.waitUntil(
          processSquareWebhookEvent(event, env).catch((error) => {
            console.error(
              `Square event processing failed: ${error.message}`
            );
          })
        );

        return textResponse("OK", 200);
      }

      return textResponse("Method not allowed", 405);
    }

    return textResponse("Not found", 404);
  },
};
