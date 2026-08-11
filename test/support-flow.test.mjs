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

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;

  if (url.includes("graph.facebook.com")) {
    graphPayloads.push(JSON.parse(init.body));
    return Response.json({
      messages: [{ id: `wamid.outgoing-${graphPayloads.length}` }],
    });
  }

  return Response.json({ error: "Unexpected URL" }, { status: 500 });
};

const env = {
  META_APP_SECRET: "test-app-secret",
  META_ACCESS_TOKEN: "test-access-token",
  META_PHONE_NUMBER_ID: "test-phone-number-id",
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "strong-test-password",
  SUPPORT_DB: new D1DatabaseMock(),
};

async function sendIncomingMessage(id, messageData) {
  const payload = JSON.stringify({
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
                  ...messageData,
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

const auth = `Basic ${btoa("admin:strong-test-password")}`;

await sendIncomingMessage("wamid.handoff", {
  type: "interactive",
  interactive: {
    type: "list_reply",
    list_reply: { id: "HUMAN_HELP", title: "Talk to us" },
  },
});

if (
  graphPayloads.length !== 1 ||
  !graphPayloads[0].text.body.includes("Human support is now active")
) {
  throw new Error("Human support activation response is invalid");
}

await sendIncomingMessage("wamid.question", {
  type: "text",
  text: { body: "Does the salmon contain dairy?" },
});

if (graphPayloads.length !== 1) {
  throw new Error("The bot replied while human support was active");
}

const unauthorized = await worker.fetch(
  new Request("https://worker.test/support"),
  env,
  {}
);

if (unauthorized.status !== 401) {
  throw new Error("Support panel must require authentication");
}

const supportPage = await worker.fetch(
  new Request("https://worker.test/support", {
    headers: { authorization: auth },
  }),
  env,
  {}
);

if (
  supportPage.status !== 200 ||
  !(await supportPage.text()).includes("Sabor do Brasil | Support")
) {
  throw new Error("Support panel page was not generated");
}

const conversationsResponse = await worker.fetch(
  new Request("https://worker.test/support/api/conversations", {
    headers: { authorization: auth },
  }),
  env,
  {}
);
const conversations = await conversationsResponse.json();

if (
  conversations.conversations?.length !== 1 ||
  conversations.conversations[0].display_name !== "Canadian Customer"
) {
  throw new Error("Open support conversation was not listed");
}

const messagesResponse = await worker.fetch(
  new Request(
    "https://worker.test/support/api/messages?phone=14165550123",
    { headers: { authorization: auth } }
  ),
  env,
  {}
);
const messages = await messagesResponse.json();

if (
  messages.messages?.length !== 3 ||
  !messages.messages.some(
    (message) => message.body === "Does the salmon contain dairy?"
  )
) {
  throw new Error("Support thread did not store the expected messages");
}

const replyResponse = await worker.fetch(
  new Request("https://worker.test/support/api/reply", {
    method: "POST",
    headers: {
      authorization: auth,
      "content-type": "application/json",
      origin: "https://worker.test",
    },
    body: JSON.stringify({
      phone: "14165550123",
      body: "A team member is checking this for you.",
    }),
  }),
  env,
  {}
);

if (replyResponse.status !== 200 || graphPayloads.length !== 2) {
  throw new Error("Human reply was not sent through WhatsApp");
}

const closeResponse = await worker.fetch(
  new Request("https://worker.test/support/api/close", {
    method: "POST",
    headers: {
      authorization: auth,
      "content-type": "application/json",
      origin: "https://worker.test",
    },
    body: JSON.stringify({ phone: "14165550123" }),
  }),
  env,
  {}
);

const closeResult = await closeResponse.json();

if (
  closeResponse.status !== 200 ||
  closeResult.ok !== true ||
  closeResult.menu_sent !== true
) {
  throw new Error("Support conversation could not be closed");
}

if (
  graphPayloads.length !== 4 ||
  graphPayloads[2].type !== "text" ||
  !graphPayloads[2].text.body.includes("Human support has ended") ||
  graphPayloads[3].type !== "interactive" ||
  graphPayloads[3].interactive?.type !== "list"
) {
  throw new Error(
    "Return-to-bot confirmation or automated menu is invalid"
  );
}

const conversationsAfterCloseResponse = await worker.fetch(
  new Request("https://worker.test/support/api/conversations", {
    headers: { authorization: auth },
  }),
  env,
  {}
);
const conversationsAfterClose =
  await conversationsAfterCloseResponse.json();

if (conversationsAfterClose.conversations?.length !== 0) {
  throw new Error("Closed support conversation is still listed as open");
}

await sendIncomingMessage("wamid.after-close", {
  type: "text",
  text: { body: "HELLO" },
});

if (
  graphPayloads.length !== 5 ||
  graphPayloads[4].type !== "interactive" ||
  graphPayloads[4].interactive?.type !== "list"
) {
  throw new Error("Customer did not return to the automated bot");
}

console.log("Human support flow test passed");
