// Small context menu for the graph canvas. Dismissed by Esc, or by any click
// outside it (including the right-click that would open another menu).

export type MenuItem = { label: string; run: () => void };

let host: HTMLElement | null = null;
let dismiss: (() => void) | null = null;

export function closeMenu(): void {
  dismiss?.();
}

export function showMenu(at: { x: number; y: number }, items: MenuItem[]): void {
  closeMenu();
  if (!host) {
    host = document.createElement("div");
    host.id = "menu";
    document.body.appendChild(host);
  }
  const box = host;
  box.innerHTML = "";
  box.classList.add("open");

  for (const item of items) {
    const button = document.createElement("button");
    button.className = "menu-item";
    button.textContent = item.label;
    button.onclick = () => {
      closeMenu();
      item.run();
    };
    box.appendChild(button);
  }

  // Place it at the cursor, nudged back inside the window when near an edge.
  box.style.left = "0px";
  box.style.top = "0px";
  const { width, height } = box.getBoundingClientRect();
  box.style.left = `${Math.min(at.x, window.innerWidth - width - 8)}px`;
  box.style.top = `${Math.min(at.y, window.innerHeight - height - 8)}px`;

  const onPointerDown = (event: MouseEvent) => {
    if (!box.contains(event.target as Node)) closeMenu();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation(); // don't also cancel a graph draft
    closeMenu();
  };

  dismiss = () => {
    document.removeEventListener("mousedown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    box.classList.remove("open");
    box.innerHTML = "";
    dismiss = null;
  };
  document.addEventListener("mousedown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
}
