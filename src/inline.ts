// A single-line input floated over the graph, used to name a node in place
// instead of blocking on a modal.

/** A name already taken that the field offers while it is typed into: picked, it is used instead. */
export type Suggestion = {
  label: string;
  hint?: string;
  /** The very name typed, of a note right here: Enter takes it rather than making a twin. */
  exact?: boolean;
  pick: () => void;
};

export type InlineEditor = {
  /** Keep it glued to the node while the viewport pans or zooms; `font` follows the zoom. */
  move: (left: number, top: number, font?: number) => void;
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
  /** A name for something that has none yet: no box, nothing filled in — only a caret
      where the name will stand, set the way the name will be (`font` px, wrapping onto a
      new line past a dozen characters). Clicking away from it empty is a change of mind. */
  bare = false,
  /** What is already there by the name being typed: the closest few, listed under the
      caret as it changes. ↓/↑ walk them, Enter or a click takes one; Enter on none keeps
      the typed name. */
  suggest: ((query: string) => Suggestion[]) | null = null,
  font: number | null = null,
  /** How the name will break into lines as a label: the field is made exactly as wide as
      the widest of them, so it wraps where the label will. */
  wrap: ((text: string) => string[]) | null = null,
): InlineEditor {
  // A bare name wraps as the label it becomes does, so it is a textarea that only ever
  // holds one line of text — Enter commits rather than breaking it.
  // Typed as the input: the two share everything used here (value, select, focus, events).
  const input = document.createElement(bare ? "textarea" : "input") as HTMLInputElement;
  input.className = beside ? "inline-edit beside" : "inline-edit";
  if (bare) {
    input.classList.add("bare");
    (input as unknown as HTMLTextAreaElement).rows = 1;
  } else input.type = "text";
  input.spellcheck = false;
  input.value = value;
  input.style.left = `${at.left}px`;
  input.style.top = `${at.top}px`;
  if (font) input.style.fontSize = `${font}px`;
  host.appendChild(input);

  const measure = wrap ? document.createElement("canvas").getContext("2d") : null;
  const fit = (): void => {
    if (!wrap || !measure) return;
    const style = getComputedStyle(input);
    measure.font = `${style.fontSize} ${style.fontFamily}`;
    const widest = Math.max(0, ...wrap(input.value).map((line) => measure.measureText(line).width));
    // A hair over, so the widest line is not itself broken by rounding.
    input.style.width = `${Math.ceil(widest) + 2}px`;
  };

  // The matches: a bare list hanging under the field, no box — only the names, bulleted.
  const list = suggest ? document.createElement("ul") : null;
  let shown: Suggestion[] = [];
  let lit = -1;
  if (list) {
    list.className = "inline-suggest";
    host.appendChild(list);
  }
  const placeList = (): void => {
    if (!list) return;
    list.style.left = input.style.left;
    list.style.top = `${parseFloat(input.style.top) + input.offsetHeight / 2 + 4}px`;
  };
  const paint = (): void => {
    list?.querySelectorAll("li").forEach((li, i) => li.classList.toggle("lit", i === lit));
  };
  const refresh = (): void => {
    if (!list || !suggest) return;
    const query = input.value.trim();
    shown = query ? suggest(query) : [];
    lit = -1;
    list.replaceChildren(
      ...shown.map((one, i) => {
        const li = document.createElement("li");
        li.textContent = one.label;
        if (one.hint) {
          const hint = document.createElement("span");
          hint.className = "inline-suggest-hint";
          hint.textContent = one.hint;
          li.appendChild(hint);
        }
        // mousedown, not click: a click would blur the field first, and blur commits.
        li.addEventListener("mousedown", (event) => {
          event.preventDefault();
          take(i);
        });
        li.addEventListener("mouseenter", () => {
          lit = i;
          paint();
        });
        return li;
      }),
    );
    placeList();
  };

  let settled = false;
  const take = (i: number): void => {
    if (settled || !shown[i]) return;
    settled = true;
    input.remove();
    list?.remove();
    shown[i].pick();
  };
  const finish = (commit: boolean): void => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    input.remove();
    list?.remove();
    if (commit && next && (bare || next !== value)) onCommit(next);
    else onCancel();
  };

  input.addEventListener("keydown", (event) => {
    event.stopPropagation(); // never reach the graph's Esc / the editor
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && shown.length) {
      event.preventDefault();
      // -1 is the typed name itself: past either end of the list is back to it.
      const step = event.key === "ArrowDown" ? 1 : -1;
      lit = ((lit + 1 + step + shown.length + 1) % (shown.length + 1)) - 1;
      paint();
      return;
    }
    const twin = shown.findIndex((one) => one.exact);
    if (event.key === "Enter" && (lit >= 0 || twin >= 0)) {
      event.preventDefault();
      take(lit >= 0 ? lit : twin);
    } else if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    }
    else if (event.key === "Escape") finish(false);
  });
  // Clicking away accepts what was typed, as renaming in Obsidian does.
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("input", () => {
    // A pasted line break is a space: a name is one line, however it wraps.
    if (/[\r\n]/.test(input.value)) input.value = input.value.replace(/\s*[\r\n]+\s*/g, " ");
    fit();
    refresh();
  });

  input.focus();
  input.select();

  return {
    move: (left, top, size) => {
      input.style.left = `${left}px`;
      input.style.top = `${top}px`;
      if (size) input.style.fontSize = `${size}px`;
      fit();
      placeList();
    },
    close: () => finish(false),
  };
}
