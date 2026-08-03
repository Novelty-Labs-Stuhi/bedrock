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
 * INLINE FIELDS in general: `name:: value` on a line of its own, the spelling `type::`
 * already uses. Every fact the app keeps about a note that is not prose is written this
 * way — active, linear, state — so it travels with the folder, shows up in the editor,
 * and can be typed or deleted by hand like anything else in the file.
 */
const fieldRe = (name: string): RegExp => new RegExp(`^[ \\t]*${name}::[ \\t]*(.*?)[ \\t]*$`, "i");

const fieldLineAt = (lines: string[], name: string): number => {
  const re = fieldRe(name);
  return lines.findIndex((line) => re.test(line));
};

/** A field's value, or null when the note does not carry the field at all. */
export function parseField(text: string, name: string): string | null {
  const lines = text.split("\n");
  const at = fieldLineAt(lines, name);
  return at < 0 ? null : (fieldRe(name).exec(lines[at])?.[1] ?? "");
}

/**
 * Writes a field into (or out of) a note's markdown. A null value removes the line
 * rather than writing an empty one: a note the app has nothing to say about should read
 * like every other quiet note in the vault, with nothing said about it either way.
 */
export function setField(text: string, name: string, value: string | null): string {
  const lines = text.split("\n");
  const at = fieldLineAt(lines, name);
  if (at >= 0) {
    if (value !== null) {
      lines[at] = `${name}:: ${value}`;
      return lines.join("\n");
    }
    lines.splice(at, 1);
    // The field sat on a line of its own between blanks; leave one, not two.
    if (at > 0 && lines[at - 1].trim() === "" && (lines[at] ?? "x").trim() === "") lines.splice(at, 1);
    return lines.join("\n");
  }
  if (value === null) return text;
  const gap = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${gap}${name}:: ${value}\n`;
}

/** Off spellings, so `active:: false` reads as a note that was active and no longer is. */
const OFF = new Set(["", "false", "no", "off", "0"]);

/**
 * A note's ACTIVITY: `active:: true`. An active note radiates on the graph — it is the
 * one being worked on, the live end of the vault.
 */
export function parseActive(text: string): boolean {
  const value = parseField(text, "active");
  return value !== null && !OFF.has(value.toLowerCase());
}

export const setActive = (text: string, on: boolean): string =>
  setField(text, "active", on ? "true" : null);

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
