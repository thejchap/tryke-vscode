import { Readable, Writable } from "stream";
import { JsonRpcRequest, JsonRpcMessage } from "./types";
import { JsonRpcMessageSchema } from "./schema";
import { log } from "./log";

type NotificationHandler = (params: unknown) => void;

// Speaks newline-delimited JSON-RPC 2.0 over a spawned `tryke server`
// child's stdio, LSP-style: requests and notifications go down the child's
// stdin, responses and broadcast notifications come back on its stdout.
// The transport is a single session per server process — there is no
// reconnect; when the streams close the server is gone.
export class TrykeClient {
  private input: Writable | undefined;
  private output: Readable | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private notificationHandlers = new Map<string, NotificationHandler[]>();
  private buffer = "";
  private readonly onData = (data: Buffer | string): void => this.handleData(data.toString());
  private readonly onEnd = (): void => this.handleClosed("server closed its output");
  private readonly onInputError = (err: Error): void => {
    // Writing to a dead child's stdin emits EPIPE asynchronously; without a
    // listener that crashes the extension host. The output 'end'/'error'
    // path (handleClosed) handles the actual session cleanup.
    log("client: input stream error —", err.message);
  };
  private readonly onOutputError = (err: Error): void => {
    log("client: output stream error —", err.message);
    this.handleClosed(`server output errored: ${err.message}`);
  };

  /**
   * Bind this client to the server child's stdio: `input` is the child's
   * stdin (we write requests to it), `output` is the child's stdout (we
   * read responses and notifications from it).
   */
  attach(input: Writable, output: Readable): void {
    if (this.input || this.output) {
      throw new Error("Client is already attached");
    }
    this.input = input;
    this.output = output;
    input.on("error", this.onInputError);
    output.on("data", this.onData);
    output.on("end", this.onEnd);
    output.on("error", this.onOutputError);
    log("client: attached to server stdio");
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.input) {
      throw new Error("Client is not attached to a server (no stdio session)");
    }

    const id = this.nextId++;
    const msg: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.input!.write(JSON.stringify(msg) + "\n");
    });
  }

  onNotification(method: string, handler: NotificationHandler): void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = [];
      this.notificationHandlers.set(method, handlers);
    }
    handlers.push(handler);
  }

  offNotification(method: string, handler: NotificationHandler): void {
    const handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      return;
    }
    const i = handlers.indexOf(handler);
    if (i !== -1) {
      handlers.splice(i, 1);
    }
    if (handlers.length === 0) {
      this.notificationHandlers.delete(method);
    }
  }

  clearNotificationHandlers(): void {
    this.notificationHandlers.clear();
  }

  /**
   * Tear the session down: reject anything still pending, detach from the
   * streams, and half-close the server's stdin. EOF on stdin is the
   * server's LSP-style shutdown signal, so this is also how the server is
   * asked to exit; `end()` flushes any queued write first.
   */
  disconnect(): void {
    // Reject pending requests up front so awaiters see a synchronous,
    // deterministic failure instead of racing the stream teardown.
    for (const [, pending] of this.pending) {
      pending.reject(new Error("Client disconnected"));
    }
    this.pending.clear();
    this.notificationHandlers.clear();
    this.buffer = "";

    const input = this.input;
    const output = this.output;
    this.input = undefined;
    this.output = undefined;
    if (output) {
      output.off("data", this.onData);
      output.off("end", this.onEnd);
      output.off("error", this.onOutputError);
    }
    if (input && !input.destroyed) {
      // Leave the error listener on: a write queued before disconnect can
      // still surface an async EPIPE after we let go.
      input.end();
    }
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch (err) {
        log("client: skipping malformed JSON line:", err instanceof Error ? err.message : String(err));
        continue;
      }
      const result = JsonRpcMessageSchema.safeParse(raw);
      if (!result.success) {
        log("client: dropping non-RPC message:", result.error.message, "payload:", trimmed.slice(0, 200));
        continue;
      }
      this.handleMessage(result.data);
    }
  }

  private handleClosed(reason: string): void {
    const output = this.output;
    if (!output) {
      return;
    }
    log("client: session closed (" + reason + ") with", this.pending.size, "pending request(s)");
    // Mirror disconnect()'s teardown (minus the input.end() — the peer is
    // already gone): reject pending, drop handlers/buffer, and detach our
    // stream listeners so a dead server doesn't keep this client alive.
    for (const [, pending] of this.pending) {
      pending.reject(new Error("Connection closed"));
    }
    this.pending.clear();
    this.notificationHandlers.clear();
    this.buffer = "";
    output.off("data", this.onData);
    output.off("end", this.onEnd);
    output.off("error", this.onOutputError);
    // Leave the input error listener attached (as disconnect does) so a
    // write already queued on the now-dead pipe can still surface its
    // async EPIPE without crashing the extension host.
    this.input = undefined;
    this.output = undefined;
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if ("id" in msg) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if ("method" in msg) {
      const handlers = this.notificationHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          handler(msg.params);
        }
      }
    }
  }
}
