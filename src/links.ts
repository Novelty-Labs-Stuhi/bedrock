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

/*
 * `#4c8dff` is a colour somebody wrote down, not a tag — and taken for one it would put a
 * slice of its own hue in the note's pie, which is the note quietly recolouring itself for
 * having mentioned a colour. Six or eight hex digits with a digit among them: long enough
 * and mixed enough that a word tag will not be mistaken for one.
 */
const HEX_RE = /^(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;
const isHex = (word: string): boolean => HEX_RE.test(word) && /\d/.test(word);

/**
 * Every distinct tag in a document, in order of first appearance. Code is stripped
 * first: a shell `#!/bin/sh` or a C `#include` is not somebody tagging a note.
 */
export function parseTags(text: string): string[] {
  const prose = text.replace(CODE_RE, " ");
  const words = [...prose.matchAll(TAG_RE)].map((match) => match[1]).filter((word) => !isHex(word));
  return [...new Set(words)];
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

/**
 * A note's LOOK on the canvas, four independent choices, each an inline field of its own:
 *
 *     sign:: star
 *     color:: blue
 *     anim:: pulse
 *     anim-color:: pink
 *
 * Names, not codes — what the words mean is `node-style.ts`'s business, and a name is what
 * somebody editing the file by hand can write without looking anything up. A hex typed in
 * by hand is honoured all the same, and is the reason a value may start with a `#`.
 *
 * Empty strings throughout rather than nulls — "no sign" and "no colour of its own" are
 * answers a note can hold, and the same shape goes onto the node as data (see `graph.ts`),
 * where a key that comes and goes would leave the last one painted on.
 *
 * Both spellings of colour are read, because half the world types one and half the other;
 * `setStyle` writes the American one and clears the British, so a note never carries two.
 */
export type NodeStyle = { icon: string; colour: string; anim: string; animColour: string };

const KEY_RE = /^#?[\w-]+$/;

export function parseStyle(text: string): NodeStyle {
  const key = (...names: string[]): string => {
    for (const name of names) {
      const value = parseField(text, name)?.trim() ?? "";
      if (KEY_RE.test(value)) return value.toLowerCase();
    }
    return "";
  };
  return {
    icon: key("sign"),
    colour: key("color", "colour"),
    // `active:: true` was how a note asked to pulse before there was anything else to
    // ask for; it still is, for every note written back then.
    anim: key("anim") || (parseActive(text) ? "pulse" : ""),
    animColour: key("anim-color", "anim-colour"),
  };
}

export function setStyle(text: string, style: NodeStyle): string {
  let out = text;
  out = setField(out, "sign", style.icon || null);
  out = setField(out, "colour", null);
  out = setField(out, "color", style.colour || null);
  out = setField(out, "anim", style.anim || null);
  out = setField(out, "anim-colour", null);
  // No animation, nothing to colour: the line would sit in the file saying something
  // about a ring that is not there, and read as one that is.
  out = setField(out, "anim-color", (style.anim && style.animColour) || null);
  // A note that has been styled says what it does in `anim::`, so the old spelling comes
  // off — left behind it would go on meaning "pulse" after the pulse was switched off.
  if (parseField(out, "active") !== null) out = setActive(out, false);
  return out;
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

/** A link's target without the `#heading` tail, which resolution never looks at. */
const linkBase = (target: string): string => {
  const t = target.trim();
  const hash = t.indexOf("#");
  return hash >= 0 ? t.slice(0, hash) : t;
};

/**
 * Rewrites how a link is SPELLED without changing what it points at. `pinned` is asked what a
 * target should be written as and answers null to leave it alone — so a bare `[[Domain]]`, about
 * to be taken over by a new note of the same name, can be written out as `[[ideas/Domain]]` and
 * go on meaning the note it has always meant. `#heading` / `|alias` tails ride along untouched.
 */
export function pinText(text: string, pinned: (target: string) => string | null): string {
  return text.replace(REWRITE_RE, (whole, rawTarget: string, alias = "") => {
    const target = rawTarget.trim();
    const to = pinned(linkBase(target));
    if (!to) return whole;
    const hash = target.indexOf("#");
    return `[[${to}${hash >= 0 ? target.slice(hash) : ""}${alias}]]`;
  });
}

/*
 * A link on a line of its own, with or without the relation name the app writes in front of it
 * (`built with:: [[X]]`) — the shape of every line the app itself has ever written into a note.
 * Take the link out of one of these and there is nothing left on the line worth keeping.
 * `![[picture.png]]` cannot match: an embed's `!` is in neither the prefix nor the marker.
 */
const LINK_LINE_RE = /^[\s>*+-]*(?:\d+[.)]\s*)?(?:[^:\n][^:\n]{0,58}?\s*::\s*)?\[\[([^\][|]+)(?:\|[^\][]*)?\]\]\s*$/;

/**
 * Takes every link the caller disowns back out of a note's markdown.
 *
 * A deleted note has to take its incoming references with it, the way a renamed one takes them
 * along. Left behind, the line points at a note that is not there: it draws nothing, so it reads
 * as gone — and is then handed to the next note to be given that name, as a connection nobody
 * drew. That is where the edges from nowhere came from.
 *
 * A line that was nothing but the link goes entirely, because the app wrote it when the
 * connection was drawn. A link inside a sentence leaves its words behind — that one is prose.
 */
export function unlinkText(text: string, gone: (target: string) => boolean): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let closing = false; // a line has just gone; the gap it sat in has to close behind it
  for (const line of lines) {
    const alone = LINK_LINE_RE.exec(line);
    if (alone && gone(linkBase(alone[1]))) {
      // The line sat on its own between blanks; leave one, not two. With nothing above it
      // there is nothing to take back, so the blank below goes instead.
      if (out.length && out[out.length - 1].trim() === "") out.pop();
      else closing = !out.length;
      continue;
    }
    if (closing) {
      closing = false;
      if (line.trim() === "") continue;
    }
    out.push(
      line.replace(REWRITE_RE, (whole, rawTarget: string, alias = "") =>
        gone(linkBase(rawTarget)) ? (alias ? alias.slice(1).trim() : rawTarget.trim()) : whole,
      ),
    );
  }
  return out.join("\n");
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
