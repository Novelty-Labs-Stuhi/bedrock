#!/usr/bin/env node
// One-off: rewrite `ref::` lines from absolute paths to paths relative to the Bedrock folder.
//
//   node scripts/relative-refs.mjs --base <folder the absolute paths are under> [--dry] <vault>...
//
// `--base` is the folder the CURRENT absolute paths sit under — e.g. ~/Documents when the
// vaults still live there. The result is relative to that folder, which is what a `ref::`
// line should carry once the vaults are moved into (or that folder is made) the Bedrock
// folder: `~/Documents/hugo-backend-v2/Dr Denim/X.md` → `hugo-backend-v2/Dr Denim/X.md`.
// Lines already relative, or pointing outside the base, are left alone. `--dry` only reports.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const baseAt = args.indexOf("--base");
if (baseAt < 0 || !args[baseAt + 1]) {
  console.error("usage: relative-refs.mjs --base <folder> [--dry] <vault>...");
  process.exit(2);
}
const expand = (p) => p.replace(/^~(?=$|\/)/, os.homedir());
const base = path.resolve(expand(args[baseAt + 1]));
const vaults = args.filter((a, i) => !a.startsWith("--") && i !== baseAt + 1).map((v) => path.resolve(expand(v)));
if (!vaults.length) {
  console.error("no vaults given");
  process.exit(2);
}

let files = 0, lines = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.md$/i.test(entry.name)) rewrite(full);
  }
};
const rewrite = (file) => {
  const text = fs.readFileSync(file, "utf8");
  let changed = 0;
  const next = text.replace(/^(ref::[ \t]*)(.+?)[ \t]*$/gm, (line, head, target) => {
    const abs = path.isAbsolute(target) ? target : /^~(?=$|\/)/.test(target) ? expand(target) : null;
    if (!abs) return line; // already relative
    const rel = path.relative(base, path.resolve(abs));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return line; // outside the base: stays absolute
    changed++;
    return `${head}${rel.split(path.sep).join("/")}`;
  });
  if (!changed) return;
  files++;
  lines += changed;
  console.log(`${dry ? "would rewrite" : "rewrote"} ${changed} ref line(s) in ${path.relative(process.cwd(), file) || file}`);
  if (!dry) fs.writeFileSync(file, next);
};
for (const vault of vaults) walk(vault);
console.log(`${dry ? "would change" : "changed"} ${lines} line(s) in ${files} file(s), relative to ${base}`);
