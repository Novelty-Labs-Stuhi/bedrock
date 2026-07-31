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
