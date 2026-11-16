import type { Proxmox } from "./model.js";
import type { ProxmoxEngineOptions } from "./proxmox-engine.js";
import { ProxmoxEngine } from "./proxmox-engine.js";
import type { ApiRequestable } from "./proxy.js";
import { buildApiProxy } from "./proxy.js";

/**
 * Path prefix of the JSON API, under which every request is made.
 */
const BASE_PATH = "/api2/json";

/**
 * Tells a ready-made transport apart from connection options.
 *
 * @param value - The argument given to {@link proxmoxApi}.
 * @returns `true` when `value` has a `doRequest` member, which connection
 *   options never have.
 */
function isRequestable(
  value: ProxmoxEngineOptions | ApiRequestable,
): value is ApiRequestable {
  return "doRequest" in value;
}

/**
 * Builds a typed Proxmox API client.
 *
 * @remarks
 * Building the client sends nothing. The first request goes out when a
 * `$get`, `$post`, `$put` or `$delete` method is called on the result, and
 * with password authentication that request logs in first.
 *
 * @param options - Connection options, from which a new {@link ProxmoxEngine}
 *   is built, or any {@link ApiRequestable} to send requests through instead:
 *   a pre-built {@link ProxmoxEngine} whose session you want to keep, or a
 *   stub for tests.
 * @returns A proxy that turns property access into paths below `/api2/json`
 *   and `$`-prefixed method calls into requests.
 * @throws A {@link ProxmoxConfigError} if connection options are given and
 *   are unusable, for example a malformed `tokenID` or a port in `host`.
 * @example
 * ```ts
 * const proxmox = proxmoxApi({
 *   host: "192.0.2.10",
 *   tokenID: "root@pam!automation",
 *   tokenSecret: "12345678-1234-1234-1234-1234567890ab",
 * });
 *
 * const nodes = await proxmox.nodes.$get();
 * ```
 */
export function proxmoxApi(
  options: ProxmoxEngineOptions | ApiRequestable,
): Proxmox.Api {
  const engine = isRequestable(options) ? options : new ProxmoxEngine(options);
  return buildApiProxy<Proxmox.Api>(engine, BASE_PATH);
}
