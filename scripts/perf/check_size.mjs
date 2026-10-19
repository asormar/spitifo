#!/usr/bin/env node
// Fails when a build output is over its size budget (scripts/perf/budgets.json).
//
//   node scripts/perf/check_size.mjs bundle frontend/dist
//   node scripts/perf/check_size.mjs installer dist/Spitifo-X.Y.Z-windows-x64-setup.exe
//   node scripts/perf/check_size.mjs apk dist/Spitifo-X.Y.Z-android-arm64.apk
//
// `bundle` adds up every .js and every .css file under the folder (raw bytes:
// what the WebView parses; gzip is printed for reference only). The result also
// goes to the job summary when GITHUB_STEP_SUMMARY is set. No dependencies.

import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const budgets = JSON.parse(readFileSync(new URL("./budgets.json", import.meta.url), "utf8"));
const [kind, target] = process.argv.slice(2);

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]
  );
}

function measure() {
  if (kind === "bundle") {
    const all = files(target);
    return Object.keys(budgets.bundle).map((ext) => {
      const mine = all.filter((f) => f.endsWith(`.${ext}`));
      if (mine.length === 0) throw new Error(`no .${ext} files under ${target}`);
      const bytes = mine.reduce((n, f) => n + statSync(f).size, 0);
      const gzip = mine.reduce((n, f) => n + gzipSync(readFileSync(f), { level: 9 }).length, 0);
      return { name: `${ext.toUpperCase()} bundle (${mine.length} files)`, bytes, gzip, ...budgets.bundle[ext] };
    });
  }
  if (kind === "installer" || kind === "apk") {
    return [{ name: kind === "apk" ? "APK" : "Windows installer", bytes: statSync(target).size, ...budgets[kind] }];
  }
  throw new Error("usage: check_size.mjs bundle|installer|apk <path>");
}

const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
const pct = (n, of) => `${n >= of ? "+" : ""}${(((n - of) / of) * 100).toFixed(1)}%`;

let rows;
try {
  rows = measure();
} catch (e) {
  console.error(`::error::${e.message}`);
  process.exit(2);
}

const lines = ["| Output | Size | vs baseline | Budget | Headroom |", "| --- | --- | --- | --- | --- |"];
let over = false;
for (const r of rows) {
  const ok = r.bytes <= r.budget;
  over ||= !ok;
  const size = `${kb(r.bytes)}${r.gzip ? ` (gzip ${kb(r.gzip)})` : ""}`;
  lines.push(`| ${ok ? "" : "❌ "}${r.name} | ${size} | ${pct(r.bytes, r.baseline)} | ${kb(r.budget)} | ${kb(r.budget - r.bytes)} |`);
  if (!ok) {
    console.log(
      `::error::${r.name} is ${r.bytes} bytes, over its budget of ${r.budget} (scripts/perf/budgets.json, docs/performance.md)`
    );
  }
}
const table = lines.join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n\n`);
process.exit(over ? 1 : 0);
