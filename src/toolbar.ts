// The format bar: a strip of buttons that appears over whatever text is selected, plus the
// keyboard shortcuts and the typing behaviour that make it unnecessary once you know them.
//
// Every action is a pure function in `format.ts` returning a `Patch`; all this file does is
// read the selection, apply the patch as a transaction, and put the bar somewhere sensible.
// The editor's own history takes care of undo — one patch is one step.

import { Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  keymap,
  type Command,
  type KeyBinding,
  type ViewUpdate,
} from "@codemirror/view";
import * as md from "./format";
import type { Patch } from "./format";

type Action = {
  label: string;
  /** Styling hook, so the button can look like what it does (`B` bold, `S` struck through). */
  cls?: string;
  title: string;
  run: (text: string, start: number, end: number) => Patch | null;
};

const bold = (t: string, s: number, e: number): Patch => md.toggleWrap(t, s, e, "**");
const italic = (t: string, s: number, e: number): Patch => md.toggleWrap(t, s, e, "*");

/** Five groups, dividers between them. Order is by how often a note needs each one. */
const GROUPS: Action[][] = [
  [
    { label: "B", cls: "f-b", title: "Bold  ⌘B", run: bold },
    { label: "I", cls: "f-i", title: "Italic  ⌘I", run: italic },
    { label: "S", cls: "f-s", title: "Strikethrough", run: (t, s, e) => md.toggleWrap(t, s, e, "~~") },
    { label: "A", cls: "f-hl", title: "Highlight", run: (t, s, e) => md.toggleWrap(t, s, e, "==") },
    { label: "<>", title: "Code — a block if it spans lines  ⌘E", run: md.code },
  ],
  [
    { label: "H", title: "Heading — H1, H2, H3, then off", run: md.heading },
    { label: "•", title: "Bullet list", run: md.bullets },
    { label: "1.", title: "Numbered list", run: md.numbers },
    { label: "❝", title: "Quote", run: md.quote },
  ],
  [
    { label: "[[ ]]", title: "Link a note — this draws the edge  ⌘K", run: md.wikilink },
    { label: "↗", title: "Web link  ⌘⇧K", run: md.link },
    { label: "#", title: "Tag — colours the note's circle", run: md.tag },
  ],
  [
    { label: "AA", title: "UPPERCASE", run: (t, s, e) => md.setCase(t, s, e, "upper") },
    { label: "aa", title: "lowercase", run: (t, s, e) => md.setCase(t, s, e, "lower") },
    { label: "Aa", title: "Title Case", run: (t, s, e) => md.setCase(t, s, e, "title") },
  ],
  [{ label: "✕", title: "Clear formatting", run: md.clear }],
];

/** Writes a patch and leaves the selection where the patch asked for it. */
export function applyPatch(view: EditorView, patch: Patch): void {
  view.dispatch({
    changes: { from: patch.from, to: patch.to, insert: patch.insert },
    selection: { anchor: patch.select[0], head: patch.select[1] },
    scrollIntoView: true,
  });
  view.focus();
}

/* -------------------------------------------------------------- the bar --- */

/** One bar for the whole app; both panes borrow it. Built on the first editor mounted. */
let bar: HTMLElement | null = null;
/** The editor the bar is currently attached to — also the editor its buttons act on. */
let host: EditorView | null = null;

function hide(): void {
  host = null;
  bar?.classList.add("hidden");
}

function barElement(): HTMLElement {
  if (bar) return bar;
  const el = document.createElement("div");
  el.className = "format-bar hidden";
  for (const group of GROUPS) {
    if (el.childElementCount) el.appendChild(document.createElement("i"));
    for (const action of group) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.title = action.title;
      if (action.cls) button.className = action.cls;
      button.addEventListener("click", () => {
        // `host` is still set and still focused: the bar's own mousedown is prevented below.
        if (!host) return;
        const { from, to } = host.state.selection.main;
        const patch = action.run(host.state.doc.toString(), from, to);
        if (patch) applyPatch(host, patch);
      });
      el.appendChild(button);
    }
  }
  // The whole bar, not just the buttons: a mousedown reaching the document blurs the editor,
  // and a blurred editor has no selection left to format.
  el.addEventListener("mousedown", (event) => event.preventDefault());
  document.body.appendChild(el);
  window.addEventListener("resize", () => {
    if (host) place(host);
  });
  bar = el;
  return el;
}

function place(view: EditorView): void {
  const el = barElement();
  const { from, to } = view.state.selection.main;
  const start = view.coordsAtPos(from);
  if (!start) return hide();

  const box = view.dom.getBoundingClientRect();
  const line = start.bottom - start.top;
  // Scrolled out of the editor's own window: there is nothing left to point at.
  if (start.top < box.top - line || start.top > box.bottom) return hide();

  el.classList.remove("hidden");
  const width = el.offsetWidth;
  let top = start.top - el.offsetHeight - 8;
  if (top < 4) top = start.top + line + 8; // no room above — sit under the line instead

  // A run spanning lines has no width worth centring on; a single-line one does.
  const end = view.coordsAtPos(to);
  const span = end && Math.abs(end.top - start.top) < 1 ? end.right - start.left : 0;
  // Held inside the editor's own box rather than the window's: a selection near the left
  // margin would otherwise push the bar out over the sidebar.
  const left = Math.min(
    Math.max(start.left + span / 2 - width / 2, Math.max(box.left + 4, 8)),
    Math.max(box.right - width - 4, 8),
  );
  el.style.top = `${Math.round(top)}px`;
  el.style.left = `${Math.round(left)}px`;
}

/**
 * One signal for every way a selection can change — dragging, shift+arrows, ⌘A, and the
 * reselect each edit does. The measurement waits a frame because selecting text reveals its
 * block, and a revealed block reflows: measuring first would anchor the bar to the old layout.
 */
const barPlugin = ViewPlugin.define((view: EditorView) => {
  const onScroll = (): void => {
    if (host === view) place(view);
  };
  view.scrollDOM.addEventListener("scroll", onScroll);

  return {
    update(update: ViewUpdate): void {
      const moved =
        update.selectionSet || update.docChanged || update.focusChanged || update.geometryChanged;
      if (!moved) return;
      if (!update.view.hasFocus || update.view.state.selection.main.empty) {
        if (host === update.view) hide();
        return;
      }
      host = update.view;
      requestAnimationFrame(() => {
        if (host === update.view) place(update.view);
      });
    },
    destroy(): void {
      view.scrollDOM.removeEventListener("scroll", onScroll);
      if (host === view) hide();
    },
  };
});

/* ------------------------------------------------------------ the keys --- */

/** An action bound to a key: applied if it means something here, passed on if it does not. */
const patcher =
  (action: Action["run"]): Command =>
  (view) => {
    const { from, to } = view.state.selection.main;
    const patch = action(view.state.doc.toString(), from, to);
    if (!patch) return false;
    applyPatch(view, patch);
    return true;
  };

/** Enter continues a list or a quote. With text selected it is an ordinary Enter. */
const onEnter: Command = (view) => {
  const { from, to } = view.state.selection.main;
  if (from !== to) return false;
  const patch = md.continueLine(view.state.doc.toString(), from);
  if (!patch) return false;
  applyPatch(view, patch);
  return true;
};

/** Tab indents list items. Anywhere else it falls through, so Tab still moves focus. */
const onTab = (out: boolean): Command => (view) => {
  const { from, to } = view.state.selection.main;
  const patch = md.indent(view.state.doc.toString(), from, to, out);
  if (!patch) return false;
  applyPatch(view, patch);
  return true;
};

const KEYS: KeyBinding[] = [
  { key: "Mod-b", run: patcher(bold) },
  { key: "Mod-i", run: patcher(italic) },
  { key: "Mod-e", run: patcher(md.code) },
  { key: "Mod-k", run: patcher(md.wikilink) },
  { key: "Mod-Shift-k", run: patcher(md.link) },
  { key: "Enter", run: onEnter },
  { key: "Tab", run: onTab(false) },
  { key: "Shift-Tab", run: onTab(true) },
];

/**
 * Typing `*` or `[` with text selected wraps it rather than replacing it. Read from the input
 * handler rather than a keypress so it follows the keyboard layout, whatever it is.
 */
const onType = (view: EditorView, from: number, to: number, text: string): boolean => {
  if (text.length !== 1) return false;
  const patch = md.typedWrap(view.state.doc.toString(), from, to, text);
  if (!patch) return false;
  applyPatch(view, patch);
  return true;
};

/**
 * The bar, the shortcuts and the typing behaviour, as one extension. High precedence so Enter
 * and Tab reach these before the editor's default bindings get them.
 */
export function formatting(): Extension {
  barElement();
  return [Prec.high(keymap.of(KEYS)), Prec.high(EditorView.inputHandler.of(onType)), barPlugin];
}
