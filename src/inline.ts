// A single-line input floated over the graph, used to name a node in place
// instead of blocking on a modal.

export type InlineEditor = {
  /** Keep it glued to the node while the viewport pans or zooms. */
  move: (left: number, top: number) => void;
  close: () => void;
};

/**
 * `beside` hangs the field off its anchor to the right, vertically centred — where a
 * node's own label sits — instead of centring it on the anchor, which is right for a
 * point on a line and wrong for a circle the field would then cover.
 */
export function inlineEdit(
  host: HTMLElement,
  at: { left: number; top: number },
  value: string,
  onCommit: (value: string) => void,
  onCancel: () => void,
  beside = false,
): InlineEditor {
  const input = document.createElement("input");
  input.className = beside ? "inline-edit beside" : "inline-edit";
  input.type = "text";
  input.spellcheck = false;
  input.value = value;
  input.style.left = `${at.left}px`;
  input.style.top = `${at.top}px`;
  host.appendChild(input);

  let settled = false;
  const finish = (commit: boolean): void => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    input.remove();
    if (commit && next && next !== value) onCommit(next);
    else onCancel();
  };

  input.addEventListener("keydown", (event) => {
    event.stopPropagation(); // never reach the graph's Esc / the editor
    if (event.key === "Enter") finish(true);
    else if (event.key === "Escape") finish(false);
  });
  // Clicking away accepts what was typed, as renaming in Obsidian does.
  input.addEventListener("blur", () => finish(true));

  input.focus();
  input.select();

  return {
    move: (left, top) => {
      input.style.left = `${left}px`;
      input.style.top = `${top}px`;
    },
    close: () => finish(false),
  };
}
