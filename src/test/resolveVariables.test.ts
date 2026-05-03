import * as assert from "assert";
import * as os from "os";
import { resolveVariables } from "../resolveVariables";

suite("resolveVariables", () => {
  test("substitutes ${workspaceFolder}", () => {
    const out = resolveVariables(
      "${workspaceFolder}/.venv/bin/python3",
      "/repo",
    );
    assert.strictEqual(out, "/repo/.venv/bin/python3");
  });

  test("leaves ${workspaceFolder} intact when no root is provided", () => {
    // Failing fast (e.g., a missing path) is preferable to silently
    // dropping the prefix.
    const out = resolveVariables("${workspaceFolder}/.venv/bin/python3", undefined);
    assert.strictEqual(out, "${workspaceFolder}/.venv/bin/python3");
  });

  test("substitutes ${userHome}", () => {
    const out = resolveVariables("${userHome}/share/python", "/repo");
    assert.strictEqual(out, `${os.homedir()}/share/python`);
  });

  test("substitutes ${env:VAR} when present", () => {
    process.env.TRYKE_TEST_RESOLVE = "/from/env";
    try {
      assert.strictEqual(
        resolveVariables("${env:TRYKE_TEST_RESOLVE}/python", "/repo"),
        "/from/env/python",
      );
    } finally {
      delete process.env.TRYKE_TEST_RESOLVE;
    }
  });

  test("substitutes ${env:VAR} with empty string when unset", () => {
    delete process.env.TRYKE_TEST_RESOLVE_MISSING;
    assert.strictEqual(
      resolveVariables("${env:TRYKE_TEST_RESOLVE_MISSING}.fallback", "/repo"),
      ".fallback",
    );
  });

  test("leaves unknown variables intact so typos surface as path errors", () => {
    // Substituting empty here would silently produce e.g. `/python3`
    // (an unrelated absolute path) which is confusingly wrong. Keeping
    // the literal yields a clear "no such file" at spawn time.
    const out = resolveVariables("${workspceFolder}/python", "/repo");
    assert.strictEqual(out, "${workspceFolder}/python");
  });

  test("substitutes multiple references in one value", () => {
    process.env.TRYKE_TEST_RESOLVE_MULTI = "venv";
    try {
      assert.strictEqual(
        resolveVariables(
          "${workspaceFolder}/${env:TRYKE_TEST_RESOLVE_MULTI}/bin/python3",
          "/repo",
        ),
        "/repo/venv/bin/python3",
      );
    } finally {
      delete process.env.TRYKE_TEST_RESOLVE_MULTI;
    }
  });

  test("returns plain strings unchanged", () => {
    assert.strictEqual(
      resolveVariables("/usr/bin/python3", "/repo"),
      "/usr/bin/python3",
    );
  });
});
