# Changelog

All notable changes to the `tryke-vscode` extension are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.0.3] - 2026-04-26

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
