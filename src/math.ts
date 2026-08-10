// LaTeX math: `$…$` inline, `$$…$$` for a formula on its own.
//
// The storage format is the point. A formula is characters in the markdown file and nothing else,
// so a note with math in it is still a note — greppable, diffable, readable in any editor, and
// unchanged if this feature is ever removed. Everything below is a way of looking at those
// characters, never a second copy of them.
//
// Three states, and which one you get follows the rule `live.ts` already sets for the rest of
// markdown — rendered until you are working on it:
//
//   - not where you are working → the formula, drawn.
//   - caret somewhere in the block → the source, `$\frac{a}{b}$`, editable as text like any
//     other markdown marker. This is still the way to fix LaTeX by hand.
//   - the formula itself opened (⌘E, or a click on a drawn one) → a MathLive field with the
//     symbol bar above the note and the LaTeX beside it, which is the only part of the app
//     where you edit something other than characters.
//
// The field is deliberately transient. It owns its content while it is open and writes back once,
// on the way out; the document does not change under it on every keystroke. That is what keeps
// the widget's DOM — and the focus and the caret inside it — alive across redraws, and it is why
// undo sees one formula as one step instead of forty.

import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type Command,
} from "@codemirror/view";
import type { MathfieldElement } from "mathlive";
import { loadMathLive, mathLive, mathMarkup, whenMathLive } from "./mathlive";

/** A formula in the document: the whole match, delimiters included. */
export type MathSpan = { from: number; to: number; latex: string; display: boolean };

/*
 * `$$…$$` first, so the longer delimiter wins. The inline rule is the fussy one, because `$` is
 * also how people write money: an opening `$` may not be followed by a space and a closing one
 * may not be preceded by one, which is the usual convention and is what keeps "$5 and $10 each"
 * from turning the middle of the sentence into a formula.
 */
const MATH = /\$\$([^\n]+?)\$\$|\$(?![\s$])([^$\n]+?)(?<!\s)\$/g;

/** Every formula on a line, in document offsets. */
export function mathSpans(line: { from: number; text: string }): MathSpan[] {
  const out: MathSpan[] = [];
  for (const m of line.text.matchAll(MATH)) {
    const at = m.index ?? 0;
    const display = m[1] !== undefined;
    const latex = (display ? m[1] : m[2]) ?? "";
    if (!latex.trim()) continue;
    out.push({ from: line.from + at, to: line.from + at + m[0].length, latex, display });
  }
  return out;
}

/** The formula containing a position, if there is one. */
export function mathAt(state: EditorState, pos: number): MathSpan | null {
  const line = state.doc.lineAt(pos);
  for (const span of mathSpans(line)) if (pos >= span.from && pos <= span.to) return span;
  return null;
}

/* --------------------------------------------------------------- state --- */

const setActive = StateEffect.define<MathSpan | null>();

/**
 * The one formula currently open as a field, if any. Nothing writes to the document while a field
 * is open — the field holds its own text until it commits — so any document change arriving here
 * came from somewhere else: a note synced from disk, an undo. Rather than guess where the formula
 * moved to, close the field and leave the characters alone.
 */
const activeMath = StateField.define<MathSpan | null>({
  create: () => null,
  update(current, tr) {
    for (const effect of tr.effects) if (effect.is(setActive)) return effect.value;
    return tr.docChanged ? null : current;
  },
});

/** For `live.ts`: the range it must not also decorate, or two widgets would claim it. */
export const activeMathSpan = (state: EditorState): MathSpan | null =>
  state.field(activeMath, false) ?? null;

/** Put a field over a formula. Awaits the library so the widget can be built synchronously. */
async function openField(view: EditorView, span: MathSpan): Promise<void> {
  await loadMathLive();
  view.dispatch({ selection: { anchor: span.from }, effects: setActive.of(span) });
}

/* ------------------------------------------------------------- drawing --- */

/** A formula standing in for its source. Read-only: this is the reading view of the note. */
export class MathRender extends WidgetType {
  constructor(
    private readonly latex: string,
    private readonly display: boolean,
  ) {
    super();
  }

  eq(other: MathRender): boolean {
    return other.latex === this.latex && other.display === this.display;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("span");
    box.className = this.display ? "cm-math cm-math-display" : "cm-math";
    box.title = "Edit formula  ⌘E";
    this.draw(box, view);
    /*
     * Clicking the picture of a formula edits the formula. Clicking anywhere else in the block
     * does what it always did — the caret lands in the text and the block shows its source —
     * so the LaTeX is never more than a click away from being ordinary characters again.
     */
    box.addEventListener("mousedown", (event) => {
      const span = mathAt(view.state, view.posAtDOM(box));
      if (!span) return;
      event.preventDefault();
      void openField(view, span);
    });
    return box;
  }

  private draw(box: HTMLElement, view: EditorView): void {
    const markup = mathMarkup(this.latex);
    if (markup !== null) {
      box.innerHTML = markup;
      return;
    }
    // Either the library is still on its way or the LaTeX does not parse — half-written math is
    // the ordinary case, not a failure. Both show the source, which is what the file says anyway.
    box.classList.add("cm-math-raw");
    box.textContent = this.display ? `$$${this.latex}$$` : `$${this.latex}$`;
    whenMathLive(() => {
      const late = mathMarkup(this.latex);
      if (late === null) return;
      box.classList.remove("cm-math-raw");
      box.innerHTML = late;
      // A drawn formula is taller than the line of source it replaced; the editor has measured.
      view.requestMeasure();
    });
  }

  /** A click has to reach the document, or there would be no way to get a caret back into it. */
  ignoreEvent(): boolean {
    return false;
  }
}

/* ------------------------------------------------------------ the field --- */

class MathField extends WidgetType {
  constructor(private readonly span: MathSpan) {
    super();
  }

  /**
   * Compared on position, not on content. Nothing writes to the document while the field is open,
   * so the formula cannot have moved; matching on where it sits is what makes CodeMirror hand
   * back the same element on every redraw — and with it the focus, and the caret inside it.
   */
  eq(other: MathField): boolean {
    return other.span.from === this.span.from && other.span.to === this.span.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("span");
    box.className = this.span.display ? "cm-mathfield cm-mathfield-display" : "cm-mathfield";
    const lib = mathLive();
    if (!lib) return box; // `openField` awaits the load, so nothing reaches this in practice

    const field: MathfieldElement = new lib.MathfieldElement();
    // Set as an attribute rather than the property: the property setters reach into a mathfield
    // that does not exist until the element is connected, and this one has to be in place before
    // then or the keyboard flashes up on the way in.
    field.setAttribute("math-virtual-keyboard-policy", "manual");

    // The LaTeX, beside the formula, editable. Typing `\alpha` here is often faster than finding
    // it on the bar, and seeing the source is how you learn what the buttons are writing.
    const source = document.createElement("input");
    source.className = "cm-mathfield-latex";
    source.spellcheck = false;
    source.value = this.span.latex;

    /*
     * The formula as of the last keystroke, kept here rather than read back at the end.
     * `field.value` is not a plain property: it asks the mathfield MathLive builds on mount, and
     * once that is torn down it answers with an empty string rather than an error. Reading it in
     * a `blur` that arrived *because* the element is going away therefore reports an empty
     * formula, and an empty formula means "delete this one" — which loses the very thing the
     * commit was supposed to save. `input` only fires while the field is mounted and correct.
     */
    let latest = this.span.latex;
    field.addEventListener("input", () => {
      latest = field.value;
      source.value = latest;
    });
    source.addEventListener("input", () => {
      latest = source.value;
      field.setValue(latest, { silenceNotifications: true });
    });

    let settled = false;
    /** Write the formula back into the file. `null` leaves the caret wherever the click went. */
    const commit = (caret: "before" | "after" | null): void => {
      if (settled) return;
      settled = true;
      const open = view.state.field(activeMath);
      if (!open) return;
      const latex = latest.trim();
      // An emptied formula deletes itself. That is the way to take one out, and ⌘Z is one step.
      const body = latex ? (open.display ? `$$${latex}$$` : `$${latex}$`) : "";
      view.dispatch({
        changes: { from: open.from, to: open.to, insert: body },
        selection: { anchor: caret === "before" ? open.from : open.from + body.length },
        effects: setActive.of(null),
      });
      if (caret !== null) view.focus();
    };

    /** Escape belongs to the formula before the editor, which would otherwise close the note. */
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Enter" && event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      commit("after");
    };
    field.addEventListener("keydown", (event) => {
      /*
       * Halfway through a `\command` both keys belong to MathLive — Enter completes it, Escape
       * abandons it — and taking them here would swallow the keystroke that was meant to turn
       * `\sqrt` into a radical.
       */
      if (field.mode === "latex") return;
      onKey(event);
    });
    source.addEventListener("keydown", onKey);

    // An arrow key with nowhere left to go inside the formula means out of it, that way.
    field.addEventListener("move-out", (event) => {
      const { direction } = (event as CustomEvent<{ direction: string }>).detail;
      event.preventDefault();
      commit(direction === "backward" || direction === "upward" ? "before" : "after");
    });

    /*
     * Clicking away keeps what was typed, the same as renaming a node in the graph does — but
     * "away" has to mean away from the whole apparatus. Focus crossing from the formula to the
     * LaTeX box beside it, or to a button on the bar, is still the same formula being edited,
     * and committing on those would close the field the instant you reached for a symbol.
     */
    const onBlur = (): void => {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && (box.contains(active) || bar?.contains(active))) return;
        commit(null);
      });
    };
    field.addEventListener("blur", onBlur);
    source.addEventListener("blur", onBlur);
    field.addEventListener("focus", () => showBar(view, field));

    box.append(field, source);
    /*
     * The rest waits a frame, because none of it works on an unmounted element: MathLive builds
     * the mathfield behind these properties when the element is connected, and CodeMirror has
     * not put the widget on the page yet when `toDOM` returns. Setting `menuItems` early throws
     * "Mathfield not mounted" outright.
     */
    requestAnimationFrame(() => {
      if (!field.isConnected) return; // closed again within the frame
      field.value = this.span.latex;
      field.menuItems = []; // no context menu — the note is the document, not the formula
      /*
       * MathLive ships a table of inline shortcuts that rewrite letters as you type them:
       * `sqrt` becomes a radical, `pi` becomes π, and so on. A formula is often prose about
       * mathematics as much as mathematics — `sqrt` may well be the name of the function being
       * written about — and having it turn into an operator underfoot is not something you can
       * undo a character at a time. A backslash is how you ask for an operator, as in Abitti:
       * `\sqrt` is a radical, `sqrt` is four letters.
       */
      field.inlineShortcuts = {};
      field.focus();
    });
    return box;
  }

  /** Everything inside belongs to the formula; CodeMirror must not read it as its own. */
  ignoreEvent(): boolean {
    return true;
  }

  destroy(): void {
    hideBar();
  }
}

/* --------------------------------------------------------------- the bar --- */

const SYMBOLS: { label: string; latex: string }[] = [
  { label: "·", latex: "\\cdot" },
  { label: "×", latex: "\\times" },
  { label: "±", latex: "\\pm" },
  { label: "∞", latex: "\\infty" },
  { label: "π", latex: "\\pi" },
  { label: "α", latex: "\\alpha" },
  { label: "β", latex: "\\beta" },
  { label: "Δ", latex: "\\Delta" },
  { label: "≠", latex: "\\ne" },
  { label: "≈", latex: "\\approx" },
  { label: "≤", latex: "\\le" },
  { label: "≥", latex: "\\ge" },
  { label: "→", latex: "\\to" },
  { label: "⇌", latex: "\\rightleftharpoons" },
  { label: "∈", latex: "\\in" },
  { label: "ℝ", latex: "\\mathbb{R}" },
];

/**
 * `#0` is a placeholder the caret lands in and Tab moves between; `#@` wraps whatever is already
 * selected, so squaring a term you have just selected is one button rather than a retype.
 */
const TEMPLATES: { label: string; latex: string; title: string }[] = [
  { label: "√", latex: "\\sqrt{#0}", title: "Square root" },
  { label: "ⁿ√", latex: "\\sqrt[#0]{#0}", title: "Nth root" },
  { label: "x²", latex: "#@^{2}", title: "Squared" },
  { label: "xⁿ", latex: "#@^{#0}", title: "Power" },
  { label: "xₙ", latex: "#@_{#0}", title: "Subscript" },
  { label: "a⁄b", latex: "\\frac{#0}{#0}", title: "Fraction" },
  { label: "∫", latex: "\\int_{#0}^{#0}", title: "Integral" },
  { label: "∑", latex: "\\sum_{#0}^{#0}", title: "Sum" },
  { label: "lim", latex: "\\lim_{#0}", title: "Limit" },
  { label: "sin", latex: "\\sin", title: "Sine" },
  { label: "cos", latex: "\\cos", title: "Cosine" },
  { label: "tan", latex: "\\tan", title: "Tangent" },
  { label: "( )", latex: "\\left(#0\\right)", title: "Parentheses" },
  { label: "|x|", latex: "\\left|#0\\right|", title: "Absolute value" },
  { label: "x⃗", latex: "\\vec{#0}", title: "Vector" },
];

/**
 * One bar for the app. It is not a floating strip like the format bar: it takes a row of its own
 * at the top of the pane being edited, so it never covers the note it is writing into, and the
 * two groups keep their own lines — symbols above, templates below — because the order is
 * deliberate and a row that reflows around a formula loses it every time the formula grows.
 */
let bar: HTMLElement | null = null;
let target: MathfieldElement | null = null;

function barElement(): HTMLElement {
  if (bar) return bar;
  const el = document.createElement("div");
  el.className = "math-bar";

  const add = (label: string, title: string, latex: string): void => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", () => target?.insert(latex, { focus: true }));
    el.appendChild(button);
  };
  for (const symbol of SYMBOLS) add(symbol.label, symbol.latex, symbol.latex);
  const nl = document.createElement("i");
  nl.className = "math-bar-break";
  el.appendChild(nl);
  for (const template of TEMPLATES) add(template.label, template.title, template.latex);

  // The whole bar, not just the buttons: a mousedown reaching the page pulls the focus out of
  // the formula, and the blur that follows would close it before the click ever arrived.
  el.addEventListener("mousedown", (event) => event.preventDefault());
  bar = el;
  return el;
}

/** Hangs the bar above the editor whose formula is open, giving it a row of the page. */
function showBar(view: EditorView, field: MathfieldElement): void {
  const el = barElement();
  target = field;
  const host = view.dom.parentElement;
  if (!host) return;
  host.classList.add("with-math-bar");
  if (el.parentElement !== host) host.insertBefore(el, view.dom);
  view.requestMeasure();
}

function hideBar(): void {
  target = null;
  const host = bar?.parentElement;
  bar?.remove();
  host?.classList.remove("with-math-bar");
}

/* ---------------------------------------------------------- the extension --- */

/** ⌘E — open the formula under the caret, or start one from whatever is selected. */
const insertMath: Command = (view) => {
  const { from, to } = view.state.selection.main;
  const here = mathAt(view.state, from);
  // Nothing goes into the document yet: an empty span at the caret is enough to hang a field on,
  // and a formula abandoned before it says anything leaves the note exactly as it was.
  const span: MathSpan = here ?? {
    from,
    to,
    latex: view.state.sliceDoc(from, to).trim(),
    display: false,
  };
  void openField(view, span);
  return true;
};

const fieldDecoration = EditorView.decorations.compute([activeMath], (state) => {
  const span = state.field(activeMath);
  if (!span) return Decoration.none;
  /*
   * A new formula has no characters yet, and a *replacement* covering no characters is a range
   * CodeMirror rejects outright ("Invalid range for replacement decoration"). At a caret the
   * field is an insertion rather than a replacement; only a formula that already exists, or a
   * selection being turned into one, has something to stand in for.
   */
  const widget = new MathField(span);
  const deco =
    span.from === span.to
      ? Decoration.widget({ widget, side: 1 })
      : Decoration.replace({ widget });
  return Decoration.set([deco.range(span.from, span.to)]);
});

/** A note that already has math in it loads the library before the first widget asks for it. */
const warm = ViewPlugin.define((view: EditorView) => {
  if (view.state.doc.toString().includes("$")) void loadMathLive();
  return {};
});

export function math(): Extension {
  return [
    activeMath,
    fieldDecoration,
    warm,
    // High, for the same reason the format bar's keys are: ahead of the editor's own bindings.
    Prec.high(keymap.of([{ key: "Mod-e", run: insertMath }])),
  ];
}
