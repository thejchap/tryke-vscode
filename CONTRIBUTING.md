# Contributing

## Local development

Use Node.js 22, matching CI, and install the locked dependencies:

```bash
npm ci
```

Run the extension from VS Code with the `Run Extension` launch configuration.
The main development checks are:

```bash
npm run lint
npm run typecheck
npm test
```

Build a production bundle and package it as a VSIX with:

```bash
npm run package
```

Generated bundles, test output, dependencies, and VSIX files are ignored by
Git.

## Manual release

Releases are started by pushing a `v*` tag. Before the first release, configure
the repository's `VSCE_PAT` Actions secret with a Visual Studio Marketplace
personal access token that can publish extensions for the `thejchap`
publisher.

1. Start from a clean `main` branch. Confirm that the latest CI run is passing.
2. Run the release helper with the required semantic-version bump:

   ```bash
   scripts/release.sh patch
   ```

   Use `minor` or `major` instead of `patch` when appropriate.

   The helper checks that `package.json` and `package-lock.json` have the same
   version, verifies that local `main` matches `origin/main`, runs the CI
   checks, and converts the current `Unreleased` changelog section into a dated
   release entry.

3. When prompted, review and edit the new entry in `CHANGELOG.md`. Press Enter
   to continue, or Ctrl+C to stop. If you stop, restore the generated heading
   before running the helper again:

   ```bash
   git restore CHANGELOG.md
   ```

4. The helper updates both npm version files, creates a
   `release: v<version>` commit and matching tag, then pushes the commit and
   tag to `origin`.
5. The tag starts the
   [Release workflow](https://github.com/thejchap/tryke-vscode/actions/workflows/release.yml).
   It reruns the release checks, packages `tryke-vscode.vsix`, attaches it to a
   generated GitHub release, and publishes the VSIX to the VS Code Marketplace.
6. Verify that the workflow succeeds and that the new version appears in the
   Marketplace.

Open VSX publishing is documented but disabled in the release workflow.
