import * as net from "net";
import { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from "./types";

type NotificationHandler = (params: unknown) => void;

export class TrykeClient {
  private socket: net.Socket | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private notificationHandlers = new Map<string, NotificationHandler[]>();
  private buffer = "";

  async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        this.socket = socket;
        resolve();
      });

      socket.on("error", (err) => {
        if (!this.socket) {
          reject(err);
        }
      });

      socket.on("data", (data: Buffer) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          try {
            this.handleMessage(JSON.parse(trimmed));
          } catch {
            // Skip malformed JSON
          }
        }
      });

      socket.on("close", () => {
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
    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
    }
    this.pending.clear();
    this.notificationHandlers.clear();
    this.buffer = "";
  }

  private handleMessage(msg: JsonRpcResponse | JsonRpcNotification): void {
    if ("id" in msg && msg.id != null) {
      // Response to a request
      const response = msg as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (pending) {
        this.pending.delete(response.id);
        if (response.error) {
          pending.reject(new Error(response.error.message));
        } else {
          pending.resolve(response.result);
        }
      }
    } else if ("method" in msg) {
      // Notification
      const notification = msg as JsonRpcNotification;
      const handlers = this.notificationHandlers.get(notification.method);
      if (handlers) {
        for (const handler of handlers) {
          handler(notification.params);
        }
      }
    }
  }
}
