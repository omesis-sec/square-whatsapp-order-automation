import { createHmac, webcrypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/worker.mjs";

globalThis.crypto ??= webcrypto;

const cacheEntries = new Map();

globalThis.caches = {
  default: {
    async match(request) {
      return cacheEntries.has(request.url)
        ? new Response(cacheEntries.get(request.url))
        : undefined;
    },
    async put(request, response) {
      cacheEntries.set(request.url, await response.text());
    },
  },
};

class D1StatementMock {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new D1StatementMock(this.database, this.sql, values);
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes ?? 0) } };
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return {
      results: this.database.prepare(this.sql).all(...this.values),
    };
  }
}

class D1DatabaseMock {
  constructor() {
    this.database = new DatabaseSync(":memory:");
  }

  prepare(sql) {
    return new D1StatementMock(this.database, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) {
      results.push(await statement.run());
    }
    return results;
  }
}

const graphPayloads = [];
const order = {
  id: "production-order-1001",
  ticket_name: "1001",
  state: "OPEN",
  total_money: { amount: 1700, currency: "CAD" },
  fulfillments: [
    {
      type: "DELIVERY",
      state: "PROPOSED",
      delivery_details: {
        recipient: {
          display_name: "Canadian Customer",
          phone_number: "+1 (416) 555-0123",
        },
      },
    },
  ],
};

const customerProfileOrder = {
  id: "production-order-2002",
  ticket_name: "2002",
  customer_id: "customer-2002",
  state: "OPEN",
  total_money: { amount: 2200, currency: "CAD" },
  fulfillments: [],
};

const orders = new Map([
  [order.id, order],
  [customerProfileOrder.id, customerProfileOrder],
]);

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;

  if (url.includes("graph.facebook.com")) {
    const body = JSON.parse(init.body);
    graphPayloads.push(body);
    return Response.json({
      messages: [{ id: `wamid.outgoing-${graphPayloads.length}` }],
    });
  }

  const orderMatch = url.match(/\/v2\/orders\/([^/?]+)$/);
  if (orderMatch && orders.has(orderMatch[1])) {
    return Response.json({ order: orders.get(orderMatch[1]) });
  }

  if (url.endsWith("/v2/customers/customer-2002")) {
    return Response.json({
      customer: {
        id: "customer-2002",
        given_name: "Square",
        family_name: "Customer",
        phone_number: "+1 (647) 555-0198",
      },
    });
  }

  return Response.json({ error: "Unexpected URL" }, { status: 500 });
};

const env = {
  META_APP_SECRET: "test-app-secret",
  META_ACCESS_TOKEN: "test-access-token",
  META_PHONE_NUMBER_ID: "test-phone-number-id",
  META_ORDER_TEMPLATE_NAME: "order_received_update",
  META_ORDER_TEMPLATE_LANGUAGE: "en_US",
  AUTO_ORDER_UPDATES_ENABLED: "true",
  SQUARE_ACCESS_TOKEN: "test-square-token",
  SQUARE_API_BASE_URL: "https://square.test",
  SQUARE_API_VERSION: "2026-07-15",
  SQUARE_WEBHOOK_URL: "https://worker.test/webhooks/square",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "square-signature-key",
  SUPPORT_DB: new D1DatabaseMock(),
};

async function postWhatsApp(payloadObject) {
  const rawBody = JSON.stringify(payloadObject);
  const signature = createHmac("sha256", env.META_APP_SECRET)
    .update(rawBody)
    .digest("hex");
  const pending = [];
  const response = await worker.fetch(
    new Request("https://worker.test/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body: rawBody,
    }),
    env,
    {
      waitUntil(promise) {
        pending.push(promise);
      },
    }
  );

  if (response.status !== 200) {
    throw new Error(`Unexpected WhatsApp webhook status: ${response.status}`);
  }

  await Promise.all(pending);
}

async function sendIncomingText(id, body) {
  return postWhatsApp({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [
                {
                  wa_id: "14165550123",
                  profile: { name: "Canadian Customer" },
                },
              ],
              messages: [
                {
                  id,
                  from: "14165550123",
                  type: "text",
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function postSquareEvent(event) {
  const rawBody = JSON.stringify(event);
  const signature = createHmac("sha256", env.SQUARE_WEBHOOK_SIGNATURE_KEY)
    .update(env.SQUARE_WEBHOOK_URL + rawBody)
    .digest("base64");
  const pending = [];
  const response = await worker.fetch(
    new Request(env.SQUARE_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-square-hmacsha256-signature": signature,
      },
      body: rawBody,
    }),
    env,
    {
      waitUntil(promise) {
        pending.push(promise);
      },
    }
  );

  if (response.status !== 200) {
    throw new Error(`Unexpected Square webhook status: ${response.status}`);
  }

  await Promise.all(pending);
}

const squareEvent = {
  merchant_id: "merchant-test",
  type: "payment.updated",
  event_id: "event-payment-completed",
  data: {
    type: "payment",
    id: "payment-1001",
    object: {
      payment: {
        id: "payment-1001",
        status: "COMPLETED",
        order_id: "production-order-1001",
        receipt_number: "A1B2",
      },
    },
  },
};

await postSquareEvent(squareEvent);

const consent = await env.SUPPORT_DB.prepare(
  `SELECT status, source
   FROM whatsapp_order_update_consents
   WHERE phone = ?`
)
  .bind("14165550123")
  .first();

if (
  consent?.status !== "OPTED_IN" ||
  consent?.source !== "in_person_before_square_order"
) {
  throw new Error("In-person authorization was not recorded automatically");
}

const templatePayloads = graphPayloads.filter(
  (payload) => payload.type === "template"
);

if (templatePayloads.length !== 1) {
  throw new Error("Expected exactly one automatic order template");
}

const template = templatePayloads[0].template;
const bodyParameters = template.components[0].parameters.map(
  (parameter) => parameter.text
);

if (
  template.name !== "order_received_update" ||
  bodyParameters.join("|") !== "1001|Order received|$17.00" ||
  template.components[1].parameters[0].payload !== "TRACK_ORDER" ||
  template.components[2].parameters[0].payload !== "HELLO" ||
  template.components[3].parameters[0].payload !== "HUMAN_HELP"
) {
  throw new Error("Automatic order template payload is invalid");
}

await postSquareEvent(squareEvent);

if (
  graphPayloads.filter((payload) => payload.type === "template").length !== 1
) {
  throw new Error("Duplicate Square event sent a duplicate notification");
}

await postWhatsApp({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: "test-phone-number-id" },
            statuses: [
              {
                id: "wamid.outgoing-1",
                status: "delivered",
                recipient_id: "14165550123",
              },
            ],
          },
        },
      ],
    },
  ],
});

const notification = await env.SUPPORT_DB.prepare(
  `SELECT status FROM order_notifications WHERE order_id = ?`
)
  .bind("production-order-1001")
  .first();

if (notification?.status !== "DELIVERED") {
  throw new Error("WhatsApp delivery status was not stored");
}

await sendIncomingText("wamid.opt-out", "STOP");

const optedOut = await env.SUPPORT_DB.prepare(
  `SELECT status FROM whatsapp_order_update_consents WHERE phone = ?`
)
  .bind("14165550123")
  .first();

if (optedOut?.status !== "OPTED_OUT") {
  throw new Error("WhatsApp order-update opt-out was not stored");
}

const templateCountAfterOptOut = graphPayloads.filter(
  (payload) => payload.type === "template"
).length;

const orderAfterOptOut = {
  ...order,
  id: "production-order-1002",
  ticket_name: "1002",
};
orders.set(orderAfterOptOut.id, orderAfterOptOut);

await postSquareEvent({
  ...squareEvent,
  event_id: "event-after-opt-out",
  data: {
    ...squareEvent.data,
    id: "payment-1002",
    object: {
      payment: {
        id: "payment-1002",
        status: "COMPLETED",
        order_id: orderAfterOptOut.id,
        receipt_number: "C3D4",
      },
    },
  },
});

if (
  graphPayloads.filter((payload) => payload.type === "template").length !==
  templateCountAfterOptOut
) {
  throw new Error("An opted-out customer received another order notification");
}

await postSquareEvent({
  ...squareEvent,
  event_id: "event-customer-profile-fallback",
  data: {
    ...squareEvent.data,
    id: "payment-2002",
    object: {
      payment: {
        id: "payment-2002",
        status: "COMPLETED",
        order_id: customerProfileOrder.id,
        receipt_number: "E5F6",
      },
    },
  },
});

const fallbackTemplate = graphPayloads.filter(
  (payload) => payload.type === "template"
).at(-1);

if (
  fallbackTemplate?.to !== "16475550198" ||
  fallbackTemplate?.template?.components?.[0]?.parameters?.[0]?.text !== "2002"
) {
  throw new Error("Square Customer phone fallback did not send the template");
}

console.log("First-contact automatic order notification flow test passed");
