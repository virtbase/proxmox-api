import type { ApiParamType, ApiRequestable, RequestOptions } from "../proxy.js";

/**
 * The arguments of one `doRequest()` call, as a {@link RecordingEngine}
 * received them.
 */
export interface RecordedCall {
  /**
   * The method as the proxy passes it: lower case, e.g. `get`.
   */
  method: string;
  path: string;
  pathTemplate: string;
  params?: ApiParamType | null;
  options?: RequestOptions;
}

/**
 * An {@link ApiRequestable} that records calls and replays queued replies.
 *
 * @remarks
 * For tests about what the client *sends*. Tests about the wire format drive a
 * real `http.Server` instead - see `proxmox-engine.test.ts`.
 */
export class RecordingEngine implements ApiRequestable {
  /**
   * Every call made so far, oldest first.
   */
  readonly calls: RecordedCall[] = [];
  /**
   * The replies still to be handed out, next one first.
   */
  private readonly replies: unknown[];

  /**
   * Queues the replies to hand out.
   *
   * @param replies - What successive calls resolve with, one per call. Calls
   *   beyond the last reply resolve with `undefined`.
   */
  constructor(...replies: unknown[]) {
    this.replies = replies;
  }

  /**
   * Records the call and answers it with the next queued reply.
   *
   * @param method - Recorded as given.
   * @param path - Recorded as given.
   * @param pathTemplate - Recorded as given.
   * @param params - Recorded as given, not copied.
   * @param options - Recorded as given, not copied.
   * @returns The next queued reply, or `undefined` once the queue is empty.
   *   The call never fails.
   */
  doRequest(
    method: string,
    path: string,
    pathTemplate: string,
    params?: ApiParamType | null,
    options?: RequestOptions,
  ): Promise<unknown> {
    this.calls.push({ method, path, pathTemplate, params, options });
    return Promise.resolve(this.replies.shift());
  }

  /**
   * The most recent call.
   *
   * @throws An {@link Error} if nothing has been called yet.
   */
  get last(): RecordedCall {
    const call = this.calls.at(-1);
    if (!call) throw new Error("no calls recorded");
    return call;
  }
}
