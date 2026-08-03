// [[wikilink]] parsing and Obsidian-style resolution against the vault's files.

import { isMarkdown, noteName } from "./vault";

export type WikiLink = { target: string; alias: string | null; label: string | null };

// `(?<!!)` keeps image embeds out: `![[screenshots/x.png]]` is an attachment, not a link to a note —
// counting it would put a phantom node in the graph and a dead backlink in every illustrated note.
const LINK_RE = /(?<!!)\[\[([^\][|]+)(?:\|([^\][]*))?\]\]/g;

/**
 * A NAMED connection: the relation is written immediately before the link, `name:: [[Target]]` —
 * the inline-field spelling Obsidian/Dataview users already use, so a labelled link stays a plain
 * readable line in the file and an unlabelled `[[Target]]` keeps working untouched:
 *
 *     built with:: [[ideas/Cytoscape]]
 *     - inspired by:: [[ideas/Obsidian]]
 *
 * Only the text between the start of the line (past any list/quote marker) and `::` counts, so a
 * `::` deeper in a sentence cannot accidentally name an edge.
 */
const LABEL_RE = /^[\s>*+-]*(?:\d+[.)]\s*)?([^:\n][^:\n]{0,58}?)\s*::\s*$/;

export const labelledLink = (label: string | null, target: string): string =>
  label ? `${label}:: [[${target}]]` : `[[${target}]]`;

/** Every [[link]] in a document, in order, duplicates included, each with its relation name. */
export function parseLinks(text: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const match of text.matchAll(LINK_RE)) {
    const target = match[1].trim();
    if (!target) continue;
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const before = text.slice(lineStart, match.index);
    out.push({
      target,
      alias: match[2]?.trim() || null,
      label: LABEL_RE.exec(before)?.[1].trim() || null,
    });
  }
  return out;
}

/*
 * `#tag`, Obsidian's spelling. It must start a word (so `page#anchor` is not a tag) and
 * carry at least one letter (so `#2024` is not one either). Nested tags — `#work/api` —
 * count as one tag, the whole path.
 */
const TAG_RE = /(?<![\w#/-])#([\w/-]*[A-Za-z][\w/-]*)/g;
/* A heading is `# Title`: a hash, then a space. `#Title` is a tag. The two never collide. */
const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g;

/**
 * Every distinct tag in a document, in order of first appearance. Code is stripped
 * first: a shell `#!/bin/sh` or a C `#include` is not somebody tagging a note.
 */
export function parseTags(text: string): string[] {
  const prose = text.replace(CODE_RE, " ");
  return [...new Set([...prose.matchAll(TAG_RE)].map((match) => match[1]))];
}

/*
 * A note's TYPE: `type:: gemini` on a line of its own — by convention the file's
 * last. A type changes how the graph draws and answers the node (shape, what a
 * click does); a note with no type line is just a note, drawn as a circle.
 */
const TYPE_RE = /^type::[ \t]*([\w-]+)[ \t]*$/im;

export const parseType = (text: string): string | null =>
  TYPE_RE.exec(text)?.[1].toLowerCase() ?? null;

/*
 * A note's ACTIVITY: `active:: true` on a line of its own, the same inline-field spelling
 * as `type::`. An active note radiates on the graph — it is the one being worked on, the
 * live end of the vault — and because the mark is a line in the file it travels with the
 * folder, shows up in the editor, and can be typed by hand like anything else.
 */
const ACTIVE_RE = /^[ \t]*active::[ \t]*(.*?)[ \t]*$/i;

/** Off spellings, so `active:: false` reads as a note that was active and no longer is. */
const OFF = new Set(["", "false", "no", "off", "0"]);

const activeLineAt = (lines: string[]): number => lines.findIndex((line) => ACTIVE_RE.test(line));

export function parseActive(text: string): boolean {
  const lines = text.split("\n");
  const at = activeLineAt(lines);
  if (at < 0) return false;
  return !OFF.has((ACTIVE_RE.exec(lines[at])?.[1] ?? "").toLowerCase());
}

/**
 * Writes the mark into (or out of) a note's markdown. Switching it off removes the line
 * rather than writing `active:: false`: a note that is not being worked on should read
 * like every other quiet note in the vault, with nothing said about it either way.
 */
export function setActive(text: string, on: boolean): string {
  const lines = text.split("\n");
  const at = activeLineAt(lines);
  if (at >= 0) {
    if (on) {
      lines[at] = "active:: true";
      return lines.join("\n");
    }
    lines.splice(at, 1);
    // The field sat on a line of its own between blanks; leave one, not two.
    if (at > 0 && lines[at - 1].trim() === "" && (lines[at] ?? "x").trim() === "") lines.splice(at, 1);
    return lines.join("\n");
  }
  if (!on) return text;
  const gap = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${gap}active:: true\n`;
}

/** Same shape as LINK_RE, but keeping the `|alias` tail so a rewrite can put it back. */
const REWRITE_RE = /(?<!!)\[\[([^\][|]+)(\|[^\][]*)?\]\]/g;

/**
 * Repoints every [[link]] whose target resolves to a path in `moves`. A note that moves
 * takes its incoming references with it — without this, every note linking to it is left
 * pointing at nothing.
 *
 * `resolve` must be built from the paths as they were BEFORE the move, or a link to the
 * old location no longer finds anything to repoint. The author's spelling is kept: a full
 * path stays a full path, a bare name stays a bare name, and `#heading` / `|alias` tails
 * ride along untouched.
 */
export function relinkText(
  text: string,
  moves: Map<string, string>,
  resolve: (target: string) => string | null,
): string {
  return text.replace(REWRITE_RE, (whole, rawTarget: string, alias = "") => {
    const target = rawTarget.trim();
    const hash = target.indexOf("#");
    const base = hash >= 0 ? target.slice(0, hash) : target;
    const heading = hash >= 0 ? target.slice(hash) : "";
    const from = resolve(base);
    const to = from && moves.get(from);
    if (!to) return whole;
    const next = base.includes("/") ? to.replace(/\.md$/i, "") : noteName(to);
    return `[[${next}${heading}${alias}]]`;
  });
}

/**
 * Resolves link text to a file path. Accepts a full path ("ideas/Note",
 * "ideas/Note.md") or a bare note name ("Note"), case-insensitively; bare names
 * pick the shallowest match, as Obsidian does.
 */
export class LinkResolver {
  private byPath = new Map<string, string>();
  private byName = new Map<string, string>();

  constructor(paths: string[]) {
    const depth = (p: string) => p.split("/").length;
    for (const path of [...paths].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))) {
      if (!isMarkdown(path)) continue;
      this.byPath.set(path.toLowerCase(), path);
      this.byPath.set(path.replace(/\.md$/i, "").toLowerCase(), path);
      const name = noteName(path).toLowerCase();
      if (!this.byName.has(name)) this.byName.set(name, path);
    }
  }

  resolve(target: string): string | null {
    const key = target.replace(/^\/+/, "").toLowerCase();
    return this.byPath.get(key) ?? this.byName.get(key) ?? null;
  }
}
