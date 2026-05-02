# Changelog

All notable changes to the `tryke-vscode` extension are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.0.5] - 2026-05-02

- Fix: per-case status icons in the gutter for `@t.test.cases(...)` no longer
  collapse onto a single line. Discovery now scans the source for each
  `t.test.case("label", ...)` (typed, kwargs, and tuple-list forms) and
  assigns each case its own range.
- Fix: `with t.describe("Group"):` blocks now show a status icon in the
  gutter. Namespace `TestItem`s gained a URI and a range pinned to the
  matching describe line; multiple describes in one file are
  disambiguated by proximity to the first child test.
- Fix (server mode): single-test runs no longer report "The test run did
  not record any output". The tryke server flushes the run RPC response
  before its `test_complete` and `run_complete` notifications, so we now
  also wait (bounded 2s) for `run_complete` before ending the test run.
- Fix (direct mode): running an individual parametrised case no longer
  errors with `Error: invalid filter expression` — the `[case_label]`
  suffix is stripped before building `-k` since tryke's filter syntax
  rejects brackets. Selected names are also de-duped so multiple cases
  of the same function don't produce a redundant `-k "x or x or x"`.

## [0.0.4] - 2026-04-26

- Add `tryke.server.logLevel` setting (`off` | `error` | `warn` | `info` |
  `debug` | `trace`, default `info`). The selected level is plumbed into the
  server spawn as `RUST_LOG=tryke=<level>`. Restart the server to pick up a
  change.
- Skip the extension-side discovery debounce (300 ms in `controller.ts`) and
  the watch-mode rerun debounce (500 ms in `watchSession.ts`) when the
  resolved mode is `server` — the tryke server already debounces both
  internally and the extra wait just adds latency. Direct mode is unchanged.

## [0.0.3] - 2026-04-26

- Spawn the tryke server with `--root <workspaceRoot>` and `cwd` set to the
  workspace folder. Without this, tryke wrote its discovery cache to the
  extension host's cwd (often `/` on macOS), which is read-only — every
  server restart had to re-discover from scratch and the user saw a
  `Read-only file system (os error 30)` warning in the Tryke Server
  output channel.
- Track the optional `executed_lines` array on failed-test outcomes
  (added in tryke 0.0.24).
- Drop the dead `traceback` field on the `error` outcome variant — tryke
  removed it from the wire format and we were never reading anything but
  the message anyway.
- Consolidate the `runServer` / `runServerWithClient` notification setup
  through one `dispatchRun` helper so the run_id filter logic doesn't
  drift between one-shot and watch-mode flows.

## [0.0.1] - 2026-04-18

Initial release.

- Test Explorer discovery for Tryke tests in workspaces with a `pyproject.toml`.
- Direct, server, and auto runner modes with automatic lifecycle management.
- `Tryke: Start/Stop/Restart Server` commands.
- `Tryke Server` output channel for piped server stdout/stderr.
- `@test.cases` parametrized tests displayed as individual Test Explorer items.
- Watch-mode sessions and `--changed` / `--changed-first` support.
