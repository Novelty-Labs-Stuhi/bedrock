#!/usr/bin/env node
// Undoes what the branches build (Sep 12, 2026) did to a Bedrock folder, from the backups it left.
//
//   node scripts/unbranch.mjs [--dry] <bedrock folder>
//
// The branches build turned vaults-in-vaults into one graph: every reference note whose target
// was under the folder was removed and the links to it repointed at the note as a full path;
// every vault pointer was removed and the links to it taken out. It kept what it removed or
// rewrote in `.notes/branches-migration-*.json`, one per run. This puts the vaults back:
//
//   1. Removed reference and vault notes come back under their old names. A reference whose
//      target has since moved is repointed at where the note is now; one whose target is gone
//      for good is not restored, and is reported.
//   2. A pointer that was kept as a plain note (its `type::`/`ref::` lines stripped because it
//      carried links of its own) gets its lines back.
//   3. Every full-path link in every note is spelled the way a vault reads it: a note in the
//      same vault by its vault-relative path, a note in another vault by a reference here —
//      an existing one when there is one, a new one otherwise.
//   4. Every `type:: vault` note and every reference to a whole vault goes, with the links
//      to them: a vault is reached through the notes in it, never stood for by a node.
//
// Layouts are not touched: each vault's `.notes/layout.json` still holds its arrangement, and
// a restored reference takes its old place by name. A new reference has none and is placed
// by the app when the vault opens (the bloom).
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const base = path.resolve(args.filter((a) => !a.startsWith("--"))[0] ?? `${process.env.HOME}/Bedrock`);
if (!fs.existsSync(path.join(base, ".notes"))) {
  console.error(`no .notes/ under ${base}`);
  process.exit(1);
}
const NOTES_DIR = ".notes";
const posix = (p) => p.split(path.sep).join("/");
const abs = (rel) => (rel ? path.join(base, ...rel.split("/")) : base);
const exists = (rel) => fs.existsSync(abs(rel));
const isDir = (rel) => exists(rel) && fs.statSync(abs(rel)).isDirectory();
const read = (rel) => fs.readFileSync(abs(rel), "utf8");
const noteName = (rel) => path.posix.basename(rel).replace(/\.md$/i, "");
const changes = []; // [what, rel]
const written = new Map(); // rel → text, so a dry run reads what it would have written
const write = (rel, text, what) => {
  changes.push([what, rel]);
  written.set(rel, text);
  if (dry) return;
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text);
};
const textOf = (rel) => written.get(rel) ?? (exists(rel) ? read(rel) : "");
const present = (rel) => written.has(rel) || exists(rel);

/** Every note under the base, root-relative, dot-folders skipped. */
function walk() {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(abs(dir), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(rel);
      else if (/\.md$/i.test(entry.name)) out.push(rel);
    }
  };
  visit("");
  return out;
}
/** The vault a path belongs to: the innermost folder above it with a .notes/ ('' for the base). */
function vaultOf(rel) {
  let dir = path.posix.dirname(rel);
  if (dir === ".") dir = "";
  while (dir) {
    if (isDir(`${dir}/${NOTES_DIR}`)) return dir;
    dir = path.posix.dirname(dir);
    if (dir === ".") dir = "";
  }
  return "";
}
const field = (text, name) => new RegExp(`^${name}::[ \\t]*(.+?)[ \\t]*$`, "im").exec(text)?.[1] ?? null;
const typeOf = (text) => field(text, "type")?.toLowerCase() ?? null;
/** A `ref::` line back to a root-relative path (null when it points outside the base). */
function refTarget(text) {
  const ref = field(text, "ref");
  if (!ref) return null;
  const full =
    ref.startsWith("/") || ref.startsWith("~")
      ? path.resolve(ref.replace(/^~/, process.env.HOME))
      : path.resolve(base, ...ref.split("/"));
  const rel = posix(path.relative(base, full));
  return rel.startsWith("..") ? null : rel;
}
const LINK_RE = /\[\[([^\]|#]+)((?:#[^\]|]*)?)((?:\|[^\]]*)?)\]\]/g;

// ---------------------------------------------------------------- the backups ---
const backups = fs
  .readdirSync(abs(NOTES_DIR))
  .filter((f) => /^branches-migration-.*\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(read(`${NOTES_DIR}/${f}`)));
if (!backups.length) {
  console.error("no branches-migration-*.json in .notes/ — nothing to undo");
  process.exit(1);
}
const original = new Map(); // path → text as it was before the FIRST run that touched it
const removed = new Set();
for (const b of backups) {
  for (const [p, t] of Object.entries(b.files)) if (!original.has(p)) original.set(p, t);
  for (const p of b.removed) removed.add(p);
}

const notes = walk();
const byName = new Map(); // lower-case name → every note called that
for (const n of notes) {
  const key = noteName(n).toLowerCase();
  byName.set(key, [...(byName.get(key) ?? []), n]);
}
/** Where a note that is not at `rel` any more lives now, if exactly one note is called that. */
function moved(rel) {
  const found = byName.get(noteName(rel).toLowerCase()) ?? [];
  return found.length === 1 ? found[0] : null;
}

// ---------------------------------------------------- 1. removed notes come back ---
const skipped = [];
for (const rel of removed) {
  const text = original.get(rel);
  if (exists(rel)) {
    if (read(rel) !== text) skipped.push([rel, "a note is there now"]); // restored already: nothing to say
    continue;
  }
  const type = typeOf(text);
  // A vault note, or a reference to a whole vault, is not a thing any more (see step 4):
  // it is not brought back, and neither are the links to it.
  if (type === "vault") continue;
  if (type !== "ref") {
    write(rel, text, "restore note");
    continue;
  }
  const target = refTarget(text);
  if (target && isDir(target)) continue;
  if (target && exists(target)) {
    write(rel, text, "restore reference");
    continue;
  }
  const now = target ? moved(target) : null;
  if (!now) {
    skipped.push([rel, `target ${target} is gone`]);
    continue;
  }
  if (vaultOf(now) === vaultOf(rel)) {
    skipped.push([rel, `target now lives in this vault as ${now}`]);
    continue;
  }
  write(rel, text.replace(/^ref::.*$/im, `ref:: ${now}`), `restore reference, repointed at ${now}`);
}

// --------------------------------- 2. pointers kept as plain notes get their lines back ---
for (const [rel, text] of original) {
  if (removed.has(rel) || !exists(rel)) continue;
  const type = typeOf(text);
  if (type !== "ref" || isDir(refTarget(text) ?? "")) continue; // a pointer at a note only — vaults are not a thing
  const current = read(rel);
  if (typeOf(current)) continue; // already carries a type of its own
  const head = ["type", "vault", "ref", "target"]
    .map((f) => (field(text, f) !== null ? `${f}:: ${field(text, f)}` : null))
    .filter(Boolean);
  let block = head.join("\n");
  if (type === "ref") {
    const target = refTarget(text);
    if (!(target && exists(target))) {
      const now = target ? moved(target) : null;
      if (!now) {
        skipped.push([rel, `kept pointer's target ${target} is gone; lines not restored`]);
        continue;
      }
      block = block.replace(/^ref::.*$/m, `ref:: ${now}`);
    }
  }
  write(rel, `${block}\n\n${current.replace(/^\n+/, "")}`, "pointer lines back");
}

// ------------------------------------------ 3. full-path links spelled for the vault ---
const all = [...new Set([...notes, ...written.keys()])];
/** (vault, target) → the reference note in that vault standing for the target. */
const refsIn = new Map();
const refKey = (vault, target) => `${vault} ${target.toLowerCase()}`;
for (const rel of all) {
  const text = textOf(rel);
  if (typeOf(text) !== "ref") continue;
  const target = refTarget(text);
  if (target) refsIn.set(refKey(vaultOf(rel), target), rel);
}
const lookOf = (rel) => {
  const text = textOf(rel);
  const type = typeOf(text);
  return type === "ref" ? field(text, "target") : type;
};
/** The reference note in `vault` for `target` (a note elsewhere), made if there is none. */
function refFor(vault, target) {
  const have = refsIn.get(refKey(vault, target));
  if (have) return have;
  let name = noteName(target);
  let rel = vault ? `${vault}/${name}.md` : `${name}.md`;
  if (present(rel)) {
    name = `${name} (${path.posix.basename(vaultOf(target)) || "Bedrock"})`;
    rel = vault ? `${vault}/${name}.md` : `${name}.md`;
  }
  const look = lookOf(target);
  write(rel, `type:: ref\n\nref:: ${target}\n${look ? `target:: ${look}\n` : ""}`, `new reference for ${target}`);
  refsIn.set(refKey(vault, target), rel);
  return rel;
}
const dangling = [];
for (const rel of all) {
  const text = textOf(rel);
  const vault = vaultOf(rel);
  let touched = 0;
  const next = text.replace(LINK_RE, (whole, rawTarget, heading, alias) => {
    const target = rawTarget.trim();
    if (!target.includes("/")) return whole;
    const targetRel = /\.md$/i.test(target) ? target : `${target}.md`;
    if (!present(targetRel) || isDir(targetRel)) {
      // Not a note under the base as a full path. A vault-relative path with a folder in it is
      // left alone (the vault resolves it); anything that points at nothing is reported.
      const vaultRel = vault ? `${vault}/${targetRel}` : targetRel;
      if (!present(vaultRel)) dangling.push([rel, target]);
      return whole;
    }
    const spelled =
      vaultOf(targetRel) === vault
        ? (vault ? targetRel.slice(vault.length + 1) : targetRel).replace(/\.md$/i, "")
        : noteName(refFor(vault, targetRel));
    touched++;
    return `[[${spelled}${heading}${alias}]]`;
  });
  if (touched) write(rel, next, `${touched} link${touched === 1 ? "" : "s"} respelled`);
}

// ------------------------------------------------------------ 4. vault objects go ---
// A vault is not a thing on a canvas any more: no note stands for a folder, and a reference
// points at a note, never at a whole vault. Every `type:: vault` note and every reference
// whose target is a folder goes; the links to them go with them (a line that held only such
// a link is dropped, an inline one keeps its words). A pointer that carried links of its
// own stays as a plain note with its pointer lines taken out.
const pointers = new Set(); // path → gone, or kept as a plain note
const goneNames = new Map(); // vault → lower-case names of what went, for the unlinking
for (const rel of all) {
  const text = textOf(rel);
  const type = typeOf(text);
  let pointer = type === "vault";
  if (type === "ref") {
    const target = refTarget(text);
    pointer = !!target && isDir(target);
  }
  if (!pointer) continue;
  pointers.add(rel);
  const vault = vaultOf(rel);
  goneNames.set(vault, new Set([...(goneNames.get(vault) ?? []), noteName(rel).toLowerCase()]));
  const hasLinks = [...text.matchAll(LINK_RE)].length > 0;
  if (hasLinks) {
    const stripped = text
      .split("\n")
      .filter((line) => !/^(type|vault|ref|target)::/i.test(line))
      .join("\n")
      .replace(/^\n+/, "");
    write(rel, stripped, "vault pointer kept as a plain note");
    continue;
  }
  changes.push(["vault object removed", rel]);
  written.delete(rel);
  if (!dry) fs.rmSync(abs(rel), { force: true });
}
const removedNow = new Set([...pointers].filter((rel) => !written.has(rel)));
const LINK_LINE_RE = /^\s*(?:[^\[\]]*::\s*)?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]\s*$/;
for (const rel of all) {
  if (removedNow.has(rel)) continue;
  const names = goneNames.get(vaultOf(rel));
  if (!names) continue;
  const text = textOf(rel);
  const goes = (target) => names.has(target.trim().replace(/\.md$/i, "").toLowerCase()) && removedNow.has(`${vaultOf(rel) ? `${vaultOf(rel)}/` : ""}${target.trim().replace(/\.md$/i, "")}.md`);
  let touched = 0;
  const lines = [];
  for (const line of text.split("\n")) {
    const alone = LINK_LINE_RE.exec(line);
    if (alone && goes(alone[1])) {
      touched++;
      if (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
      continue;
    }
    lines.push(
      line.replace(LINK_RE, (whole, rawTarget, heading, alias) => {
        if (!goes(rawTarget)) return whole;
        touched++;
        return alias ? alias.slice(1).trim() : rawTarget.trim();
      }),
    );
  }
  if (touched) write(rel, lines.join("\n").replace(/^\n+/, ""), `${touched} link${touched === 1 ? "" : "s"} to vault objects taken out`);
}

// ------------------------------------------------------------------------- report ---
const kind = (what) => what.replace(/,.*| for .*/, "").replace(/^\d+ /, "");
const counts = {};
for (const [what] of changes) counts[kind(what)] = (counts[kind(what)] ?? 0) + 1;
console.log(dry ? "DRY RUN — nothing written\n" : "");
for (const [what, rel] of changes) console.log(`  ${what.padEnd(56)} ${rel}`);
console.log("\nby kind:", counts);
if (skipped.length) {
  console.log("\nnot restored:");
  for (const [rel, why] of skipped) console.log(`  ${rel} — ${why}`);
}
if (dangling.length) {
  console.log("\nleft as they are (point at nothing):");
  for (const [rel, t] of dangling) console.log(`  ${rel} -> [[${t}]]`);
}
