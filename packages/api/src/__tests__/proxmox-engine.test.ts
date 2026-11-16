import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  ProxmoxAbortError,
  ProxmoxApiError,
  ProxmoxAuthenticationError,
  ProxmoxConfigError,
  ProxmoxConnectionError,
  ProxmoxError,
  ProxmoxParameterError,
  ProxmoxPermissionError,
  ProxmoxResponseError,
  ProxmoxTimeoutError,
} from "../errors.js";
import type {
  ProxmoxEngineOptions,
  ProxmoxRequestEvent,
} from "../proxmox-engine.js";
import { ProxmoxEngine } from "../proxmox-engine.js";

/**
 * One request as it arrived at the test server.
 */
interface Received {
  method: string;
  /**
   * The request target without its query string.
   */
  path: string;
  /**
   * The request target as sent, query string included.
   */
  url: string;
  /**
   * The request body decoded as UTF-8. Empty when there was none.
   */
  body: string;
  /**
   * The request headers, with their names in lower case.
   */
  headers: http.IncomingHttpHeaders;
}

/**
 * How the test server answers one request.
 */
interface Reply {
  /**
   * HTTP status.
   *
   * @defaultValue `200`
   */
  status?: number;
  /**
   * Text of the status line. Left to the server's default when omitted.
   */
  statusText?: string;
  /**
   * The response body. When omitted, the JSON envelope of `{ ok: true }`.
   */
  body?: string;
  /**
   * The `Content-Type` of the response.
   *
   * @defaultValue `"application/json;charset=UTF-8"`
   */
  type?: string;
  /**
   * Closes the socket without answering, at once and whatever else is set.
   */
  drop?: boolean;
  /**
   * Milliseconds to wait before answering.
   *
   * @defaultValue `0`
   */
  delay?: number;
  /**
   * Sends the headers and the start of a JSON body, then goes quiet without
   * ever ending the response. `body` is ignored.
   */
  stall?: boolean;
  /**
   * Sends the body `first second` in two parts, this many milliseconds
   * apart. `body` is ignored.
   */
  slowBody?: number;
}

/**
 * Decides how the test server answers a request.
 *
 * @param request - The request that arrived.
 * @param index - Position of the request among those received in the
 *   current test, starting at 0.
 * @returns The reply, or `undefined` for the default one: a ticket for a
 *   login, and a `200` with the JSON envelope of `{ ok: true }` for
 *   anything else.
 */
type Handler = (request: Received, index: number) => Reply | undefined;

const JSON_TYPE = "application/json;charset=UTF-8";
const TICKET_PATH = "/api2/json/access/ticket";
const TOKEN = { tokenID: "root@pam!test", tokenSecret: "secret-value" };
const PASSWORD = { username: "root@pam", password: "hunter2" };

let server: http.Server;
let port: number;
let received: Received[] = [];
let handler: Handler = () => undefined;

/**
 * Serialises a reply body in the envelope Proxmox uses.
 *
 * @param data - Value of the envelope's `data` field.
 * @param extra - Further fields of the envelope, such as `message` and
 *   `errors`.
 * @returns The envelope as JSON text.
 */
function json(data: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ data, ...extra });
}

/**
 * Builds the reply to a successful login.
 *
 * @param ticket - The ticket to issue. `TICKET` when omitted.
 * @returns A `200` carrying the ticket, the CSRF token `CSRF` and the
 *   username `root@pam`.
 */
function ticketReply(ticket = "TICKET"): Reply {
  return {
    body: json({ ticket, CSRFPreventionToken: "CSRF", username: "root@pam" }),
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request: Received = {
        method: req.method ?? "",
        path: (req.url ?? "").split("?")[0] ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
        headers: req.headers,
      };
      received.push(request);
      const reply =
        handler(request, received.length - 1) ??
        (request.path === TICKET_PATH ? ticketReply() : {});
      if (reply.drop) {
        res.destroy();
        return;
      }
      setTimeout(() => {
        res.writeHead(reply.status ?? 200, reply.statusText, {
          "content-type": reply.type ?? JSON_TYPE,
        });
        if (reply.stall) {
          res.write('{"data":');
        } else if (reply.slowBody) {
          res.write("first ");
          setTimeout(() => res.end("second"), reply.slowBody);
        } else {
          res.end(reply.body ?? json({ ok: true }));
        }
      }, reply.delay ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  received = [];
  handler = () => undefined;
});

/**
 * Builds an engine that talks to the test server over plain HTTP.
 *
 * @param overrides - Options laid over the server's address. They have to
 *   include credentials; the test token is used when they are omitted
 *   altogether.
 * @returns A new engine, which has not sent anything yet.
 */
function engine(
  overrides: Partial<ProxmoxEngineOptions> & Record<string, unknown> = TOKEN,
): ProxmoxEngine {
  return new ProxmoxEngine({
    host: "127.0.0.1",
    port,
    schema: "http",
    ...overrides,
  } as ProxmoxEngineOptions);
}

/**
 * Sends a `GET` through an engine, with the path doubling as its template.
 *
 * @param e - The engine to send through.
 * @param path - Path to request. `/api2/json/x` when omitted.
 * @param params - Parameters, which a `GET` carries in the query string.
 * @returns The decoded reply.
 */
function get(
  e: ProxmoxEngine,
  path = "/api2/json/x",
  params?: Record<string, unknown>,
) {
  return e.doRequest("GET", path, path, params);
}

/**
 * Sends a `POST` through an engine, with the path doubling as its template.
 *
 * @param e - The engine to send through.
 * @param path - Path to request. `/api2/json/x` when omitted.
 * @param params - Parameters, which a `POST` carries in its body.
 * @returns The decoded reply.
 */
function post(
  e: ProxmoxEngine,
  path = "/api2/json/x",
  params?: Record<string, unknown>,
) {
  return e.doRequest("POST", path, path, params);
}

/**
 * Awaits a promise that is expected to reject.
 *
 * @param promise - The request under test.
 * @returns What the promise rejected with, for the test to inspect.
 * @throws An {@link Error} if the promise fulfils instead.
 */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the request to fail");
}

describe("parameter encoding", () => {
  test("GET parameters go in the query string", async () => {
    await get(engine(), "/api2/json/nodes", { full: true });
    expect(received[0]?.url).toBe("/api2/json/nodes?full=1");
  });

  test("booleans encode as 1 and 0", async () => {
    await get(engine(), undefined, { yes: true, no: false });
    expect(received[0]?.url).toBe("/api2/json/x?yes=1&no=0");
  });

  test("arrays repeat the key", async () => {
    await post(engine(), undefined, { command: ["touch", "/tmp/a"] });
    expect(received[0]?.body).toBe("command=touch&command=%2Ftmp%2Fa");
  });

  test("null and undefined are dropped rather than sent empty", async () => {
    await get(engine(), undefined, { a: 1, b: null, c: undefined });
    expect(received[0]?.url).toBe("/api2/json/x?a=1");
  });

  test("POST parameters go in a form-encoded body", async () => {
    await post(engine(), undefined, { name: "a b" });
    expect(received[0]?.body).toBe("name=a+b");
    expect(received[0]?.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  test("DELETE parameters go in the query string", async () => {
    await engine().doRequest("DELETE", "/api2/json/x", "/api2/json/x", {
      purge: true,
    });
    expect(received[0]?.url).toBe("/api2/json/x?purge=1");
    expect(received[0]?.body).toBe("");
  });

  test("a request with no parameters sends no body", async () => {
    await post(engine());
    expect(received[0]?.body).toBe("");
    expect(received[0]?.headers["content-type"]).toBeUndefined();
  });

  test("the caller's params object is not mutated", async () => {
    const params = { full: true, skip: undefined };
    await get(engine(), undefined, params);
    expect(params).toEqual({ full: true, skip: undefined });
  });
});

describe("configuration", () => {
  test("the port defaults to 8006", () => {
    const e = new ProxmoxEngine({ host: "pve.example", ...TOKEN });
    expect(e.origin).toBe("https://pve.example:8006");
  });

  test("an IPv6 address is bracketed", () => {
    const e = new ProxmoxEngine({ host: "2001:db8::1", ...TOKEN });
    expect(e.origin).toBe("https://[2001:db8::1]:8006");
  });

  test.each([
    [
      "a URL as host",
      { host: "https://pve.example", ...TOKEN },
      /bare hostname/,
    ],
    [
      "a port in the host",
      { host: "pve.example:8006", ...TOKEN },
      /"port" option/,
    ],
    [
      "a malformed tokenID",
      { host: "h", tokenID: "root", tokenSecret: "s" },
      /USER@REALM!TOKENNAME/,
    ],
    [
      "a missing tokenSecret",
      { host: "h", tokenID: "root@pam!t", tokenSecret: "" },
      /tokenSecret/,
    ],
    ["no credentials", { host: "h" }, /No credentials/],
    [
      "a username without realm",
      { host: "h", username: "root", password: "p" },
      /realm/,
    ],
    [
      "an out-of-range port",
      { host: "h", port: 70000, ...TOKEN },
      /Invalid port/,
    ],
  ])("%s is rejected at construction", (_, options, message) => {
    const build = () => new ProxmoxEngine(options as ProxmoxEngineOptions);
    expect(build).toThrow(ProxmoxConfigError);
    expect(build).toThrow(message);
  });

  test("a token secret of any shape is accepted", () => {
    expect(() =>
      engine({ tokenID: "a@pve!b", tokenSecret: "not-a-uuid" }),
    ).not.toThrow();
  });
});

describe("token authentication", () => {
  test("sends the token and never logs in", async () => {
    await get(engine());
    expect(received).toHaveLength(1);
    expect(received[0]?.headers.authorization).toBe(
      "PVEAPIToken=root@pam!test=secret-value",
    );
  });

  test("a rejected token is not replayed", async () => {
    handler = () => ({
      status: 401,
      statusText: "Authentication failed!",
      body: "",
    });
    const error = await failure(get(engine()));
    expect(error).toBeInstanceOf(ProxmoxAuthenticationError);
    expect(received).toHaveLength(1);
  });

  test("getTicket rejects, because a token has no ticket", async () => {
    expect(engine().getTicket()).rejects.toBeInstanceOf(ProxmoxConfigError);
  });
});

describe("password authentication", () => {
  test("logs in once, then reuses the ticket", async () => {
    const e = engine(PASSWORD);
    await get(e);
    await post(e);
    expect(received.map((r) => r.path)).toEqual([
      TICKET_PATH,
      "/api2/json/x",
      "/api2/json/x",
    ]);
    expect(received[0]?.body).toBe("username=root%40pam&password=hunter2");
    expect(received[1]?.headers.cookie).toBe("PVEAuthCookie=TICKET");
    expect(received[1]?.headers.csrfpreventiontoken).toBeUndefined();
    expect(received[2]?.headers.csrfpreventiontoken).toBe("CSRF");
    expect(e.ticket).toBe("TICKET");
  });

  test("concurrent requests share one login", async () => {
    const e = engine(PASSWORD);
    await Promise.all([get(e), get(e), get(e)]);
    expect(received.filter((r) => r.path === TICKET_PATH)).toHaveLength(1);
  });

  test("a rejected ticket is renewed and the request replayed once, for any method", async () => {
    let tickets = 0;
    handler = (request) => {
      if (request.path === TICKET_PATH)
        return ticketReply(`TICKET${++tickets}`);
      return request.headers.cookie === "PVEAuthCookie=TICKET1"
        ? { status: 401, statusText: "Authentication failed!", body: "" }
        : undefined;
    };
    const e = engine(PASSWORD);
    expect(await post(e)).toEqual({ ok: true });
    expect(tickets).toBe(2);
    expect(received.at(-1)?.headers.cookie).toBe("PVEAuthCookie=TICKET2");
  });

  test("requests in flight when a ticket is rejected are all replayed, with one login", async () => {
    let tickets = 0;
    handler = (request) => {
      if (request.path === TICKET_PATH) {
        return { ...ticketReply(`TICKET${++tickets}`), delay: 30 };
      }
      return request.headers.cookie === "PVEAuthCookie=TICKET1"
        ? {
            status: 401,
            statusText: "Authentication failed!",
            body: "",
            delay: 10,
          }
        : undefined;
    };
    const e = engine(PASSWORD);
    await get(e).catch(() => undefined);
    const results = await Promise.all([get(e), post(e), get(e), post(e)]);
    const ok = { ok: true };
    expect(results).toEqual([ok, ok, ok, ok]);
    expect(tickets).toBe(2);
  });

  test("a ticket that keeps being rejected fails after one renewal", async () => {
    handler = (request) =>
      request.path === TICKET_PATH
        ? undefined
        : { status: 401, statusText: "Authentication failed!", body: "" };
    const error = await failure(get(engine(PASSWORD)));
    expect(error).toBeInstanceOf(ProxmoxAuthenticationError);
    expect(received.filter((r) => r.path === TICKET_PATH)).toHaveLength(2);
  });

  test("a wrong password is an authentication error naming the reason", async () => {
    handler = () => ({
      status: 401,
      statusText: "authentication failure",
      body: json(null, { message: "authentication failure\n" }),
    });
    const error = (await failure(
      get(engine(PASSWORD)),
    )) as ProxmoxAuthenticationError;
    expect(error).toBeInstanceOf(ProxmoxAuthenticationError);
    expect(error.reason).toBe("authentication failure");
    expect(error.message).not.toContain("hunter2");
    expect(received).toHaveLength(1);
  });

  test("a login that needs a second factor says so", async () => {
    handler = (request) =>
      request.path === TICKET_PATH
        ? {
            body: json({
              ticket: "PVE:!tfa!x",
              CSRFPreventionToken: "C",
              NeedTFA: 1,
            }),
          }
        : undefined;
    const error = (await failure(
      get(engine(PASSWORD)),
    )) as ProxmoxAuthenticationError;
    expect(error).toBeInstanceOf(ProxmoxAuthenticationError);
    expect(error.tfaRequired).toBe(true);
    expect(error.message).toContain('"otp" option');
  });

  test("otp answers the second-factor challenge", async () => {
    handler = (request) => {
      if (request.path !== TICKET_PATH) return undefined;
      return request.body.includes("tfa-challenge")
        ? ticketReply("FULL")
        : {
            body: json({
              ticket: "PVE:!tfa!x",
              CSRFPreventionToken: "C",
              NeedTFA: 1,
            }),
          };
    };
    const e = engine({ ...PASSWORD, otp: () => "123456" });
    await get(e);
    expect(received[1]?.body).toBe(
      "username=root%40pam&password=totp%3A123456&tfa-challenge=PVE%3A%21tfa%21x",
    );
    expect(e.ticket).toBe("FULL");
  });

  test("logout forgets the ticket", async () => {
    const e = engine(PASSWORD);
    await get(e);
    e.logout();
    expect(e.ticket).toBeUndefined();
    await get(e);
    expect(received.filter((r) => r.path === TICKET_PATH)).toHaveLength(2);
  });
});

describe("responses", () => {
  test("the data envelope is unwrapped", async () => {
    handler = () => ({ body: json([{ node: "pve1" }]) });
    expect(await get(engine())).toEqual([{ node: "pve1" }]);
  });

  test("a missing data field becomes null", async () => {
    handler = () => ({ body: "{}" });
    expect(await get(engine())).toBeNull();
  });

  test("a respaced content-type is still parsed as JSON", async () => {
    handler = () => ({
      body: json(1),
      type: "application/json; charset=utf-8",
    });
    expect(await get(engine())).toBe(1);
  });

  test("octet-stream is handed back as a stream", async () => {
    handler = () => ({ body: "raw", type: "application/octet-stream" });
    const stream = (await get(engine())) as ReadableStream;
    expect(await new Response(stream).text()).toBe("raw");
  });

  test("any 2xx status is a success", async () => {
    handler = () => ({ status: 201, body: json("created") });
    expect(await post(engine())).toBe("created");
  });

  test("a body that is not JSON despite its content-type is a response error", async () => {
    handler = () => ({ body: "<html>" });
    const error = (await failure(get(engine()))) as ProxmoxResponseError;
    expect(error).toBeInstanceOf(ProxmoxResponseError);
    expect(error.status).toBe(200);
  });
});

describe("API errors", () => {
  test("400 names the rejected parameters", async () => {
    handler = () => ({
      status: 400,
      statusText: "Parameter verification failed.",
      body: json(null, {
        message: "Parameter verification failed.\n",
        errors: { memory: "value is not an integer\n" },
      }),
    });
    const error = (await failure(
      engine().doRequest(
        "PUT",
        "/api2/json/nodes/pve1/qemu/100/config",
        "/api2/json/nodes/*/qemu/*/config",
        { memory: "lots" },
      ),
    )) as ProxmoxParameterError;

    expect(error).toBeInstanceOf(ProxmoxParameterError);
    expect(error.code).toBe("parameter");
    expect(error.status).toBe(400);
    expect(error.errors).toEqual({ memory: "value is not an integer" });
    expect(error.message).toBe(
      "PUT /api2/json/nodes/pve1/qemu/100/config failed: 400 Parameter verification failed. (memory: value is not an integer)",
    );
    expect(error.request).toMatchObject({
      method: "PUT",
      pathTemplate: "/api2/json/nodes/*/qemu/*/config",
      origin: `http://127.0.0.1:${port}`,
      attempt: 1,
    });
  });

  test("403 is a permission error", async () => {
    handler = () => ({
      status: 403,
      statusText: "Permission check failed (/vms/100, VM.Audit)",
      body: json(null),
    });
    const error = (await failure(get(engine()))) as ProxmoxPermissionError;
    expect(error).toBeInstanceOf(ProxmoxPermissionError);
    expect(error.reason).toBe("Permission check failed (/vms/100, VM.Audit)");
  });

  test("the reason comes from the body when the status line has none", async () => {
    handler = () => ({
      status: 500,
      statusText: "",
      body: json(null, {
        message: "unable to find configuration file for VM 999\n",
      }),
    });
    const error = (await failure(post(engine()))) as ProxmoxApiError;
    expect(error).toBeInstanceOf(ProxmoxApiError);
    expect(error.code).toBe("api");
    expect(error.reason).toBe("unable to find configuration file for VM 999");
  });

  test("a plain-text error body is used as the reason", async () => {
    handler = () => ({
      status: 501,
      statusText: "",
      body: "no such uri",
      type: "text/plain",
    });
    const error = (await failure(get(engine()))) as ProxmoxApiError;
    expect(error.reason).toBe("no such uri");
  });

  test("neither the message nor the JSON form leaks credentials or parameters", async () => {
    handler = () => ({ status: 500, statusText: "boom", body: json(null) });
    const error = (await failure(
      post(engine(), "/api2/json/access/password", { password: "s3cret" }),
    )) as ProxmoxApiError;
    const dump = `${error.message} ${JSON.stringify(error)}`;
    expect(dump).not.toContain("s3cret");
    expect(dump).not.toContain("secret-value");
  });

  test("isInstance recognises every error the client throws", async () => {
    handler = () => ({ status: 500, statusText: "boom", body: json(null) });
    const error = await failure(get(engine({ ...TOKEN, maxRetries: 0 })));
    expect(ProxmoxError.isInstance(error)).toBe(true);
    expect(ProxmoxError.isInstance(new Error("other"))).toBe(false);
  });
});

describe("retries", () => {
  test("a GET that cannot connect is retried, then fails with the cause", async () => {
    handler = () => ({ drop: true });
    const events: string[] = [];
    const error = (await failure(
      get(
        engine({
          ...TOKEN,
          maxRetries: 1,
          onEvent: (e) => events.push(e.type),
        }),
      ),
    )) as ProxmoxConnectionError;
    expect(error).toBeInstanceOf(ProxmoxConnectionError);
    expect(error.code).toBe("connection");
    expect(error.cause).toBeDefined();
    expect(error.request?.attempt).toBe(2);
    // Counted here, not at the server: the platform fetch may itself resend
    // a GET on a dropped connection.
    expect(events).toEqual(["request", "retry", "request", "error"]);
  });

  test("a GET recovers when a retry succeeds", async () => {
    handler = (_, index) =>
      index === 0 ? { status: 503, body: "" } : undefined;
    expect(await get(engine())).toEqual({ ok: true });
    expect(received).toHaveLength(2);
  });

  test("pveproxy's 595-599 proxy failures are retried", async () => {
    handler = (_, index) =>
      index === 0 ? { status: 595, body: "" } : undefined;
    expect(await get(engine())).toEqual({ ok: true });
  });

  test("POST is never retried, because it may already have taken effect", async () => {
    handler = () => ({ drop: true });
    await failure(post(engine()));
    expect(received).toHaveLength(1);
  });

  test("a 500 is not retried", async () => {
    handler = () => ({ status: 500, statusText: "boom", body: json(null) });
    await failure(get(engine()));
    expect(received).toHaveLength(1);
  });

  test("maxRetries can be overridden per request", async () => {
    handler = () => ({ status: 503, body: "" });
    const e = engine();
    await failure(
      e.doRequest("GET", "/api2/json/x", "/api2/json/x", undefined, {
        maxRetries: 0,
      }),
    );
    expect(received).toHaveLength(1);
  });
});

describe("timeouts and cancellation", () => {
  test("queryTimeout raises a timeout error", async () => {
    handler = () => ({ delay: 500 });
    const error = (await failure(
      get(engine({ ...TOKEN, queryTimeout: 50, maxRetries: 0 })),
    )) as ProxmoxTimeoutError;
    expect(error).toBeInstanceOf(ProxmoxTimeoutError);
    expect(error.code).toBe("timeout");
    expect(error.timeout).toBe(50);
  });

  test("a body that stalls after the headers still times out", async () => {
    handler = () => ({ stall: true });
    const error = await failure(
      get(engine({ ...TOKEN, queryTimeout: 50, maxRetries: 0 })),
    );
    expect(error).toBeInstanceOf(ProxmoxTimeoutError);
  });

  test("a per-request timeout overrides the default", async () => {
    handler = () => ({ delay: 500 });
    const error = await failure(
      engine().doRequest("POST", "/api2/json/x", "/api2/json/x", undefined, {
        timeout: 50,
      }),
    );
    expect(error).toBeInstanceOf(ProxmoxTimeoutError);
  });

  test("the caller's signal stops a request that is waiting for a login", async () => {
    handler = (request) =>
      request.path === TICKET_PATH
        ? { ...ticketReply(), delay: 300 }
        : undefined;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    const error = await failure(
      engine(PASSWORD).doRequest(
        "GET",
        "/api2/json/x",
        "/api2/json/x",
        undefined,
        {
          signal: controller.signal,
        },
      ),
    );
    expect(error).toBeInstanceOf(ProxmoxAbortError);
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("a streamed download is not cut off by the timeout", async () => {
    handler = () => ({ type: "application/octet-stream", slowBody: 150 });
    const stream = (await get(
      engine({ ...TOKEN, queryTimeout: 50, maxRetries: 0 }),
    )) as ReadableStream;
    expect(await new Response(stream).text()).toBe("first second");
  });

  test("the caller's signal aborts the request and is not retried", async () => {
    handler = () => ({ delay: 500 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const error = await failure(
      engine().doRequest("GET", "/api2/json/x", "/api2/json/x", undefined, {
        signal: controller.signal,
      }),
    );
    expect(error).toBeInstanceOf(ProxmoxAbortError);
    expect(received).toHaveLength(1);
  });
});

describe("observability", () => {
  test("onEvent sees the request, the retry and the response, without credentials", async () => {
    handler = (_, index) =>
      index === 0 ? { status: 503, body: "" } : undefined;
    const events: ProxmoxRequestEvent[] = [];
    await get(engine({ ...TOKEN, onEvent: (event) => events.push(event) }));

    expect(events.map((event) => `${event.type}:${event.attempt}`)).toEqual([
      "request:1",
      "retry:1",
      "request:2",
      "response:2",
    ]);
    expect(JSON.stringify(events)).not.toContain("secret-value");
  });

  test("an observer that throws does not fail the request", async () => {
    const e = engine({
      ...TOKEN,
      onEvent: () => {
        throw new Error("observer bug");
      },
    });
    expect(await post(e)).toEqual({ ok: true });
  });

  test("logging or serialising an engine does not reveal credentials", () => {
    const e = engine({
      ...PASSWORD,
      headers: { "X-Api-Key": "header-secret" },
    });
    const dump = `${JSON.stringify(e)} ${Bun.inspect(e)} ${Bun.inspect(engine())}`;
    expect(dump).toContain("127.0.0.1");
    for (const secret of ["hunter2", "secret-value", "header-secret"]) {
      expect(dump).not.toContain(secret);
    }
  });

  test("custom headers are sent, per client and per request", async () => {
    const e = engine({ ...TOKEN, headers: { "X-Client": "a" } });
    await e.doRequest("GET", "/api2/json/x", "/api2/json/x", undefined, {
      headers: { "X-Request": "b" },
    });
    expect(received[0]?.headers["x-client"]).toBe("a");
    expect(received[0]?.headers["x-request"]).toBe("b");
  });

  test("a custom fetch replaces the transport", async () => {
    const urls: string[] = [];
    const e = engine({
      ...TOKEN,
      fetch: async (url) => {
        urls.push(String(url));
        return new Response(json("stub"), {
          headers: { "content-type": JSON_TYPE },
        });
      },
    });
    expect(await get(e)).toBe("stub");
    expect(urls).toEqual([`http://127.0.0.1:${port}/api2/json/x`]);
    expect(received).toHaveLength(0);
  });
});
