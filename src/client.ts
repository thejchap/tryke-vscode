import * as net from "net";
import { JsonRpcRequest, JsonRpcMessage } from "./types";
import { JsonRpcMessageSchema } from "./schema";
import { log } from "./log";

type NotificationHandler = (params: unknown) => void;

// How long to wait for `socket.end()` to complete a graceful half-close
// before falling back to `destroy()`. The peer should ack the FIN almost
// instantly on a healthy connection; this is a backstop for cases where
// the server is wedged or the network has half-disappeared.
const DISCONNECT_GRACE_MS = 500;

export class TrykeClient {
  private socket: net.Socket | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private notificationHandlers = new Map<string, NotificationHandler[]>();
  private buffer = "";

  async connect(host: string, port: number): Promise<void> {
    const endpoint = `${host}:${port}`;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        this.socket = socket;
        log("client: connected to", endpoint);
        resolve();
      });

      socket.on("error", (err) => {
        if (!this.socket) {
          log("client: connect error to", endpoint, "—", err.message);
          reject(err);
        } else {
          log("client: socket error on", endpoint, "—", err.message);
        }
      });

      socket.on("data", (data: Buffer) => {
        this.buffer += data.toString();
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
      });

      socket.on("close", () => {
        if (this.socket) {
          log("client: connection to", endpoint, "closed with", this.pending.size, "pending request(s)");
        }
        // Reject all pending requests
        for (const [, pending] of this.pending) {
          pending.reject(new Error("Connection closed"));
        }
        this.pending.clear();
        this.socket = undefined;
      });
    });
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.socket) {
      throw new Error("Not connected");
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
      this.socket!.write(JSON.stringify(msg) + "\n");
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

  clearNotificationHandlers(): void {
    this.notificationHandlers.clear();
  }

  disconnect(): void {
    // Reject pending requests up front. The "close" event handler also
    // rejects pending, but disconnect() returns synchronously while close
    // fires asynchronously — without this, an awaiter racing the close
    // event silently hangs forever.
    for (const [, pending] of this.pending) {
      pending.reject(new Error("Client disconnected"));
    }
    this.pending.clear();
    this.notificationHandlers.clear();
    this.buffer = "";

    const socket = this.socket;
    this.socket = undefined;
    if (!socket) {
      return;
    }

    // Half-close so any in-flight write gets flushed; force destroy if
    // the peer doesn't close its side within the grace window.
    socket.end();
    const fallback = setTimeout(() => {
      if (!socket.destroyed) {
        log("client: disconnect grace expired — forcing destroy");
        socket.destroy();
      }
    }, DISCONNECT_GRACE_MS);
    socket.once("close", () => {
      clearTimeout(fallback);
    });
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
