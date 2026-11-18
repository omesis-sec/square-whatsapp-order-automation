// Shared test doubles for the Cloudflare runtime APIs used by the Worker.
import { webcrypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/** Provides `crypto` and an in-memory `caches.default` like the Workers runtime. */
export function installRuntimeGlobals() {
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
}

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

/** Minimal D1 binding backed by an in-memory `node:sqlite` database. */
export class D1DatabaseMock {
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
