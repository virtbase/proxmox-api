import { ProxmoxConfigError } from "./errors.js";

/**
 * Parameters for one API call, as declared for the endpoint in `model.ts`.
 */
export type ApiParamType = Record<string, unknown>;

/**
 * Per-call overrides, passed as the second argument of any `$method()`.
 *
 * @remarks
 * The proxy hands them to the transport untouched. The behaviour described
 * here is that of {@link ProxmoxEngine}; another {@link ApiRequestable} has
 * to honour them itself.
 */
export interface RequestOptions {
  /**
   * Cancels the request, including a retry or a login it is waiting on. The
   * call then rejects with a {@link ProxmoxAbortError}.
   */
  signal?: AbortSignal;
  /**
   * Milliseconds before an attempt of this request gives up. Overrides
   * `queryTimeout`.
   */
  timeout?: number;
  /**
   * Retries for this request. Overrides the client's `maxRetries`. Ignored
   * for every method but `GET`, the only one that is ever retried.
   */
  maxRetries?: number;
  /**
   * Extra headers for this request. They win over the client's `headers`
   * but cannot replace the authentication headers.
   */
  headers?: Record<string, string>;
}

/**
 * The transport the proxy calls into.
 *
 * Implement it to send requests somewhere other than a live cluster - a
 * recorded fixture, a queue, a per-tenant router - and hand the result to
 * `proxmoxApi()`.
 */
export interface ApiRequestable {
  /**
   * Performs one API call on behalf of the proxy.
   *
   * @param httpMethod - The method as written after the `$` of the call:
   *   `get`, `post`, `put` or `delete` for the generated methods. The proxy
   *   does not change its case.
   * @param path - The concrete path, placeholders already substituted.
   * @param pathTemplate - The same path with `*` in place of each substituted
   *   value, so calls to one endpoint can be grouped regardless of the ids.
   * @param params - Query or body parameters, as the caller passed them.
   * @param options - Per-call overrides, as the caller passed them.
   * @returns The value the `$method()` call resolves with: for Proxmox, the
   *   content of the response's `data` field.
   */
  doRequest(
    httpMethod: string,
    path: string,
    pathTemplate: string,
    params?: ApiParamType | null,
    options?: RequestOptions,
  ): Promise<unknown>;
}

/**
 * Keys that resolve on the node instead of extending the path.
 *
 * Without these, `String(proxmox)` or a debugger inspecting the object would
 * silently build `/toString` and hand back another proxy.
 */
const OBJECT_KEYS: ReadonlySet<string> = new Set([
  "toJSON",
  "toString",
  "valueOf",
  "toLocaleString",
]);

/**
 * Keys reserved at the root only.
 *
 * A root proxy is the value most likely to be handed to code that sniffs for
 * an EventEmitter - a logger, a test harness - and every one of those probes
 * would otherwise mint a path segment. Deeper nodes are not exposed that way,
 * so they keep these names usable as real segments.
 */
const EVENT_EMITTER_KEYS: ReadonlySet<string> = new Set([
  "addListener",
  "emit",
  "eventNames",
  "getMaxListeners",
  "listenerCount",
  "listeners",
  "off",
  "on",
  "once",
  "prependListener",
  "prependOnceListener",
  "rawListeners",
  "removeAllListeners",
  "removeListener",
  "setMaxListeners",
]);

/**
 * Every key that resolves on the root node instead of extending the path.
 */
const ROOT_KEYS: ReadonlySet<string> = new Set([
  ...OBJECT_KEYS,
  ...EVENT_EMITTER_KEYS,
]);

/**
 * Encodes one value for use as a single path segment.
 *
 * @remarks
 * Everything that could change which endpoint is addressed is neutralised:
 * `/`, `?`, `#`, `\` and `%` are percent-encoded, and the dot segments `.`
 * and `..` - which a URL parser resolves even when percent-encoded - are
 * refused outright, as is an empty value. `:` and `@` are legal inside a
 * segment and stay readable, since UPIDs and user ids are full of them.
 *
 * @param value - A segment name or the value of a path variable. A number is
 *   used in its decimal form.
 * @returns The value encoded as by `encodeURIComponent`, except that `:` and
 *   `@` are left as they are.
 * @throws A {@link ProxmoxConfigError} if the value is empty, `.` or `..`.
 */
function escapeSegment(value: string | number): string {
  const text = String(value);
  if (text === "" || text === "." || text === "..") {
    throw new ProxmoxConfigError(
      `Invalid path value ${JSON.stringify(text)}: it cannot be used as a path segment.`,
    );
  }
  return encodeURIComponent(text).replace(/%3A/g, ":").replace(/%40/g, "@");
}

/**
 * One node of the path being built.
 *
 * Nodes are immutable: navigating produces a new node, so a partially walked
 * path can be held onto and reused.
 */
class ApiNode {
  /**
   * Transport that requests made from this node are sent through.
   */
  readonly engine: ApiRequestable;
  /**
   * The concrete path walked so far.
   */
  readonly path: string;
  /**
   * The same path with `*` for each substituted value, handed to the
   * transport as the path template.
   */
  readonly model: string;

  constructor(engine: ApiRequestable, path: string, model: string) {
    this.engine = engine;
    this.path = path;
    this.model = model;
  }

  /**
   * Describes the node for logs and debuggers.
   *
   * @returns The path in the form `ProxyApi{path:/api2/json/nodes}`.
   */
  toString(): string {
    return `ProxyApi{path:${this.path}}`;
  }

  /**
   * Returns the form `JSON.stringify` serialises.
   *
   * @returns The path alone; the transport is left out.
   */
  toJSON(): { path: string } {
    return { path: this.path };
  }
}

/**
 * Resolves one property access into either a request function or the next
 * node.
 *
 * @remarks
 * The key decides the result:
 *
 * - `$` gives a function that takes the value of a path variable and
 *   returns the child node for it. The value is escaped in the path and
 *   appears as `*` in the template.
 * - Any other key starting with `$` gives a function that sends a request
 *   for the node, with the rest of the key as the method.
 * - Every other key gives the child node for that segment.
 *
 * Children are always created with the non-root handler, so the names
 * reserved at the root are ordinary segments from the first level down.
 *
 * @param node - The node the property was read from.
 * @param key - The property name.
 * @returns A function for a `$` key, the proxy of a child node otherwise.
 * @throws A {@link ProxmoxConfigError} if the key names a segment that is
 *   empty, `.` or `..` once a leading underscore is removed. The function
 *   returned for `$` throws it for such a value.
 */
function navigate(node: ApiNode, key: string): unknown {
  if (key === "$") {
    return (id: string | number) =>
      descend(node, escapeSegment(id), "*", childHandler);
  }

  if (key.startsWith("$")) {
    const httpMethod = key.slice(1);
    return (params?: ApiParamType | null, options?: RequestOptions) =>
      node.engine.doRequest(httpMethod, node.path, node.model, params, options);
  }

  // A leading underscore is the escape hatch for segments that collide with a
  // reserved name: `_on` requests `/on`.
  const segment = escapeSegment(key.startsWith("_") ? key.slice(1) : key);
  return descend(node, segment, segment, childHandler);
}

/**
 * Creates the proxy for a child of a node.
 *
 * @param node - The parent, which is left unchanged.
 * @param pathSegment - Segment to append to the concrete path. It must
 *   already be escaped.
 * @param modelSegment - Segment to append to the path template: the same
 *   segment, or `*` for the value of a path variable.
 * @param handler - Traps for the new proxy.
 * @returns A proxy around the new node.
 */
function descend(
  node: ApiNode,
  pathSegment: string,
  modelSegment: string,
  handler: ProxyHandler<ApiNode>,
): unknown {
  return new Proxy(
    new ApiNode(
      node.engine,
      `${node.path}/${pathSegment}`,
      `${node.model}/${modelSegment}`,
    ),
    handler,
  );
}

/**
 * Creates the traps that make a node navigable.
 *
 * @param reserved - Property names that are read from the node itself. A
 *   name the node does not have reads as `undefined`.
 * @returns A handler that reads symbols and reserved names from the node
 *   and resolves every other property with {@link navigate}.
 */
function createHandler(reserved: ReadonlySet<string>): ProxyHandler<ApiNode> {
  return {
    /**
     * Reads symbols and reserved names from the node itself, and resolves
     * every other property into a request function or a child node.
     */
    get(target, property) {
      if (typeof property === "symbol" || reserved.has(property)) {
        const value = Reflect.get(target, property);
        // Bound to the node, not the proxy. Called on the proxy, `toString`
        // would read `this.path` back through this trap, get another proxy,
        // stringify that, and recurse until the stack ran out.
        return typeof value === "function" ? value.bind(target) : value;
      }
      return navigate(target, property);
    },
  };
}

/**
 * Traps for every node below the root.
 */
const childHandler = createHandler(OBJECT_KEYS);

/**
 * Traps for the root node, which reserves the EventEmitter names as well.
 */
const rootHandler = createHandler(ROOT_KEYS);

/**
 * Builds the proxy that turns property access into API paths.
 *
 * @remarks
 * Nothing is requested while the path is walked - each step returns a new
 * proxy. The call happens when a `$`-prefixed method is invoked, which
 * passes the method name, the path, its template, the parameters and the
 * options to `engine.doRequest()` and returns its result.
 *
 * A plain property appends a segment and `$(value)` appends the value of a
 * path variable. Both throw a {@link ProxmoxConfigError} for a segment that
 * is empty, `.` or `..`. A leading underscore is removed from a property
 * name, which reaches segments that collide with a reserved name: on the
 * root, `on` is `undefined` while `_on` addresses `/on`.
 *
 * @typeParam T - The generated API shape to present, e.g. `Proxmox.Api`. It
 *   is asserted, not checked: the proxy itself accepts any path.
 * @param engine - Transport to send requests through.
 * @param path - Prefix every path is built on, normally `/api2/json`. It is
 *   used as given, without escaping.
 * @returns The root proxy.
 */
export function buildApiProxy<T>(engine: ApiRequestable, path: string): T {
  return new Proxy(new ApiNode(engine, path, path), rootHandler) as T;
}
