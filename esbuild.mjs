import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const watch = process.argv.includes("--watch");

// Ensure dist directory exists
if (!existsSync("dist")) mkdirSync("dist");

// Copy WASM binary
copyFileSync(
  join("node_modules", "sql.js", "dist", "sql-wasm.wasm"),
  join("dist", "sql-wasm.wasm")
);

// Copy webview CSS
copyFileSync(
  join("src", "webview", "style.css"),
  join("dist", "webview.css")
);

const shared = {
  bundle: true,
  minify: !watch,
  sourcemap: watch,
};

// Extension bundle (Node.js / CommonJS)
const extCtx = await esbuild.context({
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  external: ["vscode", "sql.js"],
});

// Webview bundle (browser / IIFE)
const webCtx = await esbuild.context({
  ...shared,
  entryPoints: ["src/webview/main.ts"],
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
});

if (watch) {
  await Promise.all([extCtx.watch(), webCtx.watch()]);
  console.log("[sqlity] watching for changes...");
} else {
  await Promise.all([extCtx.rebuild(), webCtx.rebuild()]);
  await Promise.all([extCtx.dispose(), webCtx.dispose()]);
  console.log("[sqlity] build complete.");
}
