import type { ApiParamType, ApiRequestable } from "../proxy.js";

export interface RecordedCall {
  method: string;
  path: string;
  pathTemplate: string;
  params?: ApiParamType;
}

/**
 * An {@link ApiRequestable} that records calls and replays queued replies.
 *
 * For tests about what the client *sends*. Tests about the wire format drive a
 * real `http.Server` instead - see `proxmox-engine.test.ts`.
 */
export class RecordingEngine implements ApiRequestable {
  readonly calls: RecordedCall[] = [];
  private readonly replies: unknown[];

  constructor(...replies: unknown[]) {
    this.replies = replies;
  }

  doRequest(
    method: string,
    path: string,
    pathTemplate: string,
    params?: ApiParamType,
  ): Promise<unknown> {
    this.calls.push({ method, path, pathTemplate, params });
    return Promise.resolve(this.replies.shift());
  }

  get last(): RecordedCall {
    const call = this.calls.at(-1);
    if (!call) throw new Error("no calls recorded");
    return call;
  }
}
