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

import type { ApiParamType, ApiRequestable } from "./proxy.js";

const USER_AGENT = "proxmox-api (https://github.com/UrielCh/proxmox-api)";

const BASE_HEADERS: Readonly<Record<string, string>> = {
  Accept: "*/*",
  "User-Agent": USER_AGENT,
};

/**
 * Common Proxmox authentification properties
 */
export interface ProxmoxEngineOptionsCommon {
  /**
   * Proxmox address
   * currently used as hostname, so it can not contains a port number.
   */
  host: string;
  /**
   * Proxmox connexion port, default is 8006
   */
  port?: number;
  /**
   * http protocol, can be http or https, default is https
   */
  schema?: "https" | "http";
  /**
   * separated timeout for authentification call, default is 5 second
   */
  authTimeout?: number;
  /**
   * timeout for proxmox request, default is 60 seconds
   */
  queryTimeout?: number;
  /**
   * print the request in curl or fetch format
   */
  debug?: "curl" | "fetch";
}

/**
 * Proxmox authentification as user / password
 */
export interface ProxmoxEngineOptionsPass extends ProxmoxEngineOptionsCommon {
  /**
   * Your username, if not specified will use root@pam
   */
  username?: string;
  /**
   * The password
   */
  password: string;
}

/**
 * Proxmox authentification as tokenID / tokenSecret
 */
export interface ProxmoxEngineOptionsToken extends ProxmoxEngineOptionsCommon {
  tokenID: string;
  tokenSecret: string;
}

/**
 * Shape of a `fetch` implementation accepted by {@link ProxmoxEngine}.
 *
 * Structurally satisfied by the platform `fetch`, so any WHATWG-compatible
 * replacement - a mock, an instrumented wrapper, an agent-bound fetch - can be
 * passed straight through.
 */
export type FetchInterface = (
  url: string | URL,
  options?: RequestInit,
) => Promise<Response>;

/**
 * Type Union for proxmox Authentification options
 */
export type ProxmoxEngineOptions = (
  | ProxmoxEngineOptionsToken
  | ProxmoxEngineOptionsPass
) & { fetch?: FetchInterface };

/**
 * The `{ data, errors }` envelope every PVE endpoint replies with.
 *
 * Untyped here on purpose: the shape of `data` is decided by the endpoint, and
 * `model.ts` types it at the call site. `errors` is a free-form map of
 * per-parameter messages.
 */
interface ProxmoxResponse {
  data: unknown;
  errors?: unknown;
}

/**
 * Own enumerable entries of `params`, minus the null and undefined ones.
 *
 * PVE rejects empty values, and callers routinely pass optional fields
 * through as undefined, so they are dropped rather than serialised.
 */
function definedEntries(params?: ApiParamType): Array<[string, unknown]> {
  if (!params) return [];
  return Object.entries(params).filter(
    ([, value]) => value !== null && value !== undefined,
  );
}

/**
 * Encode one parameter the way the PVE API expects: booleans as 1/0, arrays as
 * the key repeated once per element.
 */
function appendParam(
  target: URLSearchParams,
  key: string,
  value: unknown,
): void {
  if (value === true) {
    target.set(key, "1");
  } else if (value === false) {
    target.set(key, "0");
  } else if (Array.isArray(value)) {
    for (const element of value) target.append(key, `${element}`);
  } else {
    target.set(key, `${value}`);
  }
}

/**
 * Default Proxmox doRequest provider, this Class will be used if you provide Proxmox authentification options to the Proxy generator
 */
export class ProxmoxEngine implements ApiRequestable {
  public CSRFPreventionToken?: string;
  public ticket?: string;
  private readonly username: string;
  private readonly password: string;
  private hostname: string; // was named host
  private port?: number;
  private readonly schema: "http" | "https";
  private authTimeout: number;
  private queryTimeout: number;
  private debug?: "curl" | "fetch";
  private fetch: FetchInterface;

  constructor(options: ProxmoxEngineOptions) {
    // Bound to globalThis: some runtimes reject the platform `fetch` when it
    // is invoked as a method of another object.
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    if ("tokenID" in options && options.tokenSecret) {
      this.username = "";
      this.password = "";
      if (!options.tokenID.match(/.*@.+!.+/)) {
        const msg =
          "invalid tokenID, format should look be like USER@REALM!TOKENID";
        console.error(msg);
        throw Error(msg);
      }
      if (
        !options.tokenSecret.match(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        )
      ) {
        const msg =
          "invalid tokenSecret, format should be an lowercased UUID like 12345678-1234-1234-1234-1234567890ab";
        console.error(msg);
        throw Error(msg);
      }
      // USER@REALM!TOKENID
      this.ticket = `PVEAPIToken=${options.tokenID}=${options.tokenSecret}`;
    } else {
      const optPass = options as ProxmoxEngineOptionsPass;
      this.username = optPass.username || "root@pam";
      this.password = optPass.password;
      if (!this.password) {
        const msg = `password is missing for Proxmox connection`;
        console.error(msg);
        throw Error(msg);
      }
    }
    this.hostname = options.host;
    this.port = options.port;
    this.schema = options.schema || "https";
    this.authTimeout = options.authTimeout || 5000;
    this.queryTimeout = options.queryTimeout || 60000;
    this.debug = options.debug;
  }

  get host(): string {
    if (!this.port) return this.hostname;
    return `${this.hostname}:${this.port}`;
  }

  /**
   *
   * @param method http method GET POST PUT of DELETE
   * @param path http path
   * @param pathTemplate http path without var replacements *
   * @param params query params
   * @param retries retries id
   * @returns data from remote response
   */
  public async doRequest(
    method: string,
    path: string,
    pathTemplate: string,
    params?: ApiParamType,
    retries = 0,
  ): Promise<unknown> {
    const { CSRFPreventionToken, ticket } = await this.getTicket();
    // ensure that method is uppercased
    const httpMethod = method.toUpperCase();

    const headers: Record<string, string> = { ...BASE_HEADERS };
    // auth
    if (!this.username) {
      headers.Authorization = ticket; // PVEAPIToken=USER@REALM!TOKENID=UUID
    } else {
      headers.cookie = `PVEAuthCookie=${ticket}`;
      headers.CSRFPreventionToken = CSRFPreventionToken;
    }

    // proxmox base url
    const requestUrl = new URL(`${this.schema}://${this.host}${path}`);
    let body: string | undefined;

    const entries = definedEntries(params);
    if (entries.length > 0) {
      const sendsBody = httpMethod === "PUT" || httpMethod === "POST";
      const searchParams = sendsBody
        ? new URLSearchParams()
        : requestUrl.searchParams;
      for (const [key, value] of entries) appendParam(searchParams, key, value);
      if (sendsBody) {
        body = searchParams.toString();
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        // `Content-Length` is deliberately left to fetch, which derives it
        // from the body. Upstream set it by hand from `body.length`; that
        // happens to agree here - `URLSearchParams.toString()` percent-encodes
        // to ASCII - but it is a second source of truth for the same fact, and
        // one that silently disagrees the moment the body is transformed.
      }
    }

    const fetchInit: RequestInit = {
      method: httpMethod,
      body,
      headers,
      // Self-clearing, unlike a setTimeout/clearTimeout pair - which leaked a
      // pending timer on every request that threw.
      signal: AbortSignal.timeout(this.queryTimeout),
    };

    let res: Response;
    try {
      res = await this.fetch(requestUrl, fetchInit);
    } catch (e) {
      this.logRequest(httpMethod, requestUrl, fetchInit, headers, {
        ticket,
        CSRFPreventionToken,
      });
      const attempt = retries + 1;
      if (attempt < 2) {
        return this.doRequest(httpMethod, path, pathTemplate, params, attempt);
      }
      // throw Error
      let errMsg = `FaILED to call ${httpMethod} ${requestUrl}`;
      const err = e as { cause?: { message?: string } };
      if (err.cause?.message) errMsg += ` cause by:${err.cause.message}`;
      throw new Error(errMsg, { cause: e });
    }

    const data = await this.readBody(res, httpMethod, requestUrl);

    switch (res.status) {
      case 400:
        throw Error(
          `${httpMethod} ${requestUrl} return Error ${res.status} ${res.statusText}: ${JSON.stringify(data)}`,
        );
      case 500:
        throw Error(
          `${httpMethod} ${requestUrl} return Error ${res.status} ${res.statusText}: ${JSON.stringify(data)}`,
        );
      case 401:
        if (
          res.statusText === "invalid PVE ticket" ||
          res.statusText === "permission denied - invalid PVE ticket"
        ) {
          this.ticket = undefined;
          // A token is not renewable, so do not spend the retry on it.
          let attempt = this.username ? retries : 10;
          attempt++;
          if (attempt < 2)
            return this.doRequest(
              httpMethod,
              path,
              pathTemplate,
              params,
              attempt,
            );
        }
        throw Error(
          `${httpMethod} ${requestUrl} return Error ${res.status} ${res.statusText}: ${JSON.stringify(data)}`,
        );
      case 200:
        return data.data;
      default:
        throw Error(
          `${httpMethod} ${requestUrl} connection failed with ${res.status} ${res.statusText} return: ${JSON.stringify(data)}`,
        );
    }
  }

  /**
   * Decode a response into the PVE `{ data, errors }` envelope.
   */
  private async readBody(
    res: Response,
    method: string,
    requestUrl: URL,
  ): Promise<ProxmoxResponse> {
    const contentType = res.headers.get("content-type");
    const data: ProxmoxResponse = { data: null };

    // PVE answers `application/json;charset=UTF-8`, but match on the media
    // type alone so a proxy that respaces the parameter is still understood.
    if (contentType?.startsWith("application/json")) {
      try {
        return (await res.json()) as ProxmoxResponse;
      } catch {
        data.errors = "Failed to parse response json";
      }
    } else if (contentType === "application/octet-stream") {
      data.data = res.body;
    } else if (!contentType) {
      data.errors = "";
      try {
        data.errors = await res.text();
      } catch {
        // ignore reading error;
      }
    } else {
      // should never append
      throw Error(
        `${method} ${requestUrl} unexpected contentType "${contentType}" status Line:${res.status} ${res.statusText}`,
      );
    }
    return data;
  }

  /**
   * Echo the request that just failed, as a runnable `curl` line or as the
   * `fetch` call that produced it. Only fires when `debug` is set.
   */
  private logRequest(
    method: string,
    requestUrl: URL,
    fetchInit: RequestInit,
    headers: Record<string, string>,
    auth: { ticket: string; CSRFPreventionToken: string },
  ): void {
    if (!this.debug) return;
    if (this.debug === "fetch") {
      console.log(`fetch("${requestUrl}", ${JSON.stringify(fetchInit)})`);
      return;
    }
    const credentials = headers.cookie
      ? `-H "CSRFPreventionToken: ${auth.CSRFPreventionToken}" --cookie ${JSON.stringify(headers.cookie)}`
      : `-H "Authorization: ${auth.ticket}"`;
    const data = fetchInit.body
      ? `--data ${JSON.stringify(fetchInit.body)}`
      : "";
    if (method === "POST") {
      console.log(`curl -v --insecure  ${credentials} ${data} ${requestUrl}`);
    } else if (method === "GET") {
      console.log(`curl -v --insecure ${credentials} ${requestUrl}`);
    } else {
      console.log(`curl -v -X ${method} ${credentials} ${data} ${requestUrl}`);
    }
  }

  /**
   * return the current ticket/token, or create new ones, is previous one had been discared, or missing.
   * @returns Proxmox API ticket and CSRFPreventionToken
   */
  public async getTicket(): Promise<{
    ticket: string;
    CSRFPreventionToken: string;
  }> {
    if (this.ticket) {
      if (!this.username)
        return { ticket: this.ticket, CSRFPreventionToken: "" };
      if (this.CSRFPreventionToken)
        return {
          ticket: this.ticket,
          CSRFPreventionToken: this.CSRFPreventionToken,
        };
    }

    // update ticket endpoint
    const requestUrl = `${this.schema}://${this.host}/api2/json/access/ticket`;

    try {
      const { password, username } = this;
      const body = new URLSearchParams({ username, password }).toString();
      const headers = {
        ...BASE_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
      };
      const r = await this.fetch(requestUrl, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(this.authTimeout),
        body,
      });
      const text = await r.text();
      if (r.status !== 200) {
        throw Error(`login failed with ${r.status}: ${r.statusText} ${text}`);
      }
      const respObj = JSON.parse(text) as {
        data: {
          cap: unknown;
          ticket: string;
          CSRFPreventionToken: string;
          username: string;
        };
      };
      const { CSRFPreventionToken, ticket } = respObj.data;
      this.CSRFPreventionToken = CSRFPreventionToken;
      this.ticket = ticket;
      return { ticket, CSRFPreventionToken };
    } catch (e) {
      throw new Error(`Auth ${requestUrl} Failed!`, { cause: e });
    }
  }
}

export default ProxmoxEngine;
