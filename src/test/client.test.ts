import * as assert from "assert";
import * as net from "net";
import { TrykeClient } from "../client";

// Spin up a real loopback TCP server per test so the client exercises its
// actual socket lifecycle (connect → request → disconnect). A mocked socket
// would let bugs in the half-close / pending-rejection ordering slip through.
async function startServer(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        throw new Error("expected an AddressInfo from server.address()");
      }
      resolve({ server, port: addr.port });
    });
  });
}

function stopServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

suite("TrykeClient.disconnect", () => {
  let server: net.Server;
  let port: number;
  let connections: net.Socket[];

  setup(async () => {
    const started = await startServer();
    server = started.server;
    port = started.port;
    connections = [];
    // Track every accepted socket so teardown can destroy them before
    // server.close() — without this, a connection whose read buffer was
    // never drained (no `data` listener) keeps the server's close callback
    // pending and the teardown hits mocha's 2s timeout.
    server.on("connection", (sock) => {
      connections.push(sock);
    });
  });

  teardown(async () => {
    for (const sock of connections) {
      sock.destroy();
    }
    await stopServer(server);
  });

  test("rejects pending requests with a clear error", async () => {
    const client = new TrykeClient();
    // Server accepts via the setup tracker but never replies — the request
    // should be rejected by disconnect(), not hang forever.
    await client.connect("127.0.0.1", port);

    const reqPromise = client.request("never_responds");
    client.disconnect();

    await assert.rejects(reqPromise, /disconnected/i);
  });

  test("rejects every pending request, not just the first", async () => {
    const client = new TrykeClient();
    await client.connect("127.0.0.1", port);

    const a = client.request("a");
    const b = client.request("b");
    const c = client.request("c");
    client.disconnect();

    const results = await Promise.allSettled([a, b, c]);
    for (const r of results) {
      assert.strictEqual(r.status, "rejected");
    }
  });

  test("is idempotent when never connected", () => {
    const client = new TrykeClient();
    client.disconnect();
    client.disconnect();
    // No throw is the assertion.
  });

  test("is safe to call after the server has already closed the socket", async () => {
    const client = new TrykeClient();
    server.on("connection", (sock) => {
      // Close immediately from the server side, simulating a peer that
      // shut down between connect and disconnect.
      sock.end();
    });
    await client.connect("127.0.0.1", port);
    // Give the FIN time to propagate to the client side.
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.disconnect();
  });

  test("flushes a pending write before closing", async () => {
    const client = new TrykeClient();
    let received = "";
    const dataPromise = new Promise<void>((resolve) => {
      server.on("connection", (sock) => {
        sock.on("data", (chunk: Buffer) => {
          received += chunk.toString();
          if (received.includes("\n")) {
            resolve();
          }
        });
      });
    });
    await client.connect("127.0.0.1", port);

    // Fire-and-forget; the request promise will be rejected by disconnect.
    const reqPromise = client.request("flush_me", { hello: "world" });
    client.disconnect();
    await assert.rejects(reqPromise);

    // The "end()" half-close path should have flushed the JSON-RPC frame
    // before the server-side socket saw FIN.
    await dataPromise;
    assert.ok(received.includes('"method":"flush_me"'), `expected flushed frame, got: ${received}`);
  });
});
