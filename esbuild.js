// esbuild bundler configuration for the extension.
//
// Two things worth understanding here, since this is a learning project:
//
//  1. `vscode` is provided by the VS Code runtime at load time. It is NOT an npm
//     package we ship, so it MUST be marked `external` or the bundle will fail.
//
//  2. `serialport` contains a native `.node` binary (compiled C++). A bundler
//     cannot inline a native binary into a .js file, so `serialport` is also
//     marked `external`. That means it stays in `node_modules` and gets shipped
//     alongside the bundle. We load it lazily at runtime with `await import(...)`.

const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode", "serialport"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  logLevel: "info",
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("[esbuild] watching for changes...");
  } else {
    await esbuild.build(options);
    console.log("[esbuild] build complete.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
