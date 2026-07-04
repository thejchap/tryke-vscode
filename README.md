# Tryke for VS Code

VS Code integration for [Tryke](https://github.com/thejchap/tryke) — a fast Rust-powered test runner for Python.

<img alt="Screenshot 2026-07-04 at 15 54 25" src="https://github.com/user-attachments/assets/d5190728-4864-453c-8031-d6e7029150cd" />





Tests show up in the native VS Code Test Explorer. Run, debug, and watch tests with inline pass/fail gutter decorations and per-assertion diagnostics routed through Tryke's JSON event stream.

## Requirements

- [Tryke](https://pypi.org/project/tryke/) installed and on `PATH` (or set `tryke.command` to its full path).
- A workspace containing a `pyproject.toml`.

Install Tryke with your package manager of choice:

```bash
uv add --dev tryke
# or
pip install tryke
```

See the [Tryke docs](https://thejchap.github.io/tryke/) for writing tests.

## Features

- **Test Explorer integration** — discover, run, and debug Tryke tests from the VS Code sidebar.
- **`@test.cases` parametrized tests** — each case (`square[zero]`, `square[one]`, …) appears as its own item with full fidelity.
- **Server mode** — EXPERIMENTAL - IDE communicates with Tryke over an LSP-style client/server connection.
- **Direct mode** — spawns `tryke test` per run.
- **Watch mode session** — streams results from `tryke` as files change.
- **Changed-files runs** — optionally limit runs to tests affected by your git diff.
- **Dedicated output channels** — `Tryke` for extension activity, `Tryke Server` for piped server logs (stderr; stdout carries the RPC session).

## Commands

| Command | ID |
| --- | --- |
| Tryke: Start Server | `tryke.startServer` |
| Tryke: Stop Server | `tryke.stopServer` |
| Tryke: Restart Server | `tryke.restartServer` |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `tryke.command` | `tryke` | Path to the `tryke` executable. |
| `tryke.python` | `null` | Python interpreter for spawned workers, passed as `--python` (requires tryke ≥ 0.0.26). Supports VS Code variables: `${workspaceFolder}`, `${workspaceFolder:NAME}`, `${userHome}`, `${env:VAR}`. Example: `${workspaceFolder}/.venv/bin/python3` (Unix) or `${workspaceFolder}/.venv/Scripts/python.exe` (Windows). When unset, tryke uses bare `python`/`python3` from `PATH`, which usually fails unless your venv is active in the spawning environment. Alternatively set `[tool.tryke] python` in `pyproject.toml`. |
| `tryke.mode` | `direct` | Runner mode: `direct` spawns a process per run. `server` is EXPERIMENTAL - IDE communicates with Tryke over an LSP-style client/server connection. |
| `tryke.server.logLevel` | `info` | Maps to `TRYKE_LOG=<level>` on the server child env. Surfaces both rust and python worker logs in the Tryke Server output panel on tryke versions that honor `TRYKE_LOG` (the release after 0.0.26); ignored on earlier versions. |
| `tryke.workers` | `null` | Number of worker processes. Passed as `-j` in direct mode and `--workers` in server mode. |
| `tryke.failFast` | `false` | Stop after the first failure (`--fail-fast`). |
| `tryke.maxfail` | `null` | Stop after N failures (`--maxfail`). |
| `tryke.dist` | `null` | Work distribution (`test`, `file`, `group`). |
| `tryke.markers` | `null` | Tag/marker filter (`-m`). |
| `tryke.changed` | `off` | Run only `--changed` tests, `--changed-first`, or `off`. |
| `tryke.baseBranch` | `null` | Base branch for changed-file detection. |
| `tryke.args` | `[]` | Extra arguments forwarded to `tryke`. |

## Related

- [thejchap/tryke](https://github.com/thejchap/tryke) — the test runner itself.
- [thejchap/neotest-tryke](https://github.com/thejchap/neotest-tryke) — the Neovim integration.

## License

[MIT](LICENSE)
