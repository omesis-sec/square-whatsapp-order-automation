import { createHmac } from "node:crypto";
import worker from "../src/worker.mjs";
import { installRuntimeGlobals } from "./helpers/runtime.mjs";

installRuntimeGlobals();

const requests = [];
let recentOrders = [];

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  requests.push({ url, init });

  if (url.includes("graph.facebook.com")) {
    return Response.json({ messages: [{ id: "wamid.test" }] });
  }

  if (url.endsWith("/v2/orders/search")) {
    return Response.json({ orders: recentOrders });
  }

  if (url.includes("/v2/payments?")) {
    return Response.json({
      payments: [
        {
          id: "payment-test",
          status: "COMPLETED",
          order_id: "order-test",
          receipt_number: "F0Tl",
          total_money: { amount: 100, currency: "CAD" },
        },
      ],
    });
  }

  if (url.endsWith("/v2/orders/order-test")) {
    return Response.json({
      order: {
        id: "order-test",
        state: "COMPLETED",
        total_money: { amount: 100, currency: "CAD" },
      },
    });
  }

  return Response.json({ error: "Unexpected URL" }, { status: 500 });
};

const env = {
  META_APP_SECRET: "test-app-secret",
  META_ACCESS_TOKEN: "test-access-token",
  META_PHONE_NUMBER_ID: "test-phone-number-id",
  SQUARE_ACCESS_TOKEN: "test-square-token",
  SQUARE_API_BASE_URL: "https://square.test",
  SQUARE_API_VERSION: "2026-07-15",
};

async function sendIncomingText(id, body) {
  const payload = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
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

  const signature = createHmac("sha256", env.META_APP_SECRET)
    .update(payload)
    .digest("hex");

  const pending = [];
  const response = await worker.fetch(
    new Request("https://worker.test/webhooks/whatsapp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body: payload,
    }),
    env,
    {
      waitUntil(promise) {
        pending.push(promise);
      },
    }
  );

  if (response.status !== 200) {
    throw new Error(`Unexpected webhook status: ${response.status}`);
  }

  await Promise.all(pending);
}

await sendIncomingText("wamid.incoming-1", "TRACK");
await sendIncomingText("wamid.incoming-2", "F0Tl 1.00");

recentOrders = [
  {
    id: "online-order-test",
    ticket_name: "104",
    state: "OPEN",
    total_money: { amount: 1700, currency: "CAD" },
    fulfillments: [
      {
        type: "DELIVERY",
        state: "RESERVED",
        delivery_details: {
          recipient: {
            phone_number: "+1 416 555 0123",
          },
        },
      },
    ],
  },
];

await sendIncomingText("wamid.incoming-3", "TRACK");
await sendIncomingText("wamid.incoming-4", "delivery");
await sendIncomingText("wamid.incoming-5", "hello");

const graphPayloads = requests
  .filter(({ url }) => url.includes("graph.facebook.com"))
  .map(({ init }) => JSON.parse(init.body));

if (graphPayloads.length !== 5) {
  throw new Error(`Expected 5 WhatsApp replies, got ${graphPayloads.length}`);
}

if (!graphPayloads[0].text.body.includes("F0Tl 17.00")) {
  throw new Error("TRACK prompt was not generated correctly");
}

if (!graphPayloads[1].text.body.includes("Payment confirmed")) {
  throw new Error("Order status response was not generated correctly");
}

if (!graphPayloads[2].text.body.includes("Being prepared")) {
  throw new Error("Automatic phone lookup did not return the order status");
}

if (!graphPayloads[3].text.body.includes("free local delivery")) {
  throw new Error("Delivery FAQ response was not generated correctly");
}

if (
  graphPayloads[4].type !== "interactive" ||
  graphPayloads[4].interactive.type !== "list" ||
  graphPayloads[4].interactive.action.sections[0].rows.length !== 8
) {
  throw new Error("Interactive customer service menu is invalid");
}

if (!requests.some(({ url }) => url.includes("/v2/payments?"))) {
  throw new Error("List Payments was not called");
}

if (!requests.some(({ url }) => url.endsWith("/v2/orders/order-test"))) {
  throw new Error("Retrieve Order was not called");
}

console.log("Worker flow test passed");
