// Proxmox-API Interactive proxmox API for developpers how do not like reading docs
// Copyright (C) 2020-2022  Chemouni Uriel <uchemouni@gmail.com>
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

/**
 * Parameters for one API call.
 *
 * Values are whatever the endpoint declares in `model.ts`; the engine encodes
 * them on the way out.
 */
export type ApiParamType = Record<string, unknown>;

/**
 * The transport the proxy calls into.
 *
 * Implement it to send requests somewhere other than a live cluster - a
 * recorded fixture, a queue, a per-tenant router - and hand the result to
 * {@link buildApiProxy} or `proxmoxApi()`.
 */
export interface ApiRequestable {
  /**
   * Execute one request.
   *
   * @param httpMethod GET, POST, PUT or DELETE.
   * @param path The concrete path, placeholders already substituted.
   * @param pathTemplate The same path with `*` in place of each substituted
   *   value, which makes calls to one endpoint groupable for logging or
   *   metrics regardless of the ids involved.
   * @param params Query or body parameters.
   */
  doRequest(
    httpMethod: string,
    path: string,
    pathTemplate: string,
    params?: ApiParamType,
  ): Promise<unknown>;
}

/**
 * Keys that resolve on the node instead of extending the path.
 *
 * Without these, `String(proxmox)` or a debugger inspecting the object would
 * silently build `/toString` and hand back another proxy.
 */
const OBJECT_KEYS: ReadonlySet<string> = new Set([
  "toString",
  "valueOf",
  "toLocaleString",
]);

/**
 * Reserved at the root only.
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

const ROOT_KEYS: ReadonlySet<string> = new Set([
  ...OBJECT_KEYS,
  ...EVENT_EMITTER_KEYS,
]);

/**
 * Characters that would change the shape of the URL rather than sit inside a
 * path segment. A `/` would invent a path level; `?` and `#` would start a
 * query or fragment and drop the rest of the path.
 */
const UNSAFE_IN_SEGMENT = /[/?#]/g;

function escapeSegment(value: string | number): string {
  return String(value).replace(UNSAFE_IN_SEGMENT, (char) =>
    encodeURIComponent(char),
  );
}

/**
 * One node of the path being built.
 *
 * Nodes are immutable: navigating produces a new node, so a partially walked
 * path can be held onto and reused.
 */
class ApiNode {
  constructor(
    readonly engine: ApiRequestable,
    readonly path: string,
    readonly model: string,
  ) {}

  toString(): string {
    return `ProxyApi{path:${this.path}}`;
  }
}

/**
 * Resolve one property access into either a request function or the next node.
 */
function navigate(node: ApiNode, key: string): unknown {
  if (key === "$") {
    return (id: string | number) =>
      descend(node, escapeSegment(id), "*", childHandler);
  }

  if (key.startsWith("$")) {
    const httpMethod = key.slice(1);
    return (params?: ApiParamType) =>
      node.engine.doRequest(httpMethod, node.path, node.model, params);
  }

  // A leading underscore is the escape hatch for segments that collide with a
  // reserved name: `_on` requests `/on`.
  const segment = key.startsWith("_") ? key.slice(1) : key;
  return descend(node, segment, segment, childHandler);
}

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

function createHandler(reserved: ReadonlySet<string>): ProxyHandler<ApiNode> {
  return {
    // `new proxmox.nodes()` yields the node rather than throwing, which keeps
    // the proxy inert in code that probes values by constructing them.
    construct: (target) => target,
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

const childHandler = createHandler(OBJECT_KEYS);
const rootHandler = createHandler(ROOT_KEYS);

/**
 * Build the proxy that turns property access into API paths.
 *
 * Nothing is requested while the path is walked - each step returns a new
 * proxy. The call happens when a `$`-prefixed method is invoked.
 *
 * @param engine Transport to send requests through.
 * @param path Prefix every path is built on, normally `/api2/json`.
 * @typeParam T The generated API shape to present, e.g. `Proxmox.Api`.
 */
export function buildApiProxy<T>(engine: ApiRequestable, path: string): T {
  return new Proxy(new ApiNode(engine, path, path), rootHandler) as T;
}
