// Foldable file tree. Folders are selectable: whatever folder is selected is
// where "New note" / "New folder" put things. Rows can be dragged into a folder,
// and right-clicking one hands the path back to the app for a context menu.

import { basename, dirname, noteName, type Entry } from "./vault";

type TreeNode = { name: string; path: string; kind: "file" | "dir"; children: TreeNode[] };

export type SidebarHandlers = {
  onOpen: (path: string) => void;
  onSelectDir: (path: string) => void;
  /** Inline rename committed in the tree; `name` has no extension for notes. */
  onRename: (path: string, kind: "file" | "dir", name: string) => void;
  onDelete: (path: string, kind: "file" | "dir") => void;
  /** Right-click on a row; `at` is in client coordinates. */
  onMenu: (path: string, kind: "file" | "dir", at: { x: number; y: number }) => void;
  /** A row was dropped on a folder ("" = the vault root). */
  onMove: (path: string, kind: "file" | "dir", dir: string) => void;
};

/** Nests a flat entry list, folders before files, alphabetical within each group. */
export function buildTree(entries: Entry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", kind: "dir", children: [] };
  const dirs = new Map<string, TreeNode>([["", root]]);

  const dirNode = (path: string): TreeNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const node: TreeNode = { name: basename(path), path, kind: "dir", children: [] };
    dirs.set(path, node);
    dirNode(dirname(path)).children.push(node);
    return node;
  };

  for (const entry of entries) if (entry.kind === "dir") dirNode(entry.path);
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    dirNode(dirname(entry.path)).children.push({
      name: noteName(entry.path),
      path: entry.path,
      kind: "file",
      children: [],
    });
  }

  const sort = (node: TreeNode): void => {
    node.children.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
    );
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

/** A chevron rather than a glyph: at 11px "▾"/"▸" render as indistinguishable dots. */
const CHEVRON =
  `<svg class="chev" viewBox="0 0 12 12" aria-hidden="true">` +
  `<path d="M4.5 2.5 L8.5 6 L4.5 9.5" fill="none" stroke="currentColor" ` +
  `stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" /></svg>`;

/* The default-issue icons, as every file manager has drawn them forever: a yellow
   folder with its darker tab, a blue page with a folded corner. Inline SVG rather
   than emoji — 📁 renders differently on every platform, these render as themselves.
   The gradient id repeats once per row; every copy is identical, so whichever def
   the browser resolves to, the fill is the same. */
const FOLDER_ICON =
  `<svg class="tree-ico" viewBox="0 0 20 20" aria-hidden="true">` +
  `<path d="M2 5.2C2 4.26 2.76 3.5 3.7 3.5h3.9c.45 0 .88.18 1.2.5l1.5 1.5H2z" fill="#c78e10"/>` +
  `<rect x="2" y="5.6" width="16" height="10.9" rx="1.7" fill="url(#fold-shine)"/>` +
  `<defs><linearGradient id="fold-shine" x1="0" y1="0" x2="0" y2="1">` +
  `<stop offset="0" stop-color="#ffdd75"/><stop offset="1" stop-color="#f6b81f"/>` +
  `</linearGradient></defs></svg>`;

const FILE_ICON =
  `<svg class="tree-ico" viewBox="0 0 20 20" aria-hidden="true">` +
  `<path d="M4.5 4a2 2 0 0 1 2-2h5.4L16 6.1v9.9a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2z" fill="#55d0f7"/>` +
  `<path d="M11.9 2 16 6.1h-3.1a1 1 0 0 1-1-1z" fill="#2f7fd6"/>` +
  `</svg>`;

export class Sidebar {
  private collapsed = new Set<string>();
  private entries: Entry[] = [];
  private activePath: string | null = null;
  /** Path currently being renamed in place, if any. */
  private renaming: string | null = null;
  /** The row being dragged, while a drag is in flight. */
  private drag: { path: string; kind: "file" | "dir" } | null = null;
  /** Folder new items are created in ("" = vault root). */
  activeDir = "";

  constructor(
    private el: HTMLElement,
    private handlers: SidebarHandlers,
  ) {
    this.el.addEventListener("click", (event) => this.onClick(event));
    this.el.addEventListener("contextmenu", (event) => this.onContextMenu(event));
    this.el.addEventListener("dragstart", (event) => this.onDragStart(event));
    this.el.addEventListener("dragover", (event) => this.onDragOver(event));
    this.el.addEventListener("dragleave", (event) => this.onDragLeave(event));
    this.el.addEventListener("drop", (event) => this.onDrop(event));
    this.el.addEventListener("dragend", () => {
      this.drag = null;
      this.markDrop(null);
    });
  }

  render(entries: Entry[], activePath: string | null): void {
    this.entries = entries;
    this.activePath = activePath;
    const known = new Set(entries.filter((e) => e.kind === "dir").map((e) => e.path));
    if (this.activeDir && !known.has(this.activeDir)) this.activeDir = "";
    this.draw();
  }

  private draw(): void {
    const root = buildTree(this.entries);
    this.el.innerHTML = root.children.length
      ? this.rows(root.children)
      : '<div class="empty">No notes yet.</div>';
    this.wireRenameInput();
  }

  /** Starts an in-tree rename; the row becomes a pre-selected input. */
  beginRename(path: string): void {
    this.renaming = path;
    this.draw();
  }

  /** Re-attaching is fine: the input is recreated on every draw(). */
  private wireRenameInput(): void {
    const input = this.el.querySelector<HTMLInputElement>(".inline-name");
    if (!input) return;
    const path = this.renaming;
    const kind = (input.dataset.kind ?? "file") as "file" | "dir";
    const original = input.value;
    let settled = false;

    const finish = (commit: boolean): void => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      this.renaming = null;
      if (commit && path && next && next !== original) this.handlers.onRename(path, kind, next);
      else this.draw();
    };

    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      else if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (event) => event.stopPropagation());
    input.focus();
    input.select();
  }

  private rows(nodes: TreeNode[]): string {
    return `<ul>${nodes.map((node) => this.row(node)).join("")}</ul>`;
  }

  private row(node: TreeNode): string {
    const naming = this.renaming === node.path;
    // A draggable row swallows text selection inside the rename field, so the
    // row being renamed is the one row that cannot be dragged.
    const attrs =
      `data-path="${escapeAttr(node.path)}" data-kind="${node.kind}" ` +
      `draggable="${naming ? "false" : "true"}"`;
    const nameCell = naming
      ? `<input class="inline-name" type="text" spellcheck="false" data-kind="${node.kind}" value="${escapeAttr(node.name)}" />`
      : null;

    if (node.kind === "dir") {
      const open = !this.collapsed.has(node.path);
      const selected = this.activeDir === node.path ? " selected" : "";
      const count = node.children.length;
      return (
        `<li class="dir">` +
        `<div class="item dir-item${selected}" ${attrs}>` +
        `<button class="twisty${open ? " open" : ""}" data-act="toggle" ` +
        `aria-expanded="${open}" title="${open ? "Collapse" : "Expand"}">${CHEVRON}</button>` +
        FOLDER_ICON +
        (nameCell ?? `<span class="name" data-act="selectdir">${escapeHtml(node.name)}</span>`) +
        `<span class="count">${count || ""}</span>` +
        `<span class="actions">` +
        `<button data-act="rename" title="Rename">✎</button>` +
        `<button data-act="delete" title="Delete">✕</button>` +
        `</span></div>` +
        // Kept in the DOM while collapsed so CSS can animate/indent consistently.
        (open && count ? this.rows(node.children) : "") +
        `</li>`
      );
    }
    const active = this.activePath === node.path ? " active" : "";
    return (
      `<li class="file"><div class="item file-item${active}" ${attrs}${naming ? "" : ' data-act="open"'}>` +
      FILE_ICON +
      (nameCell ?? `<span class="name">${escapeHtml(node.name)}</span>`) +
      `<span class="actions">` +
      `<button data-act="rename" title="Rename">✎</button>` +
      `<button data-act="delete" title="Delete">✕</button>` +
      `</span></div></li>`
    );
  }

  private onClick(event: MouseEvent): void {
    const act = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const item = act?.closest<HTMLElement>(".item");
    if (!act || !item) return;
    const path = item.dataset.path ?? "";
    const kind = (item.dataset.kind ?? "file") as "file" | "dir";
    switch (act.dataset.act) {
      case "open":
        this.handlers.onOpen(path);
        break;
      // The chevron folds; the name selects. Separate targets so neither surprises.
      case "toggle":
        if (this.collapsed.has(path)) this.collapsed.delete(path);
        else this.collapsed.add(path);
        this.draw();
        break;
      case "selectdir":
        this.activeDir = this.activeDir === path ? "" : path;
        if (this.activeDir) this.collapsed.delete(path);
        this.handlers.onSelectDir(this.activeDir);
        this.draw();
        break;
      case "rename":
        this.beginRename(path);
        break;
      case "delete":
        this.handlers.onDelete(path, kind);
        break;
    }
  }

  private onContextMenu(event: MouseEvent): void {
    const item = (event.target as HTMLElement).closest<HTMLElement>(".item");
    if (!item) return;
    event.preventDefault();
    this.handlers.onMenu(
      item.dataset.path ?? "",
      (item.dataset.kind ?? "file") as "file" | "dir",
      { x: event.clientX, y: event.clientY },
    );
  }

  /* ------------------------------------------------------------- dragging --- */

  private onDragStart(event: DragEvent): void {
    const item = (event.target as HTMLElement).closest<HTMLElement>(".item");
    if (!item) return;
    this.drag = {
      path: item.dataset.path ?? "",
      kind: (item.dataset.kind ?? "file") as "file" | "dir",
    };
    event.dataTransfer?.setData("text/plain", this.drag.path);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  /** Folder a drop at `target` would land in, or null when it would be a no-op. */
  private dropDir(target: EventTarget | null): string | null {
    if (!this.drag) return null;
    const item = (target as HTMLElement | null)?.closest<HTMLElement>(".item");
    // Dropping on a note means "next to it", i.e. into the folder holding it.
    const dir = !item
      ? "" // the empty space below the tree is the vault root
      : item.dataset.kind === "dir"
        ? (item.dataset.path ?? "")
        : dirname(item.dataset.path ?? "");
    if (dirname(this.drag.path) === dir) return null; // already there
    // A folder cannot swallow itself or anything it contains.
    if (this.drag.kind === "dir" && (dir === this.drag.path || dir.startsWith(this.drag.path + "/")))
      return null;
    return dir;
  }

  private onDragOver(event: DragEvent): void {
    const dir = this.dropDir(event.target);
    this.markDrop(dir);
    if (dir === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }

  private onDragLeave(event: DragEvent): void {
    if (event.target === this.el) this.markDrop(null);
  }

  private onDrop(event: DragEvent): void {
    const dir = this.dropDir(event.target);
    const dragged = this.drag;
    this.markDrop(null);
    this.drag = null;
    if (dir === null || !dragged) return;
    event.preventDefault();
    this.handlers.onMove(dragged.path, dragged.kind, dir);
  }

  /** Highlights the folder a drop would land in; the root highlights the whole tree. */
  private markDrop(dir: string | null): void {
    for (const node of this.el.querySelectorAll(".drop-into")) node.classList.remove("drop-into");
    this.el.classList.toggle("drop-root", dir === "");
    if (!dir) return;
    this.el
      .querySelector(`.item[data-kind="dir"][data-path="${CSS.escape(dir)}"]`)
      ?.classList.add("drop-into");
  }

  /** Keeps a freshly created folder expanded and selected. */
  reveal(path: string): void {
    this.collapsed.delete(path);
    this.activeDir = path;
  }
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => escapeHtml(s).replace(/"/g, "&quot;");
