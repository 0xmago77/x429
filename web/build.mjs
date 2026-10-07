#!/usr/bin/env node
// Builds the static dashboard into site/:
//   web/src/main.ts  -> site/app.js   (esbuild bundle, minified, no sourcemap)
//   web/index.html   -> site/index.html
//   web/style.css    -> site/style.css
//   web/config.json, web/bots.json -> site/ ONLY if site/ does not have them yet
//     (the real ones are written by `setup.ts site-config` after deployment and must not be clobbered).
// Run from anywhere: `node web/build.mjs`.
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(webDir);
const outDir = join(root, "site");

mkdirSync(outDir, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: [join(webDir, "src/main.ts")],
  outfile: join(outDir, "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  charset: "utf8",
  logLevel: "warning",
});

for (const file of ["index.html", "style.css"]) {
  copyFileSync(join(webDir, file), join(outDir, file));
}

const kept = new Set();
for (const file of ["config.json", "bots.json"]) {
  const target = join(outDir, file);
  if (existsSync(target)) kept.add(file);
  else copyFileSync(join(webDir, file), target);
}

console.log(`built ${outDir}`);
for (const file of ["index.html", "app.js", "style.css", "config.json", "bots.json"]) {
  const kb = (statSync(join(outDir, file)).size / 1024).toFixed(1);
  const note = kept.has(file) ? "  (existing file kept)" : "";
  console.log(`  ${file.padEnd(12)} ${kb.padStart(7)} kB${note}`);
}
