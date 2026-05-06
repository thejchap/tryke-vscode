import * as assert from "assert";
import {
  parsePidFromLsofOutput,
  parsePidFromNetstatOutput,
} from "../serverManager";

suite("parsePidFromLsofOutput", () => {
  test("parses a single PID line from `lsof -ti`", () => {
    assert.strictEqual(parsePidFromLsofOutput("12345\n"), 12345);
  });

  test("returns null for empty output", () => {
    assert.strictEqual(parsePidFromLsofOutput(""), null);
    assert.strictEqual(parsePidFromLsofOutput("   \n"), null);
  });

  test("returns the first PID when multiple processes hold the port", () => {
    assert.strictEqual(parsePidFromLsofOutput("100\n200\n300\n"), 100);
  });

  test("returns null when the first line isn't a number", () => {
    assert.strictEqual(parsePidFromLsofOutput("not-a-pid\n"), null);
  });

  test("trims surrounding whitespace", () => {
    assert.strictEqual(parsePidFromLsofOutput("  \n42\n  "), 42);
  });
});

suite("parsePidFromNetstatOutput", () => {
  // netstat -ano output sample. We require both the trailing PID and the
  // `:port ` substring on the same line; other ports must not match.
  const sample = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       948
  TCP    0.0.0.0:2337           0.0.0.0:0              LISTENING       12345
  TCP    0.0.0.0:5040           0.0.0.0:0              LISTENING       4096
  TCP    [::]:2337              [::]:0                 LISTENING       12345
`;

  test("returns the PID for the matching port", () => {
    assert.strictEqual(parsePidFromNetstatOutput(sample, 2337), 12345);
  });

  test("returns null when no line matches the port", () => {
    assert.strictEqual(parsePidFromNetstatOutput(sample, 9999), null);
  });

  test("does not match a port that's a substring of another", () => {
    // 040 is a suffix of 5040, but the `:port ` anchor saves us
    assert.strictEqual(parsePidFromNetstatOutput(sample, 40), null);
  });

  test("returns null on empty output", () => {
    assert.strictEqual(parsePidFromNetstatOutput("", 2337), null);
  });

  test("ignores ESTABLISHED rows even on the same port", () => {
    const established =
      "  TCP    0.0.0.0:2337           1.2.3.4:55555         ESTABLISHED     999\n";
    assert.strictEqual(parsePidFromNetstatOutput(established, 2337), null);
  });
});
