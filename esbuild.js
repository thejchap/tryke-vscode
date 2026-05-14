// Bundles the extension into a single dist/extension.js. Without bundling
// we'd have to ship `node_modules/<dep>` for every runtime dep in the .vsix
// — and a missing dep silently breaks activate() (commands show up as "not
// found" because nothing got registered before the require threw).
// Recommended by https://code.visualstudio.com/api/working-with-extensions/bundling-extension
//
// `tsc -p ./` still runs (for type-checking and to emit out/test/**.js
// for vscode-test) but its output is excluded from the .vsix.

const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  // VS Code 1.116 ships Node 20, but pinning to 18 keeps the bundle
  // compatible with the broader engines.vscode range and never emits
  // syntax newer than what the lowest supported Code release can run.
  target: "node18",
  // `vscode` is provided by the host at runtime; bundling it would error
  // (no entry on disk) and is what every official scaffold externalizes.
  external: ["vscode"],
  outfile: "dist/extension.js",
  minify: production,
  sourcemap: !production,
  logLevel: "info",
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
