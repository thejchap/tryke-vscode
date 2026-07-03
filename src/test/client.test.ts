import * as assert from "assert";
import { PassThrough } from "stream";
import { TrykeClient } from "../client";

// Wire the client to a pair of in-memory streams standing in for the
// spawned server child's stdio: `input` is what the server would read on
// its stdin (the client writes requests here), `output` is the server's
// stdout (the test writes responses/notifications here). PassThrough
// preserves real stream semantics — async delivery, 'end' events, flush
// ordering — so lifecycle bugs can't hide behind a synchronous mock.
function attachedClient(): {
  client: TrykeClient;
  input: PassThrough;
  output: PassThrough;
} {
  const client = new TrykeClient();
  const input = new PassThrough();
  const output = new PassThrough();
  client.attach(input, output);
  return { client, input, output };
}

function collect(stream: PassThrough): { data: () => string; ended: () => boolean } {
  let received = "";
  let ended = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    received += chunk;
  });
  stream.on("end", () => {
    ended = true;
  });
  return { data: () => received, ended: () => ended };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

suite("TrykeClient over stdio streams", () => {
  test("resolves a request when the matching response arrives", async () => {
    const { client, output } = attachedClient();

    const reqPromise = client.request("ping");
    output.write('{"jsonrpc":"2.0","id":1,"result":"pong"}\n');

    assert.strictEqual(await reqPromise, "pong");
  });

  test("rejects a request when the server returns an error", async () => {
    const { client, output } = attachedClient();

    const reqPromise = client.request("run");
    output.write('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad params"}}\n');

    await assert.rejects(reqPromise, /bad params/);
  });

  test("dispatches notifications to registered handlers", async () => {
    const { client, output } = attachedClient();
    const seen: unknown[] = [];
    client.onNotification("run_complete", (params) => seen.push(params));

    output.write('{"jsonrpc":"2.0","method":"run_complete","params":{"run_id":"r1"}}\n');
    await tick();

    assert.deepStrictEqual(seen, [{ run_id: "r1" }]);
  });

  test("skips malformed and non-RPC lines without breaking the session", async () => {
    const { client, output } = attachedClient();

    const reqPromise = client.request("ping");
    output.write("not json at all\n");
    output.write('{"some":"junk"}\n');
    output.write('{"jsonrpc":"2.0","id":1,"result":"pong"}\n');

    assert.strictEqual(await reqPromise, "pong");
  });

  test("rejects pending requests when the server closes its output (EOF)", async () => {
    const { client, output } = attachedClient();

    const reqPromise = client.request("never_responds");
    output.end();

    await assert.rejects(reqPromise, /closed/i);
  });
});

suite("TrykeClient.disconnect", () => {
  test("rejects pending requests with a clear error", async () => {
    const { client } = attachedClient();

    const reqPromise = client.request("never_responds");
    client.disconnect();

    await assert.rejects(reqPromise, /disconnected/i);
  });

  test("rejects every pending request, not just the first", async () => {
    const { client } = attachedClient();

    const a = client.request("a");
    const b = client.request("b");
    const c = client.request("c");
    client.disconnect();

    const results = await Promise.allSettled([a, b, c]);
    for (const r of results) {
      assert.strictEqual(r.status, "rejected");
    }
  });

  test("is idempotent when never attached", () => {
    const client = new TrykeClient();
    client.disconnect();
    client.disconnect();
    // No throw is the assertion.
  });

  test("is safe to call after the server has already closed its output", async () => {
    const { client, output } = attachedClient();
    output.end();
    await tick();
    client.disconnect();
  });

  test("half-closes the server's stdin (the shutdown signal), flushing pending writes first", async () => {
    const { client, input } = attachedClient();
    const sink = collect(input);

    // Fire-and-forget; the request promise will be rejected by disconnect.
    const reqPromise = client.request("flush_me", { hello: "world" });
    client.disconnect();
    await assert.rejects(reqPromise);
    await tick();

    assert.ok(
      sink.data().includes('"method":"flush_me"'),
      `expected flushed frame, got: ${sink.data()}`,
    );
    assert.strictEqual(sink.ended(), true, "stdin must see EOF after disconnect");
  });
});
