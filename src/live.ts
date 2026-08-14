// Live preview: markdown that renders everywhere except where you are working.
//
// The whole layer is one rule — decorate every block, skip the block holding the selection —
// and the interesting part is the definition of "block". It is deliberately coarse: the run of
// consecutive non-blank lines around the caret, or a whole fenced region. A finer rule (the
// caret's line, or the token under it) makes text reflow while you are typing into it, because
// the line you are editing keeps changing width as markers appear and disappear. A block-sized
// reveal moves the page once, when you arrive, and then holds still.
//
// Nothing renders while the editor has focus somewhere else: an unfocused editor shows the note
// fully rendered, which is what the reading view used to be for.
//
// Three kinds of decoration do all the work:
//   - `Decoration.replace({})` over a marker hides it without touching the document. The `#`
//     of a heading is still in the file, still in the selection, still saved.
//   - `Decoration.mark` styles what is between the markers.
//   - `Decoration.replace({ widget })` swaps an embed for the picture it points at.

import { type EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { assetUrl, cachedAsset, missingMarker } from "./images";
import { MathRender, activeMathSpan, mathSpans, type MathSpan } from "./math";
import { basename, isImage, type Vault } from "./vault";

/** What the layer needs from the app: which note is open, and what to read its bytes from. */
export type LiveContext = { note: () => string; vault: () => Vault };

type Span = { from: number; to: number };

/* --------------------------------------------------------------- embeds --- */

/**
 * A picture standing in for its `![[…]]`. The URL is very often already cached — the widget is
 * rebuilt on every keystroke, so the common path has to be synchronous — and only the first
 * mount of a given embed waits on the vault.
 */
class Embed extends WidgetType {
  constructor(
    private readonly target: string,
    private readonly alt: string,
    private readonly note: string,
    /** The embed is the only thing on its line, so it gets a block of its own to sit in. */
    private readonly alone: boolean,
    private readonly vault: Vault,
  ) {
    super();
  }

  eq(other: Embed): boolean {
    return (
      other.target === this.target &&
      other.alt === this.alt &&
      other.note === this.note &&
      other.alone === this.alone
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement(this.alone ? "div" : "span");
    box.className = this.alone ? "cm-embed cm-embed-alone" : "cm-embed";

    const known = cachedAsset(this.note, this.target);
    if (known === null) {
      box.append(missingMarker(this.target));
      return box;
    }

    const img = document.createElement("img");
    img.alt = this.alt;
    img.title = this.target;
    // The height of a line containing a picture is not known until the picture arrives, and
    // the editor has already measured by then. This is what stops later lines overlapping it.
    img.addEventListener("load", () => view.requestMeasure());
    box.append(img);

    if (known) img.src = known;
    else {
      box.classList.add("cm-embed-waiting");
      void assetUrl(this.vault, this.note, this.target).then((url) => {
        box.classList.remove("cm-embed-waiting");
        if (url) img.src = url;
        else {
          img.remove();
          box.append(missingMarker(this.target));
        }
      });
    }
    return box;
  }

  /** A click has to reach the document, or there would be no way to get a caret back into it. */
  ignoreEvent(): boolean {
    return false;
  }
}

/* --------------------------------------------------------------- blocks --- */

/**
 * Every fenced region, as document offsets. These are needed twice: a fence is a single block
 * however many blank lines it holds, and nothing inside one may be decorated — a `**` in a code
 * sample is a pair of asterisks, not an instruction.
 */
function fencedSpans(state: EditorState): Span[] {
  const spans: Span[] = [];
  let open: number | null = null;
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (!/^\s*```/.test(line.text)) continue;
    if (open === null) open = line.from;
    else {
      spans.push({ from: open, to: line.to });
      open = null;
    }
  }
  // A fence still being typed has no closing line yet; it owns the rest of the document.
  if (open !== null) spans.push({ from: open, to: state.doc.length });
  return spans;
}

const overlaps = (span: Span, from: number, to: number): boolean =>
  from <= span.to && to >= span.from;

/**
 * A line that is a block in its own right: a heading, a list item, a quote. Only plain prose
 * runs together into a paragraph, which is why this is not simply "the non-blank lines around
 * the caret" — a note written without blank lines between its heading, its paragraph and its
 * list would be a single block, and putting the caret anywhere in it would un-render the lot.
 */
const STANDALONE = /^[ \t]*(?:#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|>)/;

/** The block around a position: a whole fence, one standalone line, or a paragraph. */
function blockAt(state: EditorState, pos: number, fences: Span[]): Span {
  for (const fence of fences) if (pos >= fence.from && pos <= fence.to) return fence;

  const here = state.doc.lineAt(pos);
  const alone = { from: here.from, to: here.to };
  // A blank line is the gap between two paragraphs, not part of either — without this, a
  // caret resting below a paragraph would un-render the paragraph.
  if (!here.text.trim()) return alone;
  if (STANDALONE.test(here.text)) return alone;

  const plain = (n: number): boolean => {
    const text = state.doc.line(n).text;
    return !!text.trim() && !STANDALONE.test(text);
  };
  let first = here.number;
  let last = here.number;
  while (first > 1 && plain(first - 1)) first--;
  while (last < state.doc.lines && plain(last + 1)) last++;
  return { from: state.doc.line(first).from, to: state.doc.line(last).to };
}

/**
 * The spans showing their source. A selection reaching across blocks reveals the ones between
 * its ends too — taking the outer bounds of the two end blocks covers them without a walk.
 */
function revealed(state: EditorState, fences: Span[]): Span[] {
  return state.selection.ranges.map((range) => {
    const head = blockAt(state, range.from, fences);
    const tail = range.to === range.from ? head : blockAt(state, range.to, fences);
    return { from: Math.min(head.from, tail.from), to: Math.max(head.to, tail.to) };
  });
}

/* ---------------------------------------------------------- decorations --- */

const HIDE = Decoration.replace({});
/** Wikilinks stay literal — every bracket is still on screen. This only colours them. */
const RAW_LINK = Decoration.mark({ class: "cm-wikilink-raw" });

const HEADING = /^(#{1,6})[ \t]+(?=\S)/;
const EMBED = /!\[\[([^\][|]+)(?:\|([^\][]*))?\]\]|!\[([^\]]*)\]\(([^)\s]+)\)/g;
const WIKILINK = /\[\[[^\][]+\]\]/g;

/**
 * One pass, left to right, first match wins — so the markers found can never overlap and the
 * decorations they produce need no reconciling. The cost of the single pass is that these do
 * not nest: the `code` in `**bold `code`**` wins, and the bold around it stays literal. Nesting
 * would need a real parser, and notes are not written that way often enough to buy one.
 */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(==[^=\n]+==)|(\*[^*\n]+\*)/g;

/** Backticks alone — claimed before formulas so `$x$` inside code stays literal. */
const INLINE_CODE = /`[^`\n]+`/g;

/** Per capture group of `INLINE`: how many characters the marker is, and what it means. */
const KINDS = [
  { pad: 1, cls: "cm-code" },
  { pad: 2, cls: "cm-strong" },
  { pad: 2, cls: "cm-del" },
  { pad: 2, cls: "cm-mark" },
  { pad: 1, cls: "cm-em" },
] as const;

const decodePath = (src: string): string => {
  try {
    return decodeURIComponent(src);
  } catch {
    return src; // a stray % in the name — take it verbatim
  }
};

/**
 * Everything one line contributes. Embeds go first and claim their ranges, because a widget
 * replaces its whole match and nothing inside it can also be styled — `![[a.png]]` holds a
 * perfectly good `[[a.png]]` that must not be coloured as a link.
 */
function decorateLine(
  line: { from: number; to: number; text: string },
  out: Range<Decoration>[],
  atoms: Range<Decoration>[],
  ctx: { note: string; vault: Vault; math: MathSpan | null },
): void {
  const text = line.text;
  const taken: Span[] = [];
  const free = (at: number, len: number): boolean =>
    !taken.some((span) => at < span.to && at + len > span.from);

  for (const m of text.matchAll(EMBED)) {
    const at = m.index ?? 0;
    const wiki = m[1] !== undefined;
    const raw = (wiki ? m[1] : m[4]) ?? "";
    const target = wiki ? raw.trim() : decodePath(raw);
    if (!target) continue;
    // `![[Some note]]` with no picture extension is a transclusion, not an image. Leave it.
    if (wiki && !isImage(target)) continue;

    const alt = (m[2] ?? m[3] ?? basename(target)).trim();
    const alone = text.trim() === m[0];
    const widget = new Embed(target, alt, ctx.note, alone, ctx.vault);
    /*
     * An embed alone on its line covers the whole line, so the line ends up holding nothing
     * but the picture. It is still an *inline* replacement: CodeMirror refuses block
     * decorations from a view plugin ("Block decorations may not be specified via plugins"),
     * and one thrown range is enough to tear the plugin down and un-render the whole note.
     * `display: block` on the widget gives the same result without asking CodeMirror for it.
     */
    const from = alone ? line.from : line.from + at;
    const to = alone ? line.to : line.from + at + m[0].length;
    out.push(Decoration.replace({ widget }).range(from, to));
    if (alone) return; // the line is the picture — there is nothing else on it to decorate
    taken.push({ from: at, to: at + m[0].length });
  }

  /*
   * Inline code before formulas: `` `$x$` `` is a code span that happens to hold dollar signs,
   * not a formula wrapped in backticks. Claiming the backticks first keeps math out of them;
   * the later INLINE pass still draws the code (already in `taken`, so free() skips a second go).
   */
  for (const m of text.matchAll(INLINE_CODE)) {
    const at = m.index ?? 0;
    if (!free(at, m[0].length)) continue;
    const from = line.from + at;
    const to = from + m[0].length;
    out.push(HIDE.range(from, from + 1));
    out.push(Decoration.mark({ class: "cm-code" }).range(from + 1, to - 1));
    out.push(HIDE.range(to - 1, to));
    taken.push({ from: at, to: at + m[0].length });
  }

  /*
   * Formulas claim their ranges next, for the same reason embeds do: `$a * b * c$` holds a
   * perfectly good pair of asterisks that must not become italics, and the `_` in `$x_1$` is a
   * subscript rather than the start of anything. The formula currently open as a field is the
   * one exception — `math.ts` is already drawing over that range, and two widgets replacing the
   * same characters is an error rather than a race.
   */
  for (const span of mathSpans(line)) {
    if (!free(span.from - line.from, span.to - span.from)) continue;
    if (ctx.math && span.from < ctx.math.to && span.to > ctx.math.from) continue;
    const widget = new MathRender(span.latex, span.display);
    const deco = Decoration.replace({ widget }).range(span.from, span.to);
    out.push(deco);
    atoms.push(deco);
    taken.push({ from: span.from - line.from, to: span.to - line.from });
  }

  const heading = HEADING.exec(text);
  if (heading) {
    out.push(Decoration.line({ class: `cm-hd cm-h${heading[1].length}` }).range(line.from));
    out.push(HIDE.range(line.from, line.from + heading[0].length));
  }

  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (!free(at, m[0].length)) continue;
    // Which alternative fired: the first group with something in it.
    const kind = KINDS[m.findIndex((group, i) => i > 0 && group !== undefined) - 1];
    if (!kind) continue;
    const from = line.from + at;
    const to = from + m[0].length;
    out.push(HIDE.range(from, from + kind.pad));
    out.push(Decoration.mark({ class: kind.cls }).range(from + kind.pad, to - kind.pad));
    out.push(HIDE.range(to - kind.pad, to));
    taken.push({ from: at, to: at + m[0].length });
  }

  for (const m of text.matchAll(WIKILINK)) {
    const at = m.index ?? 0;
    if (!free(at, m[0].length)) continue;
    out.push(RAW_LINK.range(line.from + at, line.from + at + m[0].length));
  }
}

/**
 * What a line inside the revealed block still gets: its formulas, still drawn.
 *
 * Revealing a block means showing its markers, and for every other piece of markdown that is the
 * whole story — `**` is two characters wide either way, so the line barely moves. A formula is
 * not a marker wrapped around text, it is a different picture of it: `$\frac12$` is nine
 * characters standing in for a fraction twice the height of the line. Swapping between them as
 * the caret arrives is exactly the reflow this file went to block-sized reveals to avoid.
 *
 * Nor is there anything left to reveal *for*. Revealing exists so a marker can be edited as the
 * characters it is, and for a formula that is what the LaTeX box inside the field is — opened by
 * clicking the formula, holding the same characters, and able to draw what they mean while you
 * type. LaTeX too broken to draw still falls back to its own source, so nothing is unreachable.
 */
function decorateRevealedMath(
  line: { from: number; to: number; text: string },
  out: Range<Decoration>[],
  atoms: Range<Decoration>[],
  ctx: { math: MathSpan | null },
): void {
  // Same rule as decorateLine: dollars inside backticks are code, not math.
  const code: Span[] = [];
  for (const m of line.text.matchAll(INLINE_CODE)) {
    const at = m.index ?? 0;
    code.push({ from: at, to: at + m[0].length });
  }
  for (const span of mathSpans(line)) {
    // The one already open as a field — `math.ts` is drawing that range itself.
    if (ctx.math && span.from < ctx.math.to && span.to > ctx.math.from) continue;
    const localFrom = span.from - line.from;
    const localTo = span.to - line.from;
    if (code.some((c) => localFrom < c.to && localTo > c.from)) continue;
    const widget = new MathRender(span.latex, span.display);
    const deco = Decoration.replace({ widget }).range(span.from, span.to);
    out.push(deco);
    atoms.push(deco);
  }
}

/** Everything on screen: what to draw, and which of it the caret crosses in one step. */
type Built = { decorations: DecorationSet; atoms: DecorationSet };

/** The decorations for what is on screen. Off-screen lines cost nothing. */
function build(view: EditorView, ctx: LiveContext): Built {
  const state = view.state;
  const fences = fencedSpans(state);
  // An editor nobody is typing in has no block to reveal: the note reads as finished text.
  const open = view.hasFocus ? revealed(state, fences) : [];
  const out: Range<Decoration>[] = [];
  const atoms: Range<Decoration>[] = [];
  const here = { note: ctx.note(), vault: ctx.vault(), math: activeMathSpan(state) };

  for (const range of view.visibleRanges) {
    let pos = range.from;
    while (pos <= range.to) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      if (!line.text.trim()) continue;
      if (fences.some((span) => overlaps(span, line.from, line.to))) continue;
      if (open.some((span) => overlaps(span, line.from, line.to))) {
        decorateRevealedMath(line, out, atoms, here);
        continue;
      }
      decorateLine(line, out, atoms, here);
    }
  }
  // Sorted on the way in: a line's decorations are produced in the order that reads best,
  // not the order the range set needs.
  return { decorations: Decoration.set(out, true), atoms: Decoration.set(atoms, true) };
}

export function livePreview(ctx: LiveContext): Extension {
  return ViewPlugin.fromClass(
    class {
      built: Built;

      constructor(view: EditorView) {
        this.built = build(view, ctx);
      }

      update(update: ViewUpdate): void {
        const moved = update.docChanged || update.selectionSet;
        if (moved || update.viewportChanged || update.focusChanged) {
          this.built = build(update.view, ctx);
        }
      }
    },
    {
      decorations: (plugin) => plugin.built.decorations,
      /*
       * A drawn formula is one thing on the page, so it is one step for the caret: `$\frac12$`
       * is nine characters in the file, and without this, crossing it means nine presses of the
       * arrow key through positions that are not anywhere on screen. Backspace takes the whole
       * formula for the same reason.
       *
       * Only the formulas. The hidden markers around a heading or a bit of bold are the *same*
       * text you are editing, with the `#` or the `**` tucked away; skipping them would make
       * the caret jump over the words themselves.
       */
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => view.plugin(plugin)?.built.atoms ?? Decoration.none),
    },
  );
}

/* ----------------------------------------------------------------- links --- */

/**
 * The wikilink target under a position, if there is one. Used for ⌘-click: the brackets are
 * never hidden, so this reads them straight out of the line.
 */
export function wikilinkAt(state: EditorState, pos: number): string | null {
  const line = state.doc.lineAt(pos);
  const at = pos - line.from;
  for (const m of line.text.matchAll(WIKILINK)) {
    const start = m.index ?? 0;
    if (at < start || at > start + m[0].length) continue;
    const inner = m[0].slice(2, -2);
    const target = (inner.split("|")[0] ?? "").trim();
    if (target) return target;
  }
  return null;
}
