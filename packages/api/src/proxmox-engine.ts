import type { ProxmoxApiErrorDetails, ProxmoxRequestInfo } from "./errors.js";
import {
  apiErrorFor,
  ProxmoxAbortError,
  ProxmoxAuthenticationError,
  ProxmoxConfigError,
  ProxmoxConnectionError,
  ProxmoxError,
  ProxmoxResponseError,
  ProxmoxTimeoutError,
} from "./errors.js";
import type { ApiParamType, ApiRequestable, RequestOptions } from "./proxy.js";

/**
 * Sent as the `User-Agent` of every request, unless a custom header replaces
 * it.
 */
const USER_AGENT =
  "@virtbase/proxmox-api (+https://github.com/virtbase/proxmox-api)";

/**
 * Path a password login is posted to.
 */
const TICKET_PATH = "/api2/json/access/ticket";

/**
 * Port used when the `port` option is omitted.
 */
const DEFAULT_PORT = 8006;

/**
 * Milliseconds allowed for a login request when `authTimeout` is omitted.
 */
const DEFAULT_AUTH_TIMEOUT = 10_000;

/**
 * Milliseconds allowed for any other request when neither `queryTimeout` nor
 * a per-call `timeout` is given.
 */
const DEFAULT_QUERY_TIMEOUT = 60_000;

/**
 * Retries of a failed `GET` when `maxRetries` is omitted.
 */
const DEFAULT_MAX_RETRIES = 2;

/**
 * Age in milliseconds from which a cached ticket is replaced by a new login.
 *
 * Proxmox accepts a ticket for two hours. Renewing at half that leaves a wide
 * margin for clock skew and for requests already in flight.
 */
const TICKET_RENEW_AFTER = 60 * 60 * 1000;

/**
 * Statuses worth repeating: a gateway or overload answer, and the 595, 596,
 * 597 and 599 that pveproxy uses when it cannot reach the node a request is
 * proxied to.
 */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([
  408, 429, 502, 503, 504, 595, 596, 597, 599,
]);

/**
 * Longest delay before the first retry, in milliseconds. It doubles with
 * each further retry.
 */
const RETRY_BASE_DELAY = 500;

/**
 * Longest delay before any retry, in milliseconds.
 */
const RETRY_MAX_DELAY = 8_000;

/**
 * Shape of a `fetch` implementation accepted by {@link ProxmoxEngine}.
 *
 * @remarks
 * Structurally satisfied by the platform `fetch`, so any WHATWG-compatible
 * replacement - a mock, an instrumented wrapper, an agent-bound fetch - can be
 * passed straight through.
 *
 * The engine calls it with a `URL` and with options holding the `method`,
 * the `headers`, a `signal` that aborts on timeout or cancellation and, for
 * a `POST` or `PUT` with parameters, a form-encoded string `body`. A
 * rejection is reported as an abort, a timeout or a failed connection. An
 * implementation that ignores the signal is neither timed out nor cancelled.
 */
export type FetchInterface = (
  url: string | URL,
  options?: RequestInit,
) => Promise<Response>;

/**
 * What the client reports through `onEvent`, for logging and metrics. Never
 * contains credentials or parameters.
 *
 * @remarks
 * Every event carries the {@link ProxmoxRequestInfo} of the attempt it
 * belongs to, and its `type` says what happened:
 *
 * - `request`: the attempt is about to be sent. With password
 *   authentication the session is obtained first, so an attempt that fails
 *   while waiting for a login has no `request` event.
 * - `response`: a success response with the given `status` was received and
 *   decoded.
 * - `retry`: the attempt failed with `error` and is repeated after `delayMs`
 *   milliseconds.
 * - `error`: the request failed for good with `error`, which is then thrown.
 *
 * `durationMs` is the time in milliseconds since the attempt began, which
 * includes waiting for a login. Login requests are not reported themselves.
 * Nor is a `401` that leads to a new login: its replay shows up as another
 * `request` event with the same `attempt`.
 */
export type ProxmoxRequestEvent = ProxmoxRequestInfo &
  (
    | { type: "request" }
    | { type: "response"; status: number; durationMs: number }
    | { type: "retry"; delayMs: number; error: ProxmoxError }
    | { type: "error"; durationMs: number; error: ProxmoxError }
  );

/**
 * Connection settings shared by both ways of authenticating.
 */
export interface ProxmoxEngineOptionsCommon {
  /**
   * Hostname or IP address, without scheme or port. An IPv6 address may be
   * given bare or in brackets.
   */
  host: string;
  /**
   * Port of the API, an integer from 1 to 65535.
   *
   * @defaultValue `8006`
   */
  port?: number;
  /**
   * URL scheme.
   *
   * @defaultValue `"https"`
   */
  schema?: "https" | "http";
  /**
   * Milliseconds allowed for each login request. A login that has to answer
   * a second-factor challenge consists of two.
   *
   * @defaultValue `10000`
   */
  authTimeout?: number;
  /**
   * Milliseconds allowed for each attempt of every other request, from
   * sending it to the end of the response body. A body handed back as a
   * stream is covered only until the response headers arrive.
   *
   * @defaultValue `60000`
   */
  queryTimeout?: number;
  /**
   * How often a failed `GET` is retried, with exponential backoff; `0` turns
   * retries off. Other methods are never retried: they start tasks and
   * change state, and Proxmox offers no way to make a repeat safe.
   *
   * A `GET` is retried when no response arrived - a connection error or a
   * timeout - and when the status is 408, 429, 502, 503, 504, 595, 596, 597
   * or 599.
   *
   * @defaultValue `2`
   */
  maxRetries?: number;
  /**
   * Extra headers sent with every request, login requests included. They can
   * replace the default `Accept` and `User-Agent`, and give way to per-call
   * headers and to the authentication headers.
   */
  headers?: Record<string, string>;
  /**
   * Replaces the platform `fetch`.
   *
   * @defaultValue `globalThis.fetch`
   */
  fetch?: FetchInterface;
  /**
   * Observes every request, response, retry and failure. Called
   * synchronously as each one happens; whatever it throws is ignored, so it
   * cannot fail a request.
   */
  onEvent?: (event: ProxmoxRequestEvent) => void;
}

/**
 * Options for authenticating with a username and password, which yields a
 * ticket that the engine caches and renews.
 */
export interface ProxmoxEngineOptionsPass extends ProxmoxEngineOptionsCommon {
  /**
   * `user@realm`. The realm is required.
   *
   * @defaultValue `"root@pam"`
   */
  username?: string;
  /**
   * The user's password. Must not be empty.
   */
  password: string;
  /**
   * Second factor for accounts that require one: a current TOTP code, or a
   * function returning one. Called on every login that Proxmox answers with
   * a second-factor challenge, so prefer a function for anything that
   * outlives a single ticket. An error it throws reaches the caller of the
   * request unchanged.
   */
  otp?: string | (() => string | Promise<string>);
}

/**
 * Options for authenticating with an API token, which needs no login.
 */
export interface ProxmoxEngineOptionsToken extends ProxmoxEngineOptionsCommon {
  /**
   * `USER@REALM!TOKENNAME`.
   */
  tokenID: string;
  /**
   * The secret Proxmox issued for the token. Sent as it is; only its
   * presence is checked.
   */
  tokenSecret: string;
}

/**
 * Options of {@link ProxmoxEngine} and `proxmoxApi()`: the connection
 * settings plus the credentials for one way of authenticating.
 *
 * A `tokenID` selects token authentication, even next to a `password`.
 */
export type ProxmoxEngineOptions =
  | ProxmoxEngineOptionsToken
  | ProxmoxEngineOptionsPass;

/**
 * The outcome of a password login, cached between requests.
 */
interface Session {
  /**
   * Sent as the `PVEAuthCookie` cookie.
   */
  ticket: string;
  /**
   * Sent with every request that is not a `GET`.
   */
  CSRFPreventionToken: string;
  /**
   * `Date.now()` at the end of the login, which decides when to renew.
   */
  obtainedAt: number;
}

/**
 * One request in flight, with what is needed to explain its failure.
 */
interface Exchange {
  /**
   * The request being made, for the error it may end in.
   */
  request: ProxmoxRequestInfo;
  /**
   * Milliseconds the attempt may take.
   */
  timeout: number;
  /**
   * The caller's own signal, if any.
   */
  signal?: AbortSignal;
  /**
   * Aborted by the timer below when the timeout elapses.
   */
  controller: AbortController;
  /**
   * Enforces the timeout. Whoever began the exchange has to clear it.
   */
  timer: ReturnType<typeof setTimeout>;
  /**
   * Set by the timer, to tell a timeout apart from any other failure.
   */
  timedOut: boolean;
}

/**
 * The JSON object Proxmox wraps its replies in.
 */
interface PveEnvelope {
  /**
   * The payload of a success.
   */
  data?: unknown;
  /**
   * Per-parameter messages of a rejected request.
   */
  errors?: unknown;
  /**
   * The explanation of an error.
   */
  message?: unknown;
}

/**
 * Reports whether a value is an object other than `null` or an array.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Encodes parameters the way the PVE API expects: booleans as 1/0, arrays as
 * the key repeated once per element, null and undefined left out.
 *
 * @param params - The caller's parameters, which are not modified.
 * @returns The encoded pairs, in the order of the parameters. Values other
 *   than booleans are converted to strings.
 */
function encodeParams(
  params: ApiParamType | null | undefined,
): URLSearchParams {
  const encoded = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === null || value === undefined) continue;
    for (const element of Array.isArray(value) ? value : [value]) {
      encoded.append(
        key,
        element === true ? "1" : element === false ? "0" : `${element}`,
      );
    }
  }
  return encoded;
}

/**
 * Waits out the delay before a retry, ending early when the signal aborts.
 *
 * @remarks
 * Never rejects: the caller checks the signal afterwards.
 *
 * @param ms - Milliseconds to wait.
 * @param signal - Ends the wait when it aborts. An abort that happened
 *   before the call goes unnoticed and the full time is waited.
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Computes the delay before a retry: exponential backoff with jitter.
 *
 * @param attempt - Number of the attempt that just failed, starting at 1.
 * @returns Milliseconds between 75% and 100% of a ceiling that is 500 for
 *   the first attempt, doubles with each further one and stops at 8000.
 */
function retryDelay(attempt: number): number {
  const ceiling = Math.min(
    RETRY_MAX_DELAY,
    RETRY_BASE_DELAY * 2 ** (attempt - 1),
  );
  return Math.round(ceiling * (0.75 + Math.random() * 0.25));
}

/**
 * Validates the `host` option and makes it fit for a URL.
 *
 * @param host - The option as given.
 * @returns The host unchanged, or wrapped in brackets when it is a bare
 *   IPv6 address.
 * @throws A {@link ProxmoxConfigError} if the host is empty, contains white
 *   space or one of `/`, `?`, `#`, `@` and `%`, starts with a scheme, or
 *   ends in a port.
 */
function formatHost(host: string): string {
  if (!host || /[/?#@%\s]/.test(host) || /^[a-z]+:\/\//i.test(host)) {
    throw new ProxmoxConfigError(
      `Invalid host ${JSON.stringify(host)}: pass a bare hostname or IP address, and set the port and scheme through the "port" and "schema" options.`,
    );
  }
  const isBareIpv6 = !host.startsWith("[") && host.split(":").length > 2;
  if (!isBareIpv6 && /:\d+$/.test(host)) {
    throw new ProxmoxConfigError(
      `Invalid host ${JSON.stringify(host)}: it contains a port. Pass it through the "port" option instead.`,
    );
  }
  return isBareIpv6 ? `[${host}]` : host;
}

/**
 * The HTTP transport behind `proxmoxApi()`: authentication, encoding, retries
 * and error mapping. Construct it directly to keep hold of the session.
 *
 * @remarks
 * Credentials and the session are held in private fields, so logging or
 * serialising an engine never prints them.
 *
 * One engine serves any number of concurrent requests. With password
 * authentication it logs in when the first request is made, caches the
 * ticket, replaces it once it is an hour old and lets concurrent requests
 * share a single login.
 *
 * @example
 * ```ts
 * const engine = new ProxmoxEngine({
 *   host: "192.0.2.10",
 *   username: "root@pam",
 *   password: process.env.PVE_PASSWORD!,
 * });
 * const proxmox = proxmoxApi(engine);
 *
 * const { ticket, CSRFPreventionToken } = await engine.getTicket();
 * ```
 */
export class ProxmoxEngine implements ApiRequestable {
  /**
   * The origin every request is sent to, e.g. `https://192.0.2.10:8006`.
   */
  readonly origin: string;
  /**
   * Value of the `Authorization` header for token authentication. Unset for
   * password authentication, which is how the two are told apart.
   */
  readonly #authorization?: string;
  /**
   * Login name. Empty with token authentication.
   */
  readonly #username: string;
  /**
   * Login password. Empty with token authentication.
   */
  readonly #password: string;
  readonly #otp?: ProxmoxEngineOptionsPass["otp"];
  /**
   * A copy of the `headers` option.
   */
  readonly #headers: Record<string, string>;
  readonly #authTimeout: number;
  readonly #queryTimeout: number;
  readonly #maxRetries: number;
  readonly #fetch: FetchInterface;
  readonly #onEvent?: (event: ProxmoxRequestEvent) => void;
  /**
   * The cached ticket. Unset until the first login, after
   * {@link ProxmoxEngine.logout} and once Proxmox has rejected it.
   */
  #session?: Session;
  /**
   * The login in flight, shared by every request that needs a session while
   * it runs.
   */
  #pendingLogin?: Promise<Session>;

  /**
   * Validates the options and prepares the transport, without sending
   * anything.
   *
   * @param options - Connection settings and credentials. A `tokenID`
   *   selects token authentication, even next to a `password`.
   * @throws A {@link ProxmoxConfigError} if `schema` is neither `https` nor
   *   `http`, `port` is not an integer from 1 to 65535, `host` is not a bare
   *   hostname or IP address, `tokenID` does not read
   *   `USER@REALM!TOKENNAME`, `tokenSecret` is empty, neither a `tokenID`
   *   nor a `password` is given, or `username` has no realm.
   */
  constructor(options: ProxmoxEngineOptions) {
    const scheme = options.schema ?? "https";
    if (scheme !== "https" && scheme !== "http") {
      throw new ProxmoxConfigError(
        `Invalid schema ${JSON.stringify(scheme)}: expected "https" or "http".`,
      );
    }
    const port = options.port ?? DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ProxmoxConfigError(`Invalid port ${JSON.stringify(port)}.`);
    }
    this.origin = `${scheme}://${formatHost(options.host)}:${port}`;

    if ("tokenID" in options && options.tokenID !== undefined) {
      if (!/^[^@!\s]+@[^@!\s]+![^!\s]+$/.test(options.tokenID)) {
        throw new ProxmoxConfigError(
          'Invalid tokenID: expected the form "USER@REALM!TOKENNAME", for example "root@pam!automation".',
        );
      }
      if (!options.tokenSecret) {
        throw new ProxmoxConfigError("tokenSecret is missing.");
      }
      this.#authorization = `PVEAPIToken=${options.tokenID}=${options.tokenSecret}`;
      this.#username = "";
      this.#password = "";
    } else {
      const {
        username = "root@pam",
        password,
        otp,
      } = options as ProxmoxEngineOptionsPass;
      if (!password) {
        throw new ProxmoxConfigError(
          "No credentials: pass either tokenID and tokenSecret, or password.",
        );
      }
      if (!username.includes("@")) {
        throw new ProxmoxConfigError(
          `Invalid username ${JSON.stringify(username)}: the realm is required, for example "root@pam".`,
        );
      }
      this.#username = username;
      this.#password = password;
      this.#otp = otp;
    }

    this.#authTimeout = options.authTimeout ?? DEFAULT_AUTH_TIMEOUT;
    this.#queryTimeout = options.queryTimeout ?? DEFAULT_QUERY_TIMEOUT;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#headers = { ...options.headers };
    // Bound to globalThis: some runtimes reject the platform `fetch` when it
    // is invoked as a method of another object.
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#onEvent = options.onEvent;
  }

  /**
   * The cached ticket of the last password login.
   *
   * @remarks
   * `undefined` before the first login, after {@link ProxmoxEngine.logout}
   * and with token authentication. Reading it sends nothing and does not
   * renew a ticket that is due; call {@link ProxmoxEngine.getTicket} to log
   * in or renew as needed.
   */
  get ticket(): string | undefined {
    return this.#session?.ticket;
  }

  /**
   * The CSRF token that belongs to {@link ProxmoxEngine.ticket}, which
   * Proxmox demands alongside it for every request that is not a `GET`.
   * `undefined` whenever the ticket is.
   */
  get CSRFPreventionToken(): string | undefined {
    return this.#session?.CSRFPreventionToken;
  }

  /**
   * Drops the cached ticket, so the next request logs in again.
   *
   * @remarks
   * Nothing is sent, so the ticket itself stays valid until Proxmox expires
   * it. A login already in flight is not cancelled, and its ticket is cached
   * when it completes. With token authentication there is nothing to drop.
   */
  logout(): void {
    this.#session = undefined;
  }

  /**
   * Returns the ticket and CSRF token, logging in first when there is none
   * or the cached one is due for renewal.
   *
   * @remarks
   * A cached ticket is returned as long as it is less than an hour old. A
   * login already in flight is joined rather than doubled. A login is
   * bounded by `authTimeout` per request and is not retried.
   *
   * @returns The ticket and the CSRF token that goes with it. Both are
   *   bearer credentials.
   * @throws A {@link ProxmoxConfigError} if the engine authenticates with an
   *   API token, which has no ticket.
   * @throws A {@link ProxmoxAuthenticationError} if Proxmox rejects the
   *   username or password, or asks for a second factor that the `otp`
   *   option does not supply. The latter has `tfaRequired` set.
   * @throws A {@link ProxmoxTimeoutError} if a login request exceeds
   *   `authTimeout`.
   * @throws A {@link ProxmoxConnectionError} if a login request gets no
   *   response.
   * @throws A {@link ProxmoxResponseError} if the reply to a successful
   *   login carries no ticket or cannot be parsed.
   * @throws A {@link ProxmoxApiError} if the login is answered with any
   *   other error status.
   */
  async getTicket(): Promise<{ ticket: string; CSRFPreventionToken: string }> {
    if (this.#authorization) {
      throw new ProxmoxConfigError(
        "This client authenticates with an API token and has no ticket.",
      );
    }
    const { ticket, CSRFPreventionToken } = await this.#ensureSession();
    return { ticket, CSRFPreventionToken };
  }

  /**
   * Sends one API request and returns its decoded reply.
   *
   * @remarks
   * This is the primitive the proxy calls. Parameters travel as a
   * form-encoded body for `POST` and `PUT`, and in the query string for
   * every other method.
   *
   * With password authentication the request first waits for a session,
   * which means a login when there is no ticket or the cached one is due
   * for renewal. Concurrent requests share one login. A request answered
   * with `401` is replayed with a fresh ticket - once, and for any method,
   * since a rejected ticket means the request was never run. With an API
   * token there is no login and a `401` is final.
   *
   * Only a `GET` is retried, up to `maxRetries` times: after a connection
   * error, after a timeout - of the request or of the login it waited for -
   * and after the statuses 408, 429, 502, 503, 504, 595, 596, 597 and 599.
   * The delay is at most half a second before the first retry and doubles
   * with each further one, up to eight seconds. An abort ends it at once.
   *
   * Every attempt has `timeout` milliseconds, counted from the moment it is
   * sent, after any login, until the response body has been read. A body
   * returned as a stream is covered only until the response headers arrive;
   * from then on only `signal` can cancel it.
   *
   * Requests, responses, retries and the final failure are reported to
   * `onEvent`. An error raised by a login names the login request, not this
   * one, as its `request`. An error thrown by an `otp` callback is passed on
   * unchanged and unreported.
   *
   * @param method - HTTP method, in upper or lower case.
   * @param path - Path to request, appended to {@link ProxmoxEngine.origin}
   *   as it is. It has to start with `/` and to be escaped already.
   * @param pathTemplate - The path with `*` in place of each id. Used only to
   *   label errors and events.
   * @param params - Parameters to send. Booleans are sent as `1` and `0`, an
   *   array as its key repeated once per element; `null` and `undefined`
   *   values are left out. The object is not modified.
   * @param options - Per-call overrides of the timeout, the retries and the
   *   headers, and a signal to cancel the request with.
   * @returns The `data` field of a JSON reply, or `null` when it has none.
   *   A reply of type `application/octet-stream` yields the response body
   *   as a `ReadableStream`, and any other type the body as text, or `null`
   *   when it is empty.
   * @throws A {@link ProxmoxAbortError} if `options.signal` is aborted
   *   before the request is sent, or aborts while it waits for a login, is
   *   in flight, or waits for a retry.
   * @throws A {@link ProxmoxTimeoutError} if the request, or the login it
   *   waits for, exceeds its timeout and no retry is left.
   * @throws A {@link ProxmoxConnectionError} if no complete response arrives
   *   and no retry is left.
   * @throws A {@link ProxmoxParameterError} if Proxmox answers `400`.
   * @throws A {@link ProxmoxAuthenticationError} if Proxmox answers `401`:
   *   to an API token, to a ticket for the second time in this call, or to
   *   the login. A login that needs a second factor which the `otp` option
   *   does not supply fails the same way, with `tfaRequired` set.
   * @throws A {@link ProxmoxPermissionError} if Proxmox answers `403`.
   * @throws A {@link ProxmoxApiError} if Proxmox answers with any other
   *   error status. For a status that is retried, this is the answer to the
   *   last attempt.
   * @throws A {@link ProxmoxResponseError} if a success declares a JSON body
   *   that does not parse, or the reply to a login carries no ticket.
   */
  async doRequest(
    method: string,
    path: string,
    pathTemplate: string,
    params?: ApiParamType | null,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const httpMethod = method.toUpperCase();
    const maxRetries =
      httpMethod === "GET" ? (options.maxRetries ?? this.#maxRetries) : 0;
    const timeout = options.timeout ?? this.#queryTimeout;
    const { signal } = options;
    const info: ProxmoxRequestInfo = {
      method: httpMethod,
      path,
      pathTemplate,
      origin: this.origin,
      attempt: 0,
    };
    let renewed = false;

    for (;;) {
      info.attempt++;
      const request = { ...info };
      const started = Date.now();
      let error: ProxmoxError;
      let retryable: boolean;

      try {
        if (signal?.aborted)
          throw new ProxmoxAbortError(request, signal.reason);
        const session = this.#authorization
          ? undefined
          : await this.#sessionFor(signal, request);
        this.#emit({ ...request, type: "request" });

        const exchange = this.#begin(request, timeout, signal);
        let response: Response;
        try {
          response = await this.#send(
            this.#buildRequest(httpMethod, path, params, {
              ...this.#headers,
              ...options.headers,
              ...this.#authHeaders(httpMethod, session),
            }),
            exchange,
          );
          if (response.ok) {
            const data = await this.#readData(response, exchange);
            this.#emit({
              ...request,
              type: "response",
              status: response.status,
              durationMs: Date.now() - started,
            });
            return data;
          }
          error = await this.#readError(response, exchange);
        } finally {
          // Also releases a streamed body from the deadline: once the headers
          // are in, a download is bounded only by the caller's own signal.
          clearTimeout(exchange.timer);
        }

        // A rejected ticket means the request was never run, so replaying it
        // with a fresh one is safe for every method. Once. Only the request
        // that still holds the current ticket discards it: others in flight
        // may get their 401 after a new login has already replaced it.
        if (response.status === 401 && session && !renewed) {
          renewed = true;
          if (this.#session === session) this.#session = undefined;
          info.attempt--;
          continue;
        }
        retryable = RETRYABLE_STATUS.has(response.status);
      } catch (caught) {
        if (!ProxmoxError.isInstance(caught)) throw caught;
        error = caught;
        retryable = caught.code === "connection" || caught.code === "timeout";
      }

      if (retryable && info.attempt <= maxRetries && !signal?.aborted) {
        const delayMs = retryDelay(info.attempt);
        this.#emit({ ...request, type: "retry", delayMs, error });
        await sleep(delayMs, signal);
        continue;
      }
      this.#emit({
        ...request,
        type: "error",
        durationMs: Date.now() - started,
        error,
      });
      throw error;
    }
  }

  /**
   * Reports an event to `onEvent`, when there is one. An observer that
   * throws must not fail the request.
   */
  #emit(event: ProxmoxRequestEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // Deliberately ignored: by now the request may already have run.
    }
  }

  /**
   * Starts the clock for one attempt. The caller clears `timer` when done.
   *
   * @param request - The request being attempted.
   * @param timeout - Milliseconds after which the attempt is aborted and
   *   marked as timed out.
   * @param signal - The caller's own signal, recorded so that a later
   *   failure can be attributed to it.
   * @returns The state of the attempt, with its timer already running.
   */
  #begin(
    request: ProxmoxRequestInfo,
    timeout: number,
    signal: AbortSignal | undefined,
  ): Exchange {
    const exchange: Exchange = {
      request,
      timeout,
      signal,
      controller: new AbortController(),
      timedOut: false,
      timer: setTimeout(() => {
        exchange.timedOut = true;
        exchange.controller.abort();
      }, timeout),
    };
    return exchange;
  }

  /**
   * Builds the URL and `fetch` options of a request, without sending it.
   *
   * @param method - HTTP method in upper case.
   * @param path - Path below the origin.
   * @param params - Parameters, which go into a form-encoded body for `POST`
   *   and `PUT` and into the query string otherwise. Without any, neither a
   *   body nor a `Content-Type` is set.
   * @param headers - Headers to send on top of the default `Accept` and
   *   `User-Agent`, which they can replace.
   * @returns What to call `fetch` with, bar the abort signal.
   */
  #buildRequest(
    method: string,
    path: string,
    params: ApiParamType | null | undefined,
    headers: Record<string, string>,
  ): { url: URL; init: RequestInit } {
    const url = new URL(`${this.origin}${path}`);
    const encoded = encodeParams(params);
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...headers,
      },
    };
    if (encoded.size > 0) {
      if (method === "POST" || method === "PUT") {
        init.body = encoded.toString();
        (init.headers as Record<string, string>)["Content-Type"] =
          "application/x-www-form-urlencoded";
      } else {
        url.search = encoded.toString();
      }
    }
    return { url, init };
  }

  /**
   * Sends one request, turning every way it can fail without a response into
   * a {@link ProxmoxError}.
   *
   * @remarks
   * The fetch is aborted by the exchange's timer or by the caller's signal,
   * whichever comes first.
   *
   * @returns The response as soon as its headers are in, whatever its
   *   status. The body has not been read yet.
   * @throws A {@link ProxmoxError} for an abort, a timeout or a failed
   *   connection if `fetch` rejects.
   */
  async #send(
    { url, init }: { url: URL; init: RequestInit },
    exchange: Exchange,
  ): Promise<Response> {
    const { signal, controller } = exchange;
    try {
      return await this.#fetch(url, {
        ...init,
        signal: signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal,
      });
    } catch (cause) {
      throw this.#transportError(cause, exchange);
    }
  }

  /**
   * Classifies a failure of the connection itself: abort, timeout or other.
   *
   * @param cause - What `fetch` or the body stream failed with.
   * @param exchange - The attempt that failed.
   * @returns A {@link ProxmoxAbortError} when the caller's signal has
   *   aborted, else a {@link ProxmoxTimeoutError} when the timer has fired,
   *   else a {@link ProxmoxConnectionError}. The last one quotes the most
   *   specific message it finds: that of the failure's own `cause`, or else
   *   that of the failure.
   */
  #transportError(cause: unknown, exchange: Exchange): ProxmoxError {
    const { request, signal, timeout } = exchange;
    if (signal?.aborted) return new ProxmoxAbortError(request, cause);
    if (exchange.timedOut) return new ProxmoxTimeoutError(timeout, request);
    const detail =
      (cause as { cause?: { message?: string } })?.cause?.message ??
      (cause as Error)?.message;
    return new ProxmoxConnectionError(
      `${request.method} ${request.path} could not reach ${this.origin}` +
        (detail ? `: ${detail}` : ""),
      { cause, request },
    );
  }

  /**
   * Reads the body as text, which can still fail or time out after the
   * headers.
   *
   * @throws A {@link ProxmoxError} for an abort, a timeout or a failed
   *   connection if the body cannot be read to its end.
   */
  async #readText(response: Response, exchange: Exchange): Promise<string> {
    try {
      return await response.text();
    } catch (cause) {
      throw this.#transportError(cause, exchange);
    }
  }

  /**
   * Decodes the body of a success response by its content type.
   *
   * @returns The body stream, unread, for `application/octet-stream`; the
   *   `data` field of the envelope for `application/json`, or `null` when
   *   it has none; the text for any other type, or `null` when it is empty.
   * @throws A {@link ProxmoxResponseError} if a JSON body does not parse.
   * @throws A {@link ProxmoxError} for an abort, a timeout or a failed
   *   connection if the body cannot be read to its end.
   */
  async #readData(response: Response, exchange: Exchange): Promise<unknown> {
    const { request } = exchange;
    const type = response.headers.get("content-type") ?? "";
    if (type.startsWith("application/octet-stream")) return response.body;

    const text = await this.#readText(response, exchange);
    if (!type.startsWith("application/json")) return text === "" ? null : text;
    try {
      return (JSON.parse(text) as PveEnvelope).data ?? null;
    } catch (cause) {
      throw new ProxmoxResponseError(
        `${request.method} ${request.path} answered ${response.status} with a body that is not valid JSON`,
        response.status,
        { cause, request },
      );
    }
  }

  /**
   * Builds the error for a non-2xx response.
   *
   * @remarks
   * Proxmox reports the reason in the body's `message` since PVE 8.4, and
   * only in the status line before that - which HTTP/2 and most reverse
   * proxies drop - so both are consulted, body first. A body that is not a
   * JSON object serves as the reason when it is at most 500 characters
   * long. With neither a body nor a status text, the reason is
   * `HTTP <status>`.
   *
   * @returns The {@link ProxmoxApiError} subclass matching the status. Its
   *   `body` is the parsed JSON object, or the raw text when the body is
   *   not one, or `undefined` when the body is empty.
   * @throws A {@link ProxmoxError} for an abort, a timeout or a failed
   *   connection if the body cannot be read to its end.
   */
  async #readError(
    response: Response,
    exchange: Exchange,
  ): Promise<ProxmoxError> {
    const { request } = exchange;
    const text = await this.#readText(response, exchange);
    let body: unknown = text === "" ? undefined : text;
    let message: string | undefined;
    let errors: Record<string, string> | undefined;

    if (text.startsWith("{")) {
      try {
        const envelope = JSON.parse(text) as PveEnvelope;
        body = envelope;
        if (typeof envelope.message === "string") {
          message = envelope.message.trim();
        }
        if (isRecord(envelope.errors)) {
          errors = Object.fromEntries(
            Object.entries(envelope.errors).map(([key, value]) => [
              key,
              String(value).trim(),
            ]),
          );
        }
      } catch {
        // Not JSON after all: `body` keeps the raw text, and the reason falls
        // back to the status line.
      }
    } else if (text.length > 0 && text.length <= 500) {
      message = text.trim();
    }

    const details: ProxmoxApiErrorDetails = {
      status: response.status,
      statusText: response.statusText,
      reason: message || response.statusText || `HTTP ${response.status}`,
      errors,
      body,
      request,
    };
    return apiErrorFor(details);
  }

  /**
   * Builds the headers that authenticate a request.
   *
   * @param method - HTTP method in upper case.
   * @param session - The session to present, for password authentication.
   * @returns The `Authorization` header for token authentication. Otherwise
   *   the ticket as a cookie, joined by the CSRF token for every method but
   *   `GET`, or nothing without a session.
   */
  #authHeaders(
    method: string,
    session: Session | undefined,
  ): Record<string, string> {
    if (this.#authorization) return { Authorization: this.#authorization };
    if (!session) return {};
    const headers: Record<string, string> = {
      Cookie: `PVEAuthCookie=${session.ticket}`,
    };
    if (method !== "GET") {
      headers.CSRFPreventionToken = session.CSRFPreventionToken;
    }
    return headers;
  }

  /**
   * Obtains the session for one request. Stops waiting when the caller
   * aborts, while the login itself carries on for whoever else is waiting on
   * it.
   *
   * @param signal - The caller's signal, if any. An abort that happened
   *   before the call goes unnoticed.
   * @param request - The request the session is for, named in the abort
   *   error.
   * @returns The cached session, or the one a login produces.
   * @throws A {@link ProxmoxAbortError} if the signal aborts first.
   */
  #sessionFor(
    signal: AbortSignal | undefined,
    request: ProxmoxRequestInfo,
  ): Promise<Session> {
    const session = this.#ensureSession();
    if (!signal) return session;
    return new Promise((resolve, reject) => {
      const onAbort = () =>
        reject(new ProxmoxAbortError(request, signal.reason));
      signal.addEventListener("abort", onAbort, { once: true });
      session
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  /**
   * Returns the cached session while it is less than an hour old, and the
   * outcome of a login otherwise.
   *
   * @remarks
   * One login at a time: concurrent callers share the request in flight,
   * which is why it is bounded by `authTimeout` alone and not by any one
   * caller's signal.
   */
  #ensureSession(): Promise<Session> {
    const session = this.#session;
    if (session && Date.now() - session.obtainedAt < TICKET_RENEW_AFTER) {
      return Promise.resolve(session);
    }
    this.#pendingLogin ??= this.#login().finally(() => {
      this.#pendingLogin = undefined;
    });
    return this.#pendingLogin;
  }

  /**
   * Logs in with the username and password, answers a second-factor
   * challenge if Proxmox issues one, and caches the resulting session.
   *
   * @remarks
   * The challenge is answered with a second ticket request that sends the
   * code from the `otp` option as a TOTP response, together with the
   * provisional ticket of the first.
   *
   * @returns The new session, which is also stored on the engine.
   * @throws A {@link ProxmoxAuthenticationError} with `tfaRequired` set if a
   *   challenge is issued and the `otp` option yields no code. The errors of
   *   the ticket requests and of an `otp` callback pass through.
   */
  async #login(): Promise<Session> {
    let reply = await this.#requestTicket({
      username: this.#username,
      password: this.#password,
    });
    if (reply.NeedTFA) {
      const otp =
        typeof this.#otp === "function" ? await this.#otp() : this.#otp;
      if (!otp) {
        throw new ProxmoxAuthenticationError(
          {
            status: 401,
            statusText: "two-factor authentication required",
            reason: `${this.#username} requires a second factor: pass the "otp" option, or use an API token`,
            request: this.#loginRequest(),
          },
          true,
        );
      }
      reply = await this.#requestTicket({
        username: this.#username,
        password: `totp:${otp}`,
        "tfa-challenge": reply.ticket,
      });
    }
    this.#session = {
      ticket: reply.ticket,
      CSRFPreventionToken: reply.CSRFPreventionToken,
      obtainedAt: Date.now(),
    };
    return this.#session;
  }

  /**
   * Describes a login request, for the errors it may end in. A login is
   * never retried, so its attempt is always the first.
   */
  #loginRequest(): ProxmoxRequestInfo {
    return {
      method: "POST",
      path: TICKET_PATH,
      pathTemplate: TICKET_PATH,
      origin: this.origin,
      attempt: 1,
    };
  }

  /**
   * Posts one set of login parameters to the ticket endpoint.
   *
   * @remarks
   * The request is bounded by `authTimeout`, carries the client's `headers`
   * and no authentication, cannot be aborted by a caller and is not reported
   * to `onEvent`.
   *
   * @param params - Form fields of the login.
   * @returns The reply's ticket and CSRF token. `NeedTFA` is set when the
   *   ticket is only a challenge for a second factor.
   * @throws A {@link ProxmoxApiError}, or the subclass matching the status,
   *   if Proxmox answers with an error status.
   * @throws A {@link ProxmoxResponseError} if a success carries no ticket
   *   and CSRF token, or a JSON body that does not parse.
   * @throws A {@link ProxmoxTimeoutError} if `authTimeout` runs out before
   *   the response is complete.
   * @throws A {@link ProxmoxConnectionError} if the connection fails before
   *   the response is complete.
   */
  async #requestTicket(params: Record<string, string>): Promise<{
    ticket: string;
    CSRFPreventionToken: string;
    NeedTFA?: unknown;
  }> {
    const request = this.#loginRequest();
    const exchange = this.#begin(request, this.#authTimeout, undefined);
    try {
      const response = await this.#send(
        this.#buildRequest("POST", TICKET_PATH, params, this.#headers),
        exchange,
      );
      if (!response.ok) throw await this.#readError(response, exchange);

      const data = await this.#readData(response, exchange);
      if (
        !isRecord(data) ||
        typeof data.ticket !== "string" ||
        typeof data.CSRFPreventionToken !== "string"
      ) {
        throw new ProxmoxResponseError(
          "The login succeeded but the reply carries no ticket",
          response.status,
          { request },
        );
      }
      return data as { ticket: string; CSRFPreventionToken: string };
    } finally {
      clearTimeout(exchange.timer);
    }
  }
}
