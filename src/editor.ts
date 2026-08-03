// One editing surface per pane, and the only place that knows the editor is CodeMirror.
//
// The panes talk to the `Editor` handle below; `format.ts` stays the single place that knows
// what an edit *means*, as pure functions over (text, selection). This file is the join between
// the two — it turns a `Patch` into a transaction and hands the rest to the live-preview layer.

import { Annotation, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { livePreview, wikilinkAt } from "./live";
import { formatting } from "./toolbar";
import type { Vault } from "./vault";

/**
 * Marks a change the app made rather than the person typing, so autosave is not triggered by
 * the very act of loading a note. It does not touch the undo history — an image dropped in is
 * still something ⌘Z should take back out.
 */
const Programmatic = Annotation.define<boolean>();

export type EditorHooks = {
  /** Typing, or an edit the person made. Not fired for `load`, `sync` or `insertAt`. */
  changed: () => void;
  escaped: () => void;
  followLink: (target: string) => void;
  /** Return true when the transfer was consumed — pictures — and false to let text through. */
  pasted: (data: DataTransfer | null) => boolean;
  dropped: (data: DataTransfer | null, pos: number | null) => boolean;
  note: () => string;
  vault: () => Vault;
};

export type Editor = {
  /** CodeMirror's own view. For the format bar, which measures and dispatches directly. */
  view: EditorView;
  text: () => string;
  /** A different note: a fresh state, so undo cannot reach back into the previous one. */
  load: (text: string) => void;
  /** The same note, changed elsewhere. Keeps the caret and the undo history. */
  sync: (text: string) => void;
  /**
   * Splice text in at a document position — null for the caret — on lines of its own.
   * Returns the position just after what was written, so a run of inserts can chain.
   */
  insertAt: (pos: number | null, text: string) => number;
  posAt: (x: number, y: number) => number | null;
  focus: () => void;
  caretToEnd: () => void;
};

const PLACEHOLDER = "# Title\n\nLink notes with [[wikilinks]].";

export function createEditor(parent: HTMLElement, hooks: EditorHooks): Editor {
  const extensions = [
    history(),
    keymap.of([
      { key: "Escape", run: () => (hooks.escaped(), true) },
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    // The format bar, the markdown shortcuts, and the list/indent/wrap typing behaviour.
    formatting(),
    livePreview({ note: hooks.note, vault: hooks.vault }),
    EditorView.lineWrapping,
    placeholder(PLACEHOLDER),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      if (!update.transactions.length) return; // a whole new state — a note was loaded
      if (update.transactions.some((tr) => tr.annotation(Programmatic))) return;
      hooks.changed();
    }),
    EditorView.domEventHandlers({
      // ⌘-click follows a wikilink. A plain click has to stay a plain click: the brackets are
      // literal here, so clicking one is how you edit it.
      mousedown: (event, view) => {
        if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const target = wikilinkAt(view.state, pos);
        if (!target) return false;
        event.preventDefault();
        hooks.followLink(target);
        return true;
      },
      paste: (event) => {
        if (!hooks.pasted(event.clipboardData)) return false;
        event.preventDefault();
        return true;
      },
      drop: (event, view) => {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (!hooks.dropped(event.dataTransfer, pos)) return false;
        event.preventDefault();
        return true;
      },
    }),
  ];

  const view = new EditorView({ state: EditorState.create({ extensions }), parent });

  /*
   * Both panes are built while the graph tab is showing, which means both editors are built
   * inside a `display: none` box. CodeMirror measures its viewport once and caches it, so an
   * editor born with no height keeps a zero-height viewport and draws no lines — a note opened
   * from the graph would come up blank. Nothing in the DOM tells it otherwise, so watch the
   * box: this covers un-hiding, the split, the sidebar drag and the window, in one place.
   */
  new ResizeObserver(() => view.requestMeasure()).observe(parent);

  const load = (text: string): void => {
    view.setState(EditorState.create({ doc: text, extensions }));
    view.scrollDOM.scrollTop = 0;
    view.requestMeasure();
  };

  const sync = (text: string): void => {
    if (view.state.doc.toString() === text) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      annotations: Programmatic.of(true),
    });
  };

  const insertAt = (pos: number | null, text: string): number => {
    const at = pos ?? view.state.selection.main.to;
    const before = view.state.sliceDoc(0, at);
    const after = view.state.sliceDoc(at);
    // An embed wants a line to itself — pad only where the padding is missing.
    const lead = before === "" || before.endsWith("\n") ? "" : "\n";
    const trail = after.startsWith("\n") || after === "" ? "" : "\n";
    const body = `${lead}${text}${trail}`;
    const end = at + lead.length + text.length;
    view.dispatch({
      changes: { from: at, insert: body },
      selection: { anchor: end },
      annotations: Programmatic.of(true),
      scrollIntoView: true,
    });
    return end;
  };

  const caretToEnd = (): void => {
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
  };

  return {
    view,
    text: () => view.state.doc.toString(),
    load,
    sync,
    insertAt,
    posAt: (x, y) => view.posAtCoords({ x, y }),
    focus: () => view.focus(),
    caretToEnd,
  };
}
