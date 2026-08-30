// Context menu for the graph canvas. Dismissed by Esc, or by any click outside it
// (including the right-click that would open another menu).
//
// An item can carry an icon (the same tile its node wears on the graph, so the menu
// reads in the graph's own vocabulary) and children — a second panel that opens to the
// right of the row, holding one entry per integration.

export type MenuItem = {
  label: string;
  run?: () => void;
  /** A data-URI image drawn at 16px before the label. */
  icon?: string;
  /** A submenu: this row grows a › and opens these beside it. `run` is ignored. */
  children?: MenuItem[];
};

let host: HTMLElement | null = null;
let child: HTMLElement | null = null;
let dismiss: (() => void) | null = null;

export function closeMenu(): void {
  dismiss?.();
}

const panel = (id: string): HTMLElement => {
  const box = document.createElement("div");
  box.id = id;
  box.className = "menu-panel";
  document.body.appendChild(box);
  return box;
};

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
  if (item.children) {
    const arrow = document.createElement("span");
    arrow.className = "menu-arrow";
    arrow.textContent = "›";
    button.appendChild(arrow);
  }
  button.onclick = onRun;
  return button;
}

function closeChild(): void {
  if (!child) return;
  child.classList.remove("open");
  child.innerHTML = "";
  host?.querySelectorAll(".menu-item.branch-open").forEach((el) => el.classList.remove("branch-open"));
}

/** The submenu, opened beside its row — its own top-left at the row's top-right. */
function openChild(items: MenuItem[], beside: HTMLElement): void {
  if (!child) child = panel("submenu");
  child.innerHTML = "";
  child.classList.add("open");
  beside.classList.add("branch-open");
  for (const item of items) {
    child.appendChild(
      row(item, () => {
        closeMenu();
        item.run?.();
      }),
    );
  }
  const rect = beside.getBoundingClientRect();
  place(child, { x: rect.right + 2, y: rect.top - 4 });
}

export function showMenu(at: { x: number; y: number }, items: MenuItem[]): void {
  closeMenu();
  if (!host) host = panel("menu");
  const box = host;
  box.innerHTML = "";
  box.classList.add("open");

  for (const item of items) {
    const button = row(item, () => {
      if (item.children) {
        // A click on a branch toggles it, for anyone who does not hover.
        if (button.classList.contains("branch-open")) closeChild();
        else {
          closeChild();
          openChild(item.children, button);
        }
        return;
      }
      closeMenu();
      item.run?.();
    });
    if (item.children) {
      button.addEventListener("mouseenter", () => {
        closeChild();
        openChild(item.children!, button);
      });
    } else {
      // Wandering onto a plain row folds whatever branch was open.
      button.addEventListener("mouseenter", () => closeChild());
    }
    box.appendChild(button);
  }

  place(box, at);

  const onPointerDown = (event: MouseEvent) => {
    if (!box.contains(event.target as Node) && !child?.contains(event.target as Node)) closeMenu();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation(); // don't also cancel a graph draft
    closeMenu();
  };

  dismiss = () => {
    document.removeEventListener("mousedown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    closeChild();
    box.classList.remove("open");
    box.innerHTML = "";
    dismiss = null;
  };
  document.addEventListener("mousedown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
}
