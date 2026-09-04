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

import type { Proxmox } from "./model.js";
import type { ProxmoxEngineOptions } from "./proxmox-engine.js";
import { ProxmoxEngine } from "./proxmox-engine.js";
import type { ApiRequestable } from "./proxy.js";
import { buildApiProxy } from "./proxy.js";

/** Every path this client builds hangs off the JSON API root. */
const BASE_PATH = "/api2/json";

function isRequestable(
  value: ProxmoxEngineOptions | ApiRequestable,
): value is ApiRequestable {
  return "doRequest" in value;
}

/**
 * Build a typed Proxmox API client.
 *
 * @param options Connection options, or any {@link ApiRequestable} to send
 *   requests through - a pre-built {@link ProxmoxEngine} whose session you
 *   want to keep, or a stub for tests.
 *
 * @example
 * ```ts
 * const proxmox = proxmoxApi({
 *   host: "192.0.2.10",
 *   port: 8006,
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

export default proxmoxApi;
