/**
 * Brand carried by every {@link ProxmoxError}.
 *
 * Registered with `Symbol.for`, so every copy of the package resolves to the
 * same symbol and can recognise errors created by another copy.
 */
const BRAND = Symbol.for("@virtbase/proxmox-api.error");

/**
 * Stable discriminant carried by every error this library throws, for telling
 * failures apart without `instanceof`.
 *
 * @remarks
 * Each code belongs to one error class, with two exceptions:
 * {@link waitForTask} reports its own timeout, and an abort between two
 * status checks, as a plain {@link ProxmoxError} with the code `timeout` or
 * `aborted`.
 */
export type ProxmoxErrorCode =
  | "config"
  | "connection"
  | "timeout"
  | "aborted"
  | "response"
  | "api"
  | "authentication"
  | "permission"
  | "parameter"
  | "task";

/**
 * Identifies the request an error or event belongs to.
 *
 * Carries neither credentials nor parameters, so it is safe to log.
 */
export interface ProxmoxRequestInfo {
  /**
   * HTTP method in upper case, e.g. `GET`.
   */
  method: string;
  /**
   * Concrete path, e.g. `/api2/json/nodes/pve1/qemu/100/config`.
   */
  path: string;
  /**
   * The same path with `*` for each placeholder, for grouping.
   */
  pathTemplate: string;
  /**
   * Origin the request was sent to, e.g. `https://192.0.2.10:8006`.
   */
  origin: string;
  /**
   * 1 for the first try, incremented on each retry. The replay that follows
   * a ticket renewal keeps the number of the attempt it replaces.
   */
  attempt: number;
}

/**
 * Base class of the errors this library throws for unusable input, failed
 * requests and failed tasks; catch it to handle all of them in one place.
 *
 * @remarks
 * Prefer {@link ProxmoxError.isInstance} or the `code` field over `instanceof`
 * when the package might be installed twice: the check is a cross-copy brand
 * rather than class identity.
 *
 * Two kinds of failure are not a `ProxmoxError`: {@link QmMonitor} reports
 * monitor output it cannot use with a plain `Error`, and an error thrown by
 * an `otp` callback reaches the caller unchanged.
 */
export class ProxmoxError extends Error {
  /**
   * The kind of failure. Unlike the class, it can be compared across copies
   * of the package.
   */
  readonly code: ProxmoxErrorCode;
  /**
   * The request that failed. Absent on errors that do not stem from one
   * request: {@link ProxmoxConfigError}, {@link ProxmoxTaskError} and the
   * errors {@link waitForTask} throws when it stops waiting.
   */
  readonly request?: ProxmoxRequestInfo;

  /**
   * Creates an error named after the concrete class being constructed.
   *
   * @param code - Discriminant for the kind of failure.
   * @param message - Human-readable description, fit for a log line.
   * @param options - Context of the failure.
   * @param options.cause - Underlying error, exposed as `cause`. The property
   *   is not set at all when this is `undefined`.
   * @param options.request - The request the failure belongs to.
   */
  constructor(
    code: ProxmoxErrorCode,
    message: string,
    options?: { cause?: unknown; request?: ProxmoxRequestInfo },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = new.target.name;
    this.code = code;
    this.request = options?.request;
    Object.defineProperty(this, BRAND, { value: true });
  }

  /**
   * Reports whether a value is an error thrown by any copy of this library.
   *
   * @param value - Anything, typically the value caught by a `catch` clause.
   * @returns `true` when `value` is an object carrying the library's brand,
   *   including one created by another installed copy of the package, for
   *   which `instanceof` is `false`.
   */
  static isInstance(value: unknown): value is ProxmoxError {
    return typeof value === "object" && value !== null && BRAND in value;
  }

  /**
   * Returns the form `JSON.stringify` serialises, which is safe to log.
   *
   * @returns The `name`, `code`, `message` and `request` of the error. The
   *   `cause` and the stack trace are left out.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      request: this.request,
    };
  }
}

/**
 * Signals input the client cannot work with, detected before any request is
 * sent.
 *
 * @remarks
 * Thrown synchronously by the {@link ProxmoxEngine} constructor for unusable
 * options, by the path proxy for a path value that is empty, `.` or `..`,
 * and by {@link parseUpid} for a string that is not a task identifier.
 * {@link ProxmoxEngine.getTicket} and {@link waitForTask} reject with it, for
 * a client that uses an API token and for a malformed identifier
 * respectively. It never has a `request`.
 */
export class ProxmoxConfigError extends ProxmoxError {
  constructor(message: string) {
    super("config", message);
  }
}

/**
 * Signals that the connection failed before a complete response arrived: a
 * DNS failure, a refused connection, a TLS rejection or a reset.
 *
 * @remarks
 * The underlying error is on `cause`. A connection that breaks while the
 * response body is being read is reported the same way. Whether Proxmox
 * carried the request out is unknown, which is why only `GET` requests are
 * retried after it.
 */
export class ProxmoxConnectionError extends ProxmoxError {
  /**
   * Creates a connection error.
   *
   * @param message - Human-readable description, fit for a log line.
   * @param options - Context of the failure.
   * @param options.cause - The error `fetch` or the body stream failed with.
   * @param options.request - The request that got no response.
   * @param code - Discriminant to report. Subclasses pass their own; it is
   *   `connection` when omitted.
   */
  constructor(
    message: string,
    options: { cause?: unknown; request?: ProxmoxRequestInfo },
    code: "connection" | "timeout" = "connection",
  ) {
    super(code, message, options);
  }
}

/**
 * Signals that a request exceeded its timeout before its response arrived.
 *
 * @remarks
 * The limit is `authTimeout` for a login request, and `queryTimeout` or the
 * per-call `timeout` for any other. It covers a single attempt up to the end
 * of the response body, or up to the response headers when the body is
 * handed back as a stream. As with any {@link ProxmoxConnectionError}, the
 * request may still have been carried out.
 */
export class ProxmoxTimeoutError extends ProxmoxConnectionError {
  /**
   * The limit that was exceeded, in milliseconds.
   */
  readonly timeout: number;

  /**
   * Creates a timeout error whose message names the request and the limit.
   *
   * @param timeout - The limit that was exceeded, in milliseconds.
   * @param request - The request that timed out.
   */
  constructor(timeout: number, request: ProxmoxRequestInfo) {
    super(
      `${request.method} ${request.path} timed out after ${timeout} ms`,
      { request },
      "timeout",
    );
    this.timeout = timeout;
  }
}

/**
 * Signals that the caller's own `AbortSignal` cancelled a request, whether it
 * was waiting for a login, in flight, or waiting to be retried.
 */
export class ProxmoxAbortError extends ProxmoxError {
  /**
   * Creates an abort error whose message names the request.
   *
   * @param request - The request that was cancelled.
   * @param cause - What the abort surfaced as: the signal's `reason`, or the
   *   error `fetch` rejected with when the request was already in flight.
   */
  constructor(request: ProxmoxRequestInfo, cause?: unknown) {
    super("aborted", `${request.method} ${request.path} was aborted`, {
      cause,
      request,
    });
  }
}

/**
 * Signals a response that arrived but could not be understood: a success
 * whose JSON body does not parse, or a login reply that carries no ticket.
 */
export class ProxmoxResponseError extends ProxmoxError {
  /**
   * HTTP status of the response, which is a success status.
   */
  readonly status: number;

  /**
   * Creates a response error.
   *
   * @param message - Human-readable description, fit for a log line.
   * @param status - HTTP status of the response.
   * @param options - Context of the failure.
   * @param options.cause - The error that decoding the body failed with.
   * @param options.request - The request the response answers.
   */
  constructor(
    message: string,
    status: number,
    options: { cause?: unknown; request?: ProxmoxRequestInfo },
  ) {
    super("response", message, options);
    this.status = status;
  }
}

/**
 * Describes an error response, as needed to construct a
 * {@link ProxmoxApiError}.
 */
export interface ProxmoxApiErrorDetails {
  /**
   * HTTP status of the response.
   */
  status: number;
  /**
   * Text of the status line. Empty when HTTP/2 or a reverse proxy dropped it.
   */
  statusText: string;
  /**
   * Proxmox's own explanation, from the body or the status line.
   */
  reason: string;
  /**
   * Per-parameter messages, when Proxmox rejected specific parameters.
   */
  errors?: Record<string, string>;
  /**
   * The decoded response body, when there was one.
   */
  body?: unknown;
  /**
   * The request that was answered with the error.
   */
  request: ProxmoxRequestInfo;
}

/**
 * Builds the message of an API error.
 *
 * @param details - The error response to describe.
 * @returns `<method> <path> failed: <status> <reason>`, followed by the
 *   per-parameter messages in parentheses when there are any.
 */
function describe(details: ProxmoxApiErrorDetails): string {
  const { request, status, reason, errors } = details;
  const fields = Object.entries(errors ?? {})
    .map(([name, problem]) => `${name}: ${problem}`)
    .join("; ");
  return (
    `${request.method} ${request.path} failed: ${status} ${reason}` +
    (fields ? ` (${fields})` : "")
  );
}

/**
 * Signals that Proxmox answered with an error status.
 *
 * @remarks
 * `status` and `reason` say what went wrong; `errors` names the offending
 * parameters when there are any. Statuses `400`, `401` and `403` are thrown
 * as the subclasses {@link ProxmoxParameterError},
 * {@link ProxmoxAuthenticationError} and {@link ProxmoxPermissionError};
 * every other status is thrown as this class with the code `api`.
 */
export class ProxmoxApiError extends ProxmoxError {
  /**
   * HTTP status of the response.
   */
  readonly status: number;
  /**
   * Text of the status line. Empty when HTTP/2 or a reverse proxy dropped it.
   */
  readonly statusText: string;
  /**
   * Proxmox's own explanation, from the body or the status line.
   */
  readonly reason: string;
  /**
   * Per-parameter messages, keyed by parameter name. Empty when Proxmox
   * blamed no specific parameter.
   */
  readonly errors: Record<string, string>;
  /**
   * The decoded response body, or `undefined` when there was none.
   */
  readonly body: unknown;
  /**
   * The request that was answered with the error. Always present.
   */
  declare readonly request: ProxmoxRequestInfo;

  /**
   * Creates an API error whose message names the request, the status, the
   * reason and any rejected parameters.
   *
   * @param details - The error response.
   * @param code - Discriminant to report. Subclasses pass their own; it is
   *   `api` when omitted.
   */
  constructor(details: ProxmoxApiErrorDetails, code: ProxmoxErrorCode = "api") {
    super(code, describe(details), { request: details.request });
    this.status = details.status;
    this.statusText = details.statusText;
    this.reason = details.reason;
    this.errors = details.errors ?? {};
    this.body = details.body;
  }

  /**
   * Returns the form `JSON.stringify` serialises, which is safe to log.
   *
   * @returns The fields of {@link ProxmoxError.toJSON} plus `status`,
   *   `reason` and `errors`. The `statusText` and the `body` are left out.
   */
  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      status: this.status,
      reason: this.reason,
      errors: this.errors,
    };
  }
}

/**
 * Signals a `401`: the credentials were rejected.
 *
 * @remarks
 * The cause is a wrong password, an unknown or revoked token, an expired
 * ticket that could not be renewed, or a login that needs a second factor
 * (`tfaRequired`).
 */
export class ProxmoxAuthenticationError extends ProxmoxApiError {
  /**
   * `true` when a password login was answered with a second-factor challenge
   * and no `otp` was available to answer it. The client raises this case
   * itself, with the status `401`, as Proxmox does not answer the challenge
   * with an error status.
   */
  readonly tfaRequired: boolean;

  /**
   * Creates an authentication error.
   *
   * @param details - The error response.
   * @param tfaRequired - Whether the login failed for want of a second
   *   factor. `false` when omitted.
   */
  constructor(details: ProxmoxApiErrorDetails, tfaRequired = false) {
    super(details, "authentication");
    this.tfaRequired = tfaRequired;
  }
}

/**
 * Signals a `403`: the caller is authenticated but not allowed, because of a
 * missing privilege or an API token used on an endpoint that only accepts a
 * ticket.
 */
export class ProxmoxPermissionError extends ProxmoxApiError {
  constructor(details: ProxmoxApiErrorDetails) {
    super(details, "permission");
  }
}

/**
 * Signals a `400`: Proxmox rejected one or more parameters, which `errors`
 * names.
 */
export class ProxmoxParameterError extends ProxmoxApiError {
  constructor(details: ProxmoxApiErrorDetails) {
    super(details, "parameter");
  }
}

/**
 * Picks the error class that matches a response status.
 *
 * @param details - The error response.
 * @returns A {@link ProxmoxParameterError} for `400`, a
 *   {@link ProxmoxAuthenticationError} for `401`, a
 *   {@link ProxmoxPermissionError} for `403` and a plain
 *   {@link ProxmoxApiError} for every other status.
 */
export function apiErrorFor(details: ProxmoxApiErrorDetails): ProxmoxApiError {
  switch (details.status) {
    case 400:
      return new ProxmoxParameterError(details);
    case 401:
      return new ProxmoxAuthenticationError(details);
    case 403:
      return new ProxmoxPermissionError(details);
    default:
      return new ProxmoxApiError(details);
  }
}

/**
 * Signals that a background task ran to completion and reported failure;
 * thrown by {@link waitForTask}.
 *
 * @remarks
 * The request that started the task succeeded - Proxmox answers with a UPID
 * and does the work in the background - so this is the only place the
 * failure surfaces. The error has no `request`.
 */
export class ProxmoxTaskError extends ProxmoxError {
  /**
   * Identifier of the task that failed.
   */
  readonly upid: string;
  /**
   * Proxmox's exit status: the error text, `WARNINGS: <n>` when warnings
   * were to count as failure, or `unknown` when the task stopped without
   * reporting one.
   */
  readonly exitstatus: string;

  /**
   * Creates a task error whose message names the task and its exit status.
   *
   * @param upid - Identifier of the task that failed.
   * @param exitstatus - The exit status the task reported.
   */
  constructor(upid: string, exitstatus: string) {
    super("task", `Task ${upid} failed: ${exitstatus}`);
    this.upid = upid;
    this.exitstatus = exitstatus;
  }

  /**
   * Returns the form `JSON.stringify` serialises, which is safe to log.
   *
   * @returns The fields of {@link ProxmoxError.toJSON} plus `upid` and
   *   `exitstatus`.
   */
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), upid: this.upid, exitstatus: this.exitstatus };
  }
}
