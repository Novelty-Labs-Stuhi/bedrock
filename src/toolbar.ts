// The format bar: a strip of buttons that appears over whatever text is selected, plus the
// keyboard shortcuts and the typing behaviour that make it unnecessary once you know them.
//
// Two things here are less obvious than they look:
//
//   - A textarea has no selection RECTANGLE, only character offsets. The position comes from
//     a throwaway mirror div wearing the textarea's own metrics — see `caretRect`.
//   - Every edit goes through `execCommand("insertText")`. It is deprecated, and it is still
//     the only way to change a textarea without wiping the browser's undo stack; assigning
//     to `.value` would make ⌘Z jump back past everything you had typed.

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

/** Everything the mirror has to wear for its text to wrap exactly as the textarea's does. */
const MIRRORED = [
  "boxSizing",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "letterSpacing",
  "lineHeight",
  "textIndent",
  "textTransform",
  "wordSpacing",
  "tabSize",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
] as const;

type Anchor = { top: number; left: number; width: number; height: number };

/**
 * Where the selection actually sits on screen. A copy of the textarea's text is laid out in
 * a hidden div with the same font, padding and width, with the selected run in a span — the
 * span's box, less the textarea's scroll, is the answer. It reads the selection start, so a
 * selection dragged over ten lines still anchors to its first one.
 */
function caretRect(ta: HTMLTextAreaElement): Anchor | null {
  const cs = getComputedStyle(ta);
  const mirror = document.createElement("div");
  for (const prop of MIRRORED) mirror.style[prop] = cs[prop];
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.width = `${ta.clientWidth}px`;
  mirror.style.height = "auto";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.textContent = ta.value.slice(0, ta.selectionStart);

  const run = document.createElement("span");
  // An empty span has no box to measure; a stop stands in for one while it is being placed.
  run.textContent = ta.value.slice(ta.selectionStart, ta.selectionEnd) || ".";
  mirror.appendChild(run);
  document.body.appendChild(mirror);
  const top = run.offsetTop;
  const left = run.offsetLeft;
  const width = run.offsetWidth;
  mirror.remove();

  const box = ta.getBoundingClientRect();
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
  return {
    top: box.top + top - ta.scrollTop,
    left: box.left + left - ta.scrollLeft,
    // A run spanning lines has no meaningful width to centre on; only a single line does.
    width: ta.value.slice(ta.selectionStart, ta.selectionEnd).includes("\n") ? 0 : width,
    height: line,
  };
}

/** Mounts the bar and takes over the editing keys for the given editors. */
export function mountToolbar(editors: HTMLTextAreaElement[]): void {
  const bar = document.createElement("div");
  bar.className = "format-bar hidden";
  for (const group of GROUPS) {
    if (bar.childElementCount) bar.appendChild(document.createElement("i"));
    for (const action of group) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.title = action.title;
      if (action.cls) button.className = action.cls;
      button.addEventListener("click", () => run(action));
      bar.appendChild(button);
    }
  }
  // The whole bar, not just the buttons: a mousedown that reaches the document blurs the
  // textarea, and a blurred textarea has no selection left to format.
  bar.addEventListener("mousedown", (event) => event.preventDefault());
  document.body.appendChild(bar);

  /** The editor the bar is currently attached to, if any. */
  let host: HTMLTextAreaElement | null = null;
  /** True while an edit is being written, so our own input events are not read as typing. */
  let applying = false;

  const hide = (): void => {
    host = null;
    bar.classList.add("hidden");
  };

  function place(ta: HTMLTextAreaElement): void {
    const at = caretRect(ta);
    const box = ta.getBoundingClientRect();
    // Scrolled out of the editor's own window: there is nothing to point at.
    if (!at || at.top < box.top - at.height || at.top > box.bottom) return hide();

    bar.classList.remove("hidden");
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    let top = at.top - height - 8;
    if (top < 4) top = at.top + at.height + 8; // no room above — sit under the line instead
    // Held inside the editor's own box rather than the window's: a selection near the left
    // margin would otherwise push the bar out over the sidebar.
    const left = Math.min(
      Math.max(at.left + at.width / 2 - width / 2, Math.max(box.left + 4, 8)),
      Math.max(box.right - width - 4, 8),
    );
    bar.style.top = `${Math.round(top)}px`;
    bar.style.left = `${Math.round(left)}px`;
  }

  /**
   * Writes a patch through the browser's own editing command, so the change joins the undo
   * stack instead of replacing it. The selection the patch asks for is restored afterwards —
   * that is what lets B then I be pressed one after the other without reselecting.
   */
  function applyPatch(ta: HTMLTextAreaElement, patch: Patch): void {
    ta.focus();
    ta.setSelectionRange(patch.from, patch.to);
    applying = true;
    let done = false;
    try {
      if (patch.insert === "") done = patch.from === patch.to || document.execCommand("delete");
      else done = document.execCommand("insertText", false, patch.insert);
    } finally {
      applying = false;
    }
    if (!done) {
      // No execCommand: the edit still has to land, undo stack or not.
      ta.setRangeText(patch.insert, patch.from, patch.to, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
    ta.setSelectionRange(patch.select[0], patch.select[1]);
  }

  function run(action: Action): void {
    // Resolved at click time, not from what the last measurement happened to leave behind:
    // the bar's mousedown is prevented, so the editor still holds focus when this fires.
    const active = document.activeElement;
    const ta = active instanceof HTMLTextAreaElement && editors.includes(active) ? active : host;
    if (!ta) return;
    const patch = action.run(ta.value, ta.selectionStart, ta.selectionEnd);
    if (patch) applyPatch(ta, patch);
  }

  /** The shortcut for a key combination, or null when the key is not one of ours. */
  function shortcut(event: KeyboardEvent): Action["run"] | null {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
    switch (event.key.toLowerCase()) {
      case "b":
        return bold;
      case "i":
        return italic;
      case "e":
        return md.code;
      case "k":
        return event.shiftKey ? md.link : md.wikilink;
      default:
        return null;
    }
  }

  function onKeyDown(ta: HTMLTextAreaElement, event: KeyboardEvent): void {
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;

    if (event.key === "Enter" && plain && !event.shiftKey && ta.selectionStart === ta.selectionEnd) {
      const patch = md.continueLine(ta.value, ta.selectionStart);
      if (!patch) return;
      event.preventDefault();
      applyPatch(ta, patch);
      return;
    }

    if (event.key === "Tab" && plain) {
      const patch = md.indent(ta.value, ta.selectionStart, ta.selectionEnd, event.shiftKey);
      if (!patch) return; // not a list and not a block — let Tab move focus, as it should
      event.preventDefault();
      applyPatch(ta, patch);
      return;
    }

    const action = shortcut(event);
    if (!action) return;
    event.preventDefault();
    const patch = action(ta.value, ta.selectionStart, ta.selectionEnd);
    if (patch) applyPatch(ta, patch);
  }

  /**
   * Typing `*` or `[` with text selected wraps it rather than replacing it. Read from
   * `beforeinput` rather than a keypress so it follows the keyboard layout, whatever it is.
   */
  function onBeforeInput(ta: HTMLTextAreaElement, event: InputEvent): void {
    if (applying || event.inputType !== "insertText" || event.data?.length !== 1) return;
    const patch = md.typedWrap(ta.value, ta.selectionStart, ta.selectionEnd, event.data);
    if (!patch) return;
    event.preventDefault();
    applyPatch(ta, patch);
  }

  for (const ta of editors) {
    ta.addEventListener("keydown", (event) => onKeyDown(ta, event));
    ta.addEventListener("beforeinput", (event) => onBeforeInput(ta, event as InputEvent));
    ta.addEventListener("scroll", () => {
      if (host === ta) place(ta);
    });
    // Clicking the bar cannot blur it (mousedown is prevented above), so any blur that does
    // arrive is somebody leaving the editor — a tab, the tree, the Read button.
    ta.addEventListener("blur", hide);
  }

  /**
   * One signal for every way a selection can change — dragging, shift+arrows, ⌘A, and the
   * reselect each edit does — collapsed to one measurement per frame.
   */
  let queued = false;
  document.addEventListener("selectionchange", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const active = document.activeElement;
      if (
        !(active instanceof HTMLTextAreaElement) ||
        !editors.includes(active) ||
        active.selectionStart === active.selectionEnd
      ) {
        return hide();
      }
      host = active;
      place(active);
    });
  });

  window.addEventListener("resize", () => {
    if (host) place(host);
  });
}
