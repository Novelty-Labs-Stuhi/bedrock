// Every editing action the format bar and its shortcuts perform, as pure functions over
// (text, selection). Nothing here touches the DOM.
//
// An action returns the span of the document to replace, what to put there, and where the
// selection should end up — which is all `toolbar.ts` needs to go through the browser's own
// `insertText` and leave the undo stack intact. Assigning to `textarea.value` would be
// simpler and would throw away every undo step the note has.

export type Patch = { from: number; to: number; insert: string; select: [number, number] };

/* ------------------------------------------------------------------ lines --- */

const lineStartAt = (text: string, at: number): number => text.lastIndexOf("\n", at - 1) + 1;

const lineEndAt = (text: string, at: number): number => {
  const stop = text.indexOf("\n", at);
  return stop < 0 ? text.length : stop;
};

/**
 * The whole lines a selection touches. A selection that ends exactly on a line break has
 * not reached the next line — without this, selecting one line by dragging past its end
 * would silently bullet the line after it too.
 */
function lineSpan(text: string, start: number, end: number): { from: number; to: number } {
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  return { from: lineStartAt(text, start), to: lineEndAt(text, last) };
}

/** Rewrites the touched lines and keeps the whole block selected. */
function patchLines(
  text: string,
  start: number,
  end: number,
  rewrite: (lines: string[]) => string[],
): Patch {
  const { from, to } = lineSpan(text, start, end);
  const insert = rewrite(text.slice(from, to).split("\n")).join("\n");
  return { from, to, insert, select: [from, from + insert.length] };
}

const indentOf = (line: string): string => /^[ \t]*/.exec(line)![0];

/* ------------------------------------------------------------ inline wraps --- */

/**
 * A lone `*` beside another `*` is half of a `**bold**` pair, not an italic marker. Without
 * this, italicising a word already in bold would eat one asterisk from each side and turn
 * the bold into italic instead of adding to it.
 */
const halfOfBold = (text: string, start: number, end: number, open: string): boolean =>
  open === "*" && (text[start - 2] === "*" || text[end + 1] === "*");

/**
 * Wraps the selection, or unwraps it when it is already wrapped — whether the markers sit
 * inside the selection or just outside it. Outside is the common one: every action here
 * leaves the bare word selected, so pressing the same button twice has to undo itself.
 *
 * With nothing selected it writes an empty pair and puts the caret between them.
 */
export function toggleWrap(
  text: string,
  start: number,
  end: number,
  open: string,
  close: string = open,
): Patch {
  const inner = text.slice(start, end);

  if (
    start >= open.length &&
    text.slice(start - open.length, start) === open &&
    text.slice(end, end + close.length) === close &&
    !halfOfBold(text, start, end, open)
  ) {
    const from = start - open.length;
    return { from, to: end + close.length, insert: inner, select: [from, from + inner.length] };
  }

  if (inner.length >= open.length + close.length && inner.startsWith(open) && inner.endsWith(close)) {
    const bare = inner.slice(open.length, inner.length - close.length);
    return { from: start, to: end, insert: bare, select: [start, start + bare.length] };
  }

  const at = start + open.length;
  return { from: start, to: end, insert: open + inner + close, select: [at, at + inner.length] };
}

/** Inline `code` for a phrase, a fenced block for anything spanning lines. */
export function code(text: string, start: number, end: number): Patch {
  const inner = text.slice(start, end);
  if (!inner.includes("\n")) return toggleWrap(text, start, end, "`");
  return patchLines(text, start, end, (lines) =>
    lines[0].trim() === "```" && lines[lines.length - 1].trim() === "```"
      ? lines.slice(1, -1)
      : ["```", ...lines, "```"],
  );
}

/* ------------------------------------------------------------- line marks --- */

/** Any list marker, so switching between bullets and numbers replaces rather than stacks. */
const ANY_LIST = /^(?:[-*+]|\d+[.)])[ \t]+/;
const BULLET = /^[-*+][ \t]+/;
const NUMBER = /^\d+[.)][ \t]+/;
const QUOTE = /^>[ \t]?/;

/**
 * Puts a marker on every touched line, or takes it off all of them when every line already
 * has one — the rule every editor uses, and the only one that survives a mixed selection.
 * Blank lines are left alone; a bulleted blank line is just litter.
 */
function toggleMark(
  text: string,
  start: number,
  end: number,
  mark: RegExp,
  clear: RegExp,
  make: (index: number) => string,
): Patch {
  return patchLines(text, start, end, (lines) => {
    const written = lines.filter((line) => line.trim());
    const on = written.length > 0 && written.every((line) => mark.test(line.slice(indentOf(line).length)));
    let n = 0;
    return lines.map((line) => {
      if (!line.trim()) return line;
      const indent = indentOf(line);
      const bare = line.slice(indent.length).replace(clear, "");
      return indent + (on ? bare : make(n++) + bare);
    });
  });
}

export const bullets = (text: string, start: number, end: number): Patch =>
  toggleMark(text, start, end, BULLET, ANY_LIST, () => "- ");

export const numbers = (text: string, start: number, end: number): Patch =>
  toggleMark(text, start, end, NUMBER, ANY_LIST, (i) => `${i + 1}. `);

export const quote = (text: string, start: number, end: number): Patch =>
  toggleMark(text, start, end, QUOTE, QUOTE, () => "> ");

const HEADING = /^(#{1,6})[ \t]+/;

/** H1 → H2 → H3 → plain, all touched lines following whatever the first one is. */
export function heading(text: string, start: number, end: number): Patch {
  return patchLines(text, start, end, (lines) => {
    const first = lines.find((line) => line.trim()) ?? "";
    const level = HEADING.exec(first.slice(indentOf(first).length))?.[1].length ?? 0;
    const next = level >= 3 ? 0 : level + 1;
    return lines.map((line) => {
      if (!line.trim()) return line;
      const indent = indentOf(line);
      const bare = line.slice(indent.length).replace(HEADING, "");
      return indent + (next ? `${"#".repeat(next)} ${bare}` : bare);
    });
  });
}

/* ------------------------------------------------------------------ case --- */

/** Letters plus what hangs off them, so punctuation and spacing are never touched. */
const WORD = /\p{L}[\p{L}\p{M}\p{Nd}'’_-]*/gu;

export function setCase(
  text: string,
  start: number,
  end: number,
  mode: "upper" | "lower" | "title",
): Patch {
  const inner = text.slice(start, end);
  const insert =
    mode === "upper"
      ? inner.toUpperCase()
      : mode === "lower"
        ? inner.toLowerCase()
        : inner.replace(WORD, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  return { from: start, to: end, insert, select: [start, start + insert.length] };
}

/* ------------------------------------------------------------------ links --- */

export const wikilink = (text: string, start: number, end: number): Patch =>
  toggleWrap(text, start, end, "[[", "]]");

/**
 * `[text](url)`. A selection that is already a URL becomes the destination and the caret
 * lands where the label goes; anything else becomes the label, with `https://` selected
 * so the address can be pasted straight over it.
 */
export function link(text: string, start: number, end: number): Patch {
  const inner = text.slice(start, end).trim();
  if (/^(https?:\/\/|www\.)\S+$/.test(inner)) {
    return { from: start, to: end, insert: `[](${inner})`, select: [start + 1, start + 1] };
  }
  const url = "https://";
  const at = start + inner.length + 3; // `[` + label + `](`
  return { from: start, to: end, insert: `[${inner}](${url})`, select: [at, at + url.length] };
}

/** `#tag`. Tags cannot hold spaces, so a phrase is hyphenated rather than half-tagged. */
export function tag(text: string, start: number, end: number): Patch {
  const inner = text.slice(start, end).trim();
  if (inner.startsWith("#")) {
    const bare = inner.slice(1);
    return { from: start, to: end, insert: bare, select: [start, start + bare.length] };
  }
  if (text[start - 1] === "#") {
    return { from: start - 1, to: end, insert: inner, select: [start - 1, start - 1 + inner.length] };
  }
  const insert = `#${inner.replace(/\s+/g, "-")}`;
  return { from: start, to: end, insert, select: [start, start + insert.length] };
}

/* ------------------------------------------------------------------ strip --- */

/** Takes the selection back to plain prose: markers, links and line marks all gone. */
export function clear(text: string, start: number, end: number): Patch {
  const insert = text
    .slice(start, end)
    .replace(/\[\[([^\][|]+)(?:\|([^\][]*))?\]\]/g, (_m, target: string, alias?: string) =>
      (alias ?? target).trim(),
    )
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|~~|==|`|\*/g, "")
    .split("\n")
    .map((line) => line.replace(/^([ \t]*)(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/, "$1"))
    .join("\n");
  return { from: start, to: end, insert, select: [start, start + insert.length] };
}

/* ----------------------------------------------------------- while typing --- */

const LIST_LINE = /^([ \t]*)(?:([-*+])|(\d+)([.)]))([ \t]+)(.*)$/;
const QUOTE_LINE = /^([ \t]*>[ \t]?)(.*)$/;

/**
 * Enter inside a list or a quote carries the marker down to the next line, numbering as it
 * goes. Enter on an item with nothing in it ends the list instead — that is how you get
 * back to plain text without reaching for backspace.
 *
 * Returns null when the caret is not in either, so Enter does its ordinary thing.
 */
export function continueLine(text: string, at: number): Patch | null {
  const from = lineStartAt(text, at);
  const to = lineEndAt(text, at);
  const line = text.slice(from, to);

  const list = LIST_LINE.exec(line);
  if (list) {
    const [, indent, bullet, digits, dot, gap, body] = list;
    if (!body.trim()) return { from, to, insert: "", select: [from, from] };
    const marker = bullet ?? `${Number(digits) + 1}${dot}`;
    const insert = `\n${indent}${marker}${gap}`;
    return { from: at, to: at, insert, select: [at + insert.length, at + insert.length] };
  }

  const quoted = QUOTE_LINE.exec(line);
  if (quoted) {
    if (!quoted[2].trim()) return { from, to, insert: "", select: [from, from] };
    const insert = `\n${quoted[1]}`;
    return { from: at, to: at, insert, select: [at + insert.length, at + insert.length] };
  }
  return null;
}

const INDENT = "  ";

/**
 * Tab indents list items. It is only taken over where it means something — on a list line,
 * or across a multi-line selection — so Tab out of the editor still works everywhere else.
 */
export function indent(text: string, start: number, end: number, out: boolean): Patch | null {
  const { from, to } = lineSpan(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const listish = lines.some((line) => /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/.test(line));
  if (!listish && lines.length < 2) return null;

  const next = lines.map((line) =>
    out ? line.replace(/^(?: {1,2}|\t)/, "") : line.trim() ? INDENT + line : line,
  );
  const insert = next.join("\n");
  if (insert === lines.join("\n")) return null;

  // A caret keeps its place on its own line; a range keeps the whole block selected, so a
  // second Tab indents the same lines again.
  if (start === end) {
    const shift = next[0].length - lines[0].length;
    const at = Math.max(from, start + shift);
    return { from, to, insert, select: [at, at] };
  }
  return { from, to, insert, select: [from, from + insert.length] };
}

/** Typing one of these with text selected wraps the selection instead of replacing it. */
const PAIRS: Record<string, string> = {
  "*": "*",
  "`": "`",
  "~": "~",
  "=": "=",
  '"': '"',
  "[": "]",
  "(": ")",
  "{": "}",
};

/** The wrap a typed character means, or null when it means the character itself. */
export function typedWrap(text: string, start: number, end: number, typed: string): Patch | null {
  const close = PAIRS[typed];
  if (!close || start === end) return null;
  const inner = text.slice(start, end);
  const at = start + typed.length;
  // Always wrap, never unwrap: the character was typed, so it is meant to appear. Pressing
  // `*` twice is how `**bold**` gets written.
  return { from: start, to: end, insert: typed + inner + close, select: [at, at + inner.length] };
}
