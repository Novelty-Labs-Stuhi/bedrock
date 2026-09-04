// Context menu for the graph canvas. Dismissed by Esc, or by any click outside it
// (including the right-click that would open another menu).
//
// An item can carry an icon (the same tile its node wears on the graph, so the menu
// reads in the graph's own vocabulary) and children — a panel that opens to the right of
// the row. Children nest to any depth, which is what "Attach → Notion page → which page"
// needs: the last level is a list of real things out there, so it cannot be written down
// in advance and is fetched when the row is opened.

export type MenuItem = {
  label: string;
  run?: () => void;
  /** A data-URI image drawn at 16px before the label. */
  icon?: string;
  /**
   * A submenu: this row grows a › and opens these beside it. With a `run` as well, the
   * row does two things: hovering opens the branch, clicking runs — "Existing node" opens
   * its search on hover and starts the arrow on a click.
   *
   * A function instead of an array is a submenu nobody knows the contents of yet — the
   * pages in a workspace, the sessions on this machine. It is called when the row is
   * opened, not when the menu is built, so opening a menu never waits on a network call
   * and a list nobody looked at is never fetched.
   */
  children?: MenuItem[] | (() => Promise<MenuItem[]>);
  /**
   * A branch that is SEARCHED rather than scrolled: its panel opens with a type box as the
   * first row and shows at most `limit` (8) of the children that match what is typed, by
   * label or hint. The children are still loaded once, when the row opens — typing only
   * narrows them. Enter takes the highlighted row; ↑↓ move it.
   */
  search?: { placeholder?: string; limit?: number };
  /** Drawn dimmer and to the right — a date, a folder, whatever tells two rows apart. */
  hint?: string;
  /** Unselectable: a heading, a "nothing here" line, or a list still loading. */
  inert?: boolean;
};

/**
 * The open panels, root first. Everything about closing is expressed on this: opening a
 * submenu at depth N discards every panel deeper than N, so a menu can never be left
 * showing two branches of the same row.
 */
let panels: HTMLElement[] = [];
let dismiss: (() => void) | null = null;

export function closeMenu(): void {
  dismiss?.();
}

function panel(depth: number): HTMLElement {
  const box = document.createElement("div");
  box.className = "menu-panel open";
  // Each level above its parent, so a deep submenu never slides under a shallow one.
  box.style.zIndex = String(60 + depth);
  document.body.appendChild(box);
  return box;
}

/** Top-left corner exactly at `at`; pulled back inside the window only when it must be. */
function place(box: HTMLElement, at: { x: number; y: number }): void {
  box.style.left = "0px";
  box.style.top = "0px";
  const { width, height } = box.getBoundingClientRect();
  box.style.left = `${Math.max(0, Math.min(at.x, window.innerWidth - width - 8))}px`;
  box.style.top = `${Math.max(0, Math.min(at.y, window.innerHeight - height - 8))}px`;
}

function row(item: MenuItem, onRun: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "menu-item";
  if (item.inert) button.classList.add("menu-inert");
  if (item.icon) {
    const img = document.createElement("img");
    img.className = "menu-icon";
    img.src = item.icon;
    img.alt = "";
    button.appendChild(img);
  }
  const text = document.createElement("span");
  text.className = "menu-label";
  text.textContent = item.label;
  button.appendChild(text);
  if (item.hint) {
    const hint = document.createElement("span");
    hint.className = "menu-hint";
    hint.textContent = item.hint;
    button.appendChild(hint);
  }
  if (item.children) {
    const arrow = document.createElement("span");
    arrow.className = "menu-arrow";
    arrow.textContent = "›";
    button.appendChild(arrow);
  }
  if (!item.inert) button.onclick = onRun;
  return button;
}

/** Throws away every panel deeper than `depth`, and unmarks the rows that opened them. */
function collapseTo(depth: number): void {
  while (panels.length > depth + 1) {
    const box = panels.pop();
    box?.remove();
  }
  panels[depth]?.querySelectorAll(".menu-item.branch-open").forEach((el) => el.classList.remove("branch-open"));
}

/**
 * Fills a panel with rows, wiring each branch to open the next panel beside it.
 *
 * `token` is the identity of the menu this fill belongs to. A lazy submenu resolves after
 * an await, by which time the menu may have been dismissed and reopened — the token is how
 * a late answer knows not to draw itself into somebody else's menu.
 */
function fill(box: HTMLElement, items: MenuItem[], depth: number, token: object): void {
  box.innerHTML = "";
  for (const item of items) {
    const button = row(item, () => {
      if (item.children && !item.run) {
        // A click on a branch toggles it, for anyone who does not hover.
        if (button.classList.contains("branch-open")) collapseTo(depth);
        else void openBranch(item, button, depth, token);
        return;
      }
      closeMenu();
      item.run?.();
    });
    if (item.children) {
      button.addEventListener("mouseenter", () => void openBranch(item, button, depth, token));
    } else {
      // Wandering onto a plain row folds whatever branch was open beside it.
      button.addEventListener("mouseenter", () => collapseTo(depth));
    }
    box.appendChild(button);
  }
}

/**
 * A searched panel: the type box, then the few rows that match it. The box keeps the
 * keyboard — its keys must not reach the graph, where a letter is a shortcut — and paints
 * the rows again on every keystroke, so the panel is never longer than `limit` rows.
 */
function fillSearch(
  box: HTMLElement,
  items: MenuItem[],
  search: NonNullable<MenuItem["search"]>,
  onPainted: () => void,
): void {
  const limit = search.limit ?? 8;
  // Inert rows are the panel's own words — where it is searching, say — and stay under the
  // matches whatever is typed; only the real rows are searched.
  const fixed = items.filter((one) => one.inert);
  const searchable = items.filter((one) => !one.inert);
  box.innerHTML = "";
  const input = document.createElement("input");
  input.className = "menu-search";
  input.type = "text";
  input.spellcheck = false;
  input.placeholder = search.placeholder ?? "Type to search…";
  const list = document.createElement("div");
  list.className = "menu-results";
  box.append(input, list);

  let shown: MenuItem[] = [];
  let active = 0;
  // The highlight moves without rebuilding the rows: a rebuilt row under the pointer fires
  // mouseenter again, and that was a loop that ate every click and keystroke.
  const highlight = (): void => {
    [...list.children].forEach((el, index) => el.classList.toggle("branch-open", index === active && index < shown.length));
  };
  const paint = (): void => {
    const query = input.value.trim().toLowerCase();
    // Names first; a folder only counts once the names have run out, so typing a word
    // that happens to be in every folder does not leave the list standing still.
    const byName = query ? searchable.filter((one) => one.label.toLowerCase().includes(query)) : searchable;
    const byHint = query ? searchable.filter((one) => !byName.includes(one) && (one.hint ?? "").toLowerCase().includes(query)) : [];
    const matches = byName.concat(byHint);
    shown = matches.slice(0, limit);
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.innerHTML = "";
    if (!shown.length) {
      list.appendChild(row({ label: query ? "nothing matches" : "nothing here", inert: true }, () => {}));
    }
    shown.forEach((item, index) => {
      const button = row(item, () => {
        closeMenu();
        item.run?.();
      });
      if (index === active) button.classList.add("branch-open");
      button.addEventListener("mouseenter", () => {
        active = index;
        highlight();
      });
      list.appendChild(button);
    });
    // How much is not being shown — the panel never grows, so it says so and asks for more.
    if (matches.length > shown.length) {
      list.appendChild(row({ label: `${shown.length} of ${matches.length} — keep typing`, inert: true }, () => {}));
    }
    for (const one of fixed) list.appendChild(row(one, () => {}));
    onPainted();
  };
  input.oninput = () => {
    active = 0;
    paint();
  };
  input.onkeydown = (event) => {
    event.stopPropagation(); // the graph's own shortcuts stay out of this
    if (event.key === "ArrowDown" && shown.length) {
      event.preventDefault();
      active = (active + 1) % shown.length;
      highlight();
    } else if (event.key === "ArrowUp" && shown.length) {
      event.preventDefault();
      active = (active - 1 + shown.length) % shown.length;
      highlight();
    } else if (event.key === "Enter" && shown[active]) {
      event.preventDefault();
      const picked = shown[active];
      closeMenu();
      picked.run?.();
    }
  };
  paint();
  input.focus();
}

/** The submenu, opened beside its row — its own top-left at the row's top-right. */
async function openBranch(
  item: MenuItem,
  beside: HTMLElement,
  depth: number,
  token: object,
): Promise<void> {
  if (beside.classList.contains("branch-open")) return; // already showing; hovering again is not a request
  collapseTo(depth);
  beside.classList.add("branch-open");
  const box = panel(depth + 1);
  panels.push(box);
  const anchor = (): void => {
    const rect = beside.getBoundingClientRect();
    place(box, { x: rect.right + 2, y: rect.top - 4 });
  };

  // Rows either way, searched when the branch says so — and a search box is focused as it
  // opens, which is the whole point of it: hover, type, Enter.
  const show = (rows: MenuItem[]): void => {
    if (item.search) fillSearch(box, rows, item.search, anchor);
    else fill(box, rows, depth + 1, token);
    anchor();
  };
  if (typeof item.children !== "function") {
    show(item.children ?? []);
    return;
  }
  // A list from somewhere else: say so, then replace it in place. Sized and positioned
  // while it says "Loading…" too, so the panel does not jump once the answer lands.
  fill(box, [{ label: "Loading…", inert: true }], depth + 1, token);
  anchor();
  let loaded: MenuItem[];
  try {
    loaded = await item.children();
  } catch (err) {
    loaded = [{ label: (err as Error).message, inert: true }];
  }
  // Dismissed, reopened, or collapsed past while the answer was in flight.
  if (token !== openToken || !panels.includes(box)) return;
  show(loaded.length || item.search ? loaded : [{ label: "nothing to attach to", inert: true }]);
}

/** Identity of the currently open menu — see `fill`. */
let openToken: object = {};

/**
 * `onClose` runs however the menu goes away — a row picked, a click elsewhere, Esc — so a
 * caller that lit something up for the menu's sake can put it out again.
 */
export function showMenu(at: { x: number; y: number }, items: MenuItem[], onClose?: () => void): void {
  closeMenu();
  const token = {};
  openToken = token;
  const box = panel(0);
  panels = [box];
  fill(box, items, 0, token);
  place(box, at);

  const onPointerDown = (event: MouseEvent) => {
    if (!panels.some((p) => p.contains(event.target as Node))) closeMenu();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Typing into a search box is the menu's own business; only Esc is everyone's.
    if (event.key !== "Escape") return;
    event.stopPropagation(); // don't also cancel a graph draft
    closeMenu();
  };

  dismiss = () => {
    document.removeEventListener("mousedown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    for (const p of panels) p.remove();
    panels = [];
    openToken = {};
    dismiss = null;
    onClose?.();
  };
  document.addEventListener("mousedown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
}
