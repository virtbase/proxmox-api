import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ProxmoxEngine } from "../proxmox-engine.js";

interface Received {
  method: string;
  url: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

const TOKEN = {
  tokenID: "root@pam!test",
  tokenSecret: "12345678-1234-1234-1234-1234567890ab",
};

let server: http.Server;
let port: number;
let received: Received[] = [];
/** Per-path reply queue, so a test can script a sequence of responses. */
let replies = new Map<string, Array<[number, string, string]>>();
/** Paths the server should never answer, to exercise transport failure. */
let hang = new Set<string>();

function reply(
  path: string,
  status: number,
  body: string,
  type = "application/json;charset=UTF-8",
) {
  const queue = replies.get(path) ?? [];
  queue.push([status, body, type]);
  replies.set(path, queue);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
        headers: req.headers,
      });
      if (hang.has(path)) {
        res.destroy();
        return;
      }
      if (path === "/api2/json/access/ticket") {
        res.writeHead(200, {
          "content-type": "application/json;charset=UTF-8",
        });
        res.end(
          JSON.stringify({
            data: {
              ticket: "TICKET",
              CSRFPreventionToken: "CSRF",
              username: "root@pam",
              cap: {},
            },
          }),
        );
        return;
      }
      const queued = replies.get(path)?.shift();
      const [status, body, type] = queued ?? [
        200,
        JSON.stringify({ data: { ok: true } }),
        "application/json;charset=UTF-8",
      ];
      res.writeHead(status, { "content-type": type });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => server.close());

function engine(overrides: Record<string, unknown> = {}) {
  received = [];
  replies = new Map();
  hang = new Set();
  return new ProxmoxEngine({
    host: "127.0.0.1",
    port,
    schema: "http",
    ...TOKEN,
    ...overrides,
    // The options type is a union and the spread can produce either arm.
    // biome-ignore lint/suspicious/noExplicitAny: union spread, see above.
  } as any);
}

describe("parameter encoding", () => {
  test("GET parameters go in the query string", async () => {
    const e = engine();
    await e.doRequest("GET", "/api2/json/nodes", "/api2/json/nodes", {
      full: true,
    });
    expect(received[0]?.url).toBe("/api2/json/nodes?full=1");
  });

  test("booleans encode as 1 and 0", async () => {
    const e = engine();
    await e.doRequest("GET", "/api2/json/x", "/api2/json/x", {
      yes: true,
      no: false,
    });
    expect(received[0]?.url).toBe("/api2/json/x?yes=1&no=0");
  });

  test("arrays repeat the key", async () => {
    const e = engine();
    await e.doRequest("POST", "/api2/json/x", "/api2/json/x", {
      command: ["touch", "/tmp/a"],
    });
    expect(received[0]?.body).toBe("command=touch&command=%2Ftmp%2Fa");
  });

  test("null and undefined are dropped rather than sent empty", async () => {
    const e = engine();
    await e.doRequest("GET", "/api2/json/x", "/api2/json/x", {
      a: 1,
      b: null,
      c: undefined,
    });
    expect(received[0]?.url).toBe("/api2/json/x?a=1");
  });

  test("POST parameters go in a form-encoded body", async () => {
    const e = engine();
    await e.doRequest("POST", "/api2/json/x", "/api2/json/x", { name: "a b" });
    expect(received[0]?.body).toBe("name=a+b");
    expect(received[0]?.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  test("Content-Length matches the encoded body", async () => {
    const e = engine();
    await e.doRequest("POST", "/api2/json/x", "/api2/json/x", {
      name: "naïve ✓",
    });
    const body = received[0]?.body ?? "";
    expect(received[0]?.headers["content-length"]).toBe(
      String(Buffer.byteLength(body)),
    );
  });

  test("the caller's params object is not mutated", async () => {
    const e = engine();
    const params = { a: 1, b: null };
    await e.doRequest("GET", "/api2/json/x", "/api2/json/x", params);
    expect(params).toEqual({ a: 1, b: null });
  });

  test("a request with no parameters sends no body", async () => {
    const e = engine();
    await e.doRequest("GET", "/api2/json/x", "/api2/json/x");
    expect(received[0]?.body).toBe("");
  });
});

describe("authentication", () => {
  test("a token authenticates without a login round trip", async () => {
    const e = engine();
    await e.doRequest("GET", "/api2/json/x", "/api2/json/x");
    expect(received).toHaveLength(1);
    expect(received[0]?.headers.authorization).toBe(
      `PVEAPIToken=${TOKEN.tokenID}=${TOKEN.tokenSecret}`,
    );
  });

  test("a password logs in first, then reuses the ticket", async () => {
    const e = engine({
      tokenID: undefined,
      tokenSecret: undefined,
      username: "root@pam",
      password: "s3cret",
    });
    await e.doRequest("GET", "/api2/json/a", "/api2/json/a");
    await e.doRequest("GET", "/api2/json/b", "/api2/json/b");
    expect(received.map((r) => r.url)).toEqual([
      "/api2/json/access/ticket",
      "/api2/json/a",
      "/api2/json/b",
    ]);
    expect(received[1]?.headers.cookie).toBe("PVEAuthCookie=TICKET");
    expect(received[1]?.headers.csrfpreventiontoken).toBe("CSRF");
  });

  test("a malformed tokenID is rejected at construction", () => {
    expect(() => engine({ tokenID: "nope" })).toThrow(/invalid tokenID/);
  });

  test("a malformed tokenSecret is rejected at construction", () => {
    expect(() => engine({ tokenSecret: "not-a-uuid" })).toThrow(
      /invalid tokenSecret/,
    );
  });

  test("a missing password is rejected at construction", () => {
    expect(() =>
      engine({ tokenID: undefined, tokenSecret: undefined, password: "" }),
    ).toThrow(/password is missing/);
  });

  test("getTicket returns the token without contacting the server", async () => {
    const e = engine();
    const { ticket, CSRFPreventionToken } = await e.getTicket();
    expect(ticket).toBe(`PVEAPIToken=${TOKEN.tokenID}=${TOKEN.tokenSecret}`);
    expect(CSRFPreventionToken).toBe("");
    expect(received).toHaveLength(0);
  });
});

describe("responses", () => {
  test("the data envelope is unwrapped", async () => {
    const e = engine();
    reply("/api2/json/x", 200, JSON.stringify({ data: [{ node: "pve1" }] }));
    expect(await e.doRequest("GET", "/api2/json/x", "/api2/json/x")).toEqual([
      { node: "pve1" },
    ]);
  });

  test("a respaced content-type is still parsed as JSON", async () => {
    const e = engine();
    reply(
      "/api2/json/x",
      200,
      JSON.stringify({ data: 42 }),
      "application/json; charset=utf-8",
    );
    expect(await e.doRequest("GET", "/api2/json/x", "/api2/json/x")).toBe(42);
  });

  test("octet-stream is handed back as a stream", async () => {
    const e = engine();
    reply("/api2/json/x", 200, "binary", "application/octet-stream");
    const body = await e.doRequest("GET", "/api2/json/x", "/api2/json/x");
    expect(body).toBeInstanceOf(ReadableStream);
  });
});

describe("errors", () => {
  test("400 throws with the decoded body", async () => {
    const e = engine();
    reply(
      "/api2/json/x",
      400,
      JSON.stringify({ data: null, errors: { memory: "not an integer" } }),
    );
    expect(e.doRequest("PUT", "/api2/json/x", "/api2/json/x")).rejects.toThrow(
      /not an integer/,
    );
  });

  test("500 throws", async () => {
    const e = engine();
    reply("/api2/json/x", 500, JSON.stringify({ data: null }));
    expect(e.doRequest("GET", "/api2/json/x", "/api2/json/x")).rejects.toThrow(
      /return Error 500/,
    );
  });

  test("an unexpected status throws", async () => {
    const e = engine();
    reply("/api2/json/x", 418, JSON.stringify({ data: null }));
    expect(e.doRequest("GET", "/api2/json/x", "/api2/json/x")).rejects.toThrow(
      /connection failed with 418/,
    );
  });

  test("a transport failure is retried once, then throws with a cause", async () => {
    // Injected rather than driven through the server: a dropped socket is
    // retryable at the HTTP layer too, so counting requests server-side
    // measures undici's retries as well as the engine's.
    let attempts = 0;
    const e = new ProxmoxEngine({
      host: "127.0.0.1",
      port,
      schema: "http",
      ...TOKEN,
      fetch: () => {
        attempts++;
        return Promise.reject(new Error("ECONNRESET"));
      },
    });

    let error: unknown;
    try {
      await e.doRequest("GET", "/api2/json/x", "/api2/json/x");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/FaILED to call GET/);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(attempts).toBe(2);
  });

  test("a rejected ticket is discarded and the request replayed once", async () => {
    let logins = 0;
    let calls = 0;
    const e = new ProxmoxEngine({
      host: "127.0.0.1",
      port,
      schema: "http",
      username: "root@pam",
      password: "s3cret",
      fetch: (url) => {
        if (String(url).endsWith("/access/ticket")) {
          logins++;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                data: { ticket: `T${logins}`, CSRFPreventionToken: "C" },
              }),
              { headers: { "content-type": "application/json;charset=UTF-8" } },
            ),
          );
        }
        calls++;
        // Reject the first attempt the way PVE rejects a stale ticket.
        return Promise.resolve(
          calls === 1
            ? new Response(JSON.stringify({ data: null }), {
                status: 401,
                statusText: "invalid PVE ticket",
                headers: { "content-type": "application/json;charset=UTF-8" },
              })
            : new Response(JSON.stringify({ data: "ok" }), {
                headers: { "content-type": "application/json;charset=UTF-8" },
              }),
        );
      },
    });

    expect(await e.doRequest("GET", "/api2/json/x", "/api2/json/x")).toBe("ok");
    expect(calls).toBe(2);
    expect(logins).toBe(2);
  });

  test("a rejected token is not replayed, because it would fail again", async () => {
    let calls = 0;
    const e = new ProxmoxEngine({
      host: "127.0.0.1",
      port,
      schema: "http",
      ...TOKEN,
      fetch: () => {
        calls++;
        return Promise.resolve(
          new Response(JSON.stringify({ data: null }), {
            status: 401,
            statusText: "invalid PVE ticket",
            headers: { "content-type": "application/json;charset=UTF-8" },
          }),
        );
      },
    });
    expect(e.doRequest("GET", "/api2/json/x", "/api2/json/x")).rejects.toThrow(
      /401/,
    );
    await Bun.sleep(20);
    expect(calls).toBe(1);
  });

  test("queryTimeout aborts a slow request", async () => {
    const slow = http.createServer(() => {
      /* never responds */
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const e = new ProxmoxEngine({
      host: "127.0.0.1",
      port: (slow.address() as AddressInfo).port,
      schema: "http",
      ...TOKEN,
      queryTimeout: 150,
    });
    expect(e.doRequest("GET", "/api2/json/x", "/api2/json/x")).rejects.toThrow(
      /FaILED to call/,
    );
    await Bun.sleep(600);
    slow.close();
  });
});
