// The two things nobody can guess, in the one place they can live without taking up room:
// the gestures the canvas answers to, and the markdown a note understands.
//
// It is a floating panel rather than a page in the vault, because a page in the vault would
// be a node on the graph — a note about the app, sitting in among the notes about your work.

type Row = [string, string];

/** Left column is typed or done; right column is what happens. Nothing else fits. */
const GESTURES: Row[] = [
  ["click a note", "open it"],
  ["click a line", "describe that connection"],
  ["right-drag a note", "link it — drop on a note, or on space"],
  ["right-click a note", "link, rename, delete"],
  ["right-click space", "new note, folder or sticky"],
  ["shift+drag", "draw a folder round some notes"],
  ["drag a note", "move it — push past a box edge to refile"],
  ["drag a box corner", "resize the folder"],
  ["Esc", "cancel a link or a rectangle"],
];

const MARKDOWN: Row[] = [
  ["# Title", "heading (## ### go smaller)"],
  ["**bold**", "bold"],
  ["*italic*", "italic"],
  ["~~struck~~", "struck through"],
  ["==marked==", "highlighted"],
  ["`code`", "code — ``` on its own line for a block"],
  ["- item", "list (1. numbers it)"],
  ["> quoted", "quote"],
  ["[[Note]]", "link a note — this is what draws an edge"],
  ["[[Note|as this]]", "the same link, under another name"],
  ["made with:: [[Note]]", "a named link — the name rides the edge"],
  ["#tag", "tag — colours the note's circle"],
  ["![[picture.png]]", "an image you dropped in"],
  ["[text](https://…)", "a web link"],
];

/** The bar does all of this too — it is here so the bar can stop being needed. */
const EDITING: Row[] = [
  ["select text", "the format bar appears over it"],
  ["⌘B ⌘I ⌘E", "bold, italic, code"],
  ["⌘K / ⌘⇧K", "link a note / a web address"],
  ["type * ` [ (", "wraps the selection instead of replacing it"],
  ["Enter in a list", "carries the bullet down; empty item ends it"],
  ["Tab / ⇧Tab", "indent a list item"],
  ["Esc", "save and go back to reading"],
];

const escape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const table = (title: string, rows: Row[]): string =>
  `<h4>${title}</h4><dl>` +
  rows.map(([key, what]) => `<dt>${escape(key)}</dt><dd>${escape(what)}</dd>`).join("") +
  `</dl>`;

/**
 * Wires the `?` button to a panel that floats over everything. Closes on Esc, on a click
 * outside it and on the button itself, so it never has to be tidied away deliberately.
 */
export function mountHelp(button: HTMLElement, panel: HTMLElement): void {
  panel.innerHTML =
    table("On the graph", GESTURES) + table("Editing", EDITING) + table("In a note", MARKDOWN);

  const show = (open: boolean): void => {
    panel.classList.toggle("hidden", !open);
    button.classList.toggle("on", open);
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation(); // else the document handler below closes it again at once
    show(panel.classList.contains("hidden"));
  });
  panel.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => show(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") show(false);
    // `?` from anywhere except a field somebody is typing in. Some layouts (and every
    // automated key injection) report the unshifted `/` instead, so both are accepted.
    const asked = event.key === "?" || (event.key === "/" && event.shiftKey);
    if (!asked || /^(INPUT|TEXTAREA)$/.test((event.target as HTMLElement)?.tagName)) return;
    show(panel.classList.contains("hidden"));
  });
}
