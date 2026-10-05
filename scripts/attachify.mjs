#!/usr/bin/env node
// Copies a vault of typed notes into a vault of attachments, leaving the original alone.
//
//   node scripts/attachify.mjs [--dry] <vault> [<copy>]
//   node scripts/attachify.mjs [--dry] --in-place <folder>
//
// `<copy>` defaults to "<vault> (attachments)" beside it, and must not exist yet. With
// `--in-place`, every vault under `<folder>` (the folder itself included, when it is one) is
// converted where it stands — commit the folder to git first; that is the way back. In the copy:
//
//   1. Every typed note stays a note — same name, same place on the canvas, same links and
//      prose — and the thing it stood for (a Notion page, a Claude session, a webpage…)
//      becomes its one attachment: the type's own lines move into
//      `.notes/attachments/<name>.md`, and the note gets an `attach:: <name>` line.
//   2. References (`type:: ref`) and Linear issues are copied as they are: a reference
//      already shows the note it stands for with that note's attachments, and an issue is a
//      checklist on the canvas, not something that rides on a note.
//   3. `.notes/` comes along whole — the arrangement (`layout.json`), the connection notes,
//      the config, which gains `"mode": "attachments"`.
//
// A vault nested inside is not copied: it is a vault of its own, converted on its own.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const inPlace = args.includes("--in-place");
const [from, to] = args.filter((a) => !a.startsWith("--"));
if (!from) {
  console.error("usage: node scripts/attachify.mjs [--dry] <vault> [<copy>]\n       node scripts/attachify.mjs [--dry] --in-place <folder>");
  process.exit(1);
}

/** The lines each type keeps about its thing — what moves into the attachment. */
const FIELDS = {
  antigravity: ["conversation", "folder"],
  claude: ["session", "folder", "started", "seen"],
  file: ["path"],
  folder: ["path"],
  web: ["url"],
  freeform: ["board"],
  notion: ["page"],
  slack: ["thread"],
  gtask: ["task", "url", "done"],
  applenote: ["note"],
  granola: ["meeting", "url", "date"],
  word: ["doc"],
};

const TYPE_RE = /^type::[ \t]*([\w-]+)[ \t]*$/im;
const fieldRe = (name) => new RegExp(`^[ \\t]*${name}::[ \\t]*(.*?)[ \\t]*$`, "i");
const URL_RE = /https?:\/\/[^\s)\]>]+/;

/** A note split in two: what stays on the note, and the attachment's own text. */
function split(text, type, name) {
  const keep = FIELDS[type];
  const lines = text.split("\n");
  const moved = [];
  const stay = [];
  for (const line of lines) {
    if (/^type::/i.test(line.trim())) continue;
    const field = keep.find((key) => fieldRe(key).test(line));
    // Only the first of each: a second `url::` further down is somebody's prose.
    if (field && !moved.some((m) => m.key === field)) moved.push({ key: field, value: fieldRe(field).exec(line)[1] });
    else stay.push(line);
  }
  // A webpage note could carry its address as a bare link rather than a `url::` line.
  if (type === "web" && !moved.some((m) => m.key === "url")) {
    const bare = URL_RE.exec(text)?.[0];
    if (bare) moved.push({ key: "url", value: bare });
  }
  const att = `type:: ${type}\n\n${moved.map((m) => `${m.key}:: ${m.value}`).join("\n")}\ntitle:: ${name}\n`;
  const body = stay.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\s+$/, "");
  return { att, body };
}

/** Converts the vault at `src` into `dest` — a new folder, or `src` itself. */
function convert(src, dest) {
  const nested = (dir) => dir !== src && fs.existsSync(path.join(dir, ".notes"));

  const copies = []; // [from, to] for every file that is copied as it is
  const notes = []; // every markdown note outside .notes/, relative to the vault
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(src, full);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || nested(full)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (/\.md$/i.test(entry.name) && !rel.split(path.sep).some((part) => part.startsWith("."))) notes.push(rel);
        else copies.push(rel);
      }
    }
  })(src);

  const writes = new Map(); // rel -> text
  const attDir = path.join(src, ".notes", "attachments");
  const taken = new Set(
    fs.existsSync(attDir) ? fs.readdirSync(attDir).map((name) => name.replace(/\.md$/i, "").toLowerCase()) : [],
  );
  const report = [];
  for (const rel of notes) {
    const text = fs.readFileSync(path.join(src, rel), "utf8");
    const type = TYPE_RE.exec(text)?.[1].toLowerCase();
    if (!type || !FIELDS[type]) {
      writes.set(rel, text);
      continue;
    }
    const name = path.basename(rel, path.extname(rel));
    let attName = name;
    for (let n = 2; taken.has(attName.toLowerCase()); n++) attName = `${name} ${n}`;
    taken.add(attName.toLowerCase());
    const { att, body } = split(text, type, name);
    writes.set(path.join(".notes", "attachments", `${attName}.md`), att);
    writes.set(rel, `${body ? `${body}\n\n` : ""}attach:: ${attName}\n`);
    report.push(`${rel}  →  plain note + ${type} attachment`);
  }

  const configRel = path.join(".notes", "config.json");
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(src, configRel), "utf8"));
  } catch {
    /* no config, or a broken one: the copy starts from the folder's */
  }
  config = { version: config.version ?? 4, mode: "attachments", ...config };
  config.mode = "attachments";

  console.log(`${src}\n  → ${dest}${dry ? "   (dry run — nothing written)" : ""}\n`);
  for (const line of report) console.log(`  ${line}`);
  console.log(`\n  ${report.length} typed note(s) converted, ${notes.length - report.length} note(s) copied as they are, ${copies.length} other file(s) copied`);
  if (dry) return;

  for (const rel of copies) {
    if (rel === configRel) continue;
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(path.join(src, rel), path.join(dest, rel));
  }
  for (const [rel, text] of writes) {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.writeFileSync(path.join(dest, rel), text);
  }
  fs.mkdirSync(path.join(dest, ".notes"), { recursive: true });
  fs.writeFileSync(path.join(dest, configRel), JSON.stringify(config, null, 1) + "\n");
}

if (inPlace) {
  const base = path.resolve(from);
  const vaults = [];
  (function find(dir) {
    if (fs.existsSync(path.join(dir, ".notes"))) vaults.push(dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) find(path.join(dir, entry.name));
    }
  })(base);
  for (const vault of vaults) {
    convert(vault, vault);
    console.log("");
  }
} else {
  const src = path.resolve(from);
  const dest = path.resolve(to ?? `${src} (attachments)`);
  if (!fs.existsSync(path.join(src, ".notes"))) {
    console.error(`${src} is not a vault (no .notes/)`);
    process.exit(1);
  }
  if (fs.existsSync(dest)) {
    console.error(`${dest} already exists — not writing over it`);
    process.exit(1);
  }
  convert(src, dest);
}
