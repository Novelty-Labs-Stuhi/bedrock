import "./style.css";
import { GraphView, type Doc } from "./graph";
import { LinkResolver, labelledLink, relinkText } from "./links";
import { askConfirm, askText } from "./dialog";
import { EDGE_DIR, edgeNotePath, edgeNoteTemplate, edgeTitle, isEdgeNote, renamedEdgeNote } from "./edges";
import { showMenu } from "./menu";
import { mountHelp } from "./help";
import { hydrateImages, imageFiles, insertAtCaret, saveImage } from "./images";
import { linkTargets, renderMarkdown } from "./markdown";
import { Sidebar } from "./sidebar";
import { mountToolbar } from "./toolbar";
import { SpatialStore } from "./spatial";
import { StickyStore } from "./sticky";
import {
  FolderVault,
  LocalVault,
  basename,
  canPickFolder,
  dirname,
  isMarkdown,
  join,
  noteName,
  parts,
  uniquePath,
  type Entry,
  type Vault,
} from "./vault";

/** The graph is just another open tab, as in Obsidian. */
type Tab = { kind: "file"; path: string } | { kind: "graph" };

/**
 * One side of the split. Read/edit and the pending save are per pane, so the two
 * sides never fight over a mode or over each other's buffer.
 */
type Pane = { tabs: Tab[]; active: number; mode: "edit" | "read"; timer?: number };

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const ui = {
  app: el("app"),
  sidebar: el("sidebar"),
  foldSide: el<HTMLButtonElement>("fold-side"),
  sideResize: el("side-resize"),
  vaultName: el("vault-name"),
  openFolder: el<HTMLButtonElement>("open-folder"),
  newNote: el<HTMLButtonElement>("new-note"),
  newFolder: el<HTMLButtonElement>("new-folder"),
  graph: el<HTMLButtonElement>("graph"),
  crumb: el("crumb"),
  tree: el("tree"),
  panes: el("panes"),
  splitter: el("splitter"),
  cy: el("cy"),
  status: el("status"),
  help: el("help"),
  helpPanel: el("help-panel"),
};

mountHelp(ui.help, ui.helpPanel);

type PaneUI = {
  root: HTMLElement;
  tabs: HTMLElement;
  actions: HTMLElement;
  page: HTMLElement;
  empty: HTMLElement;
  editor: HTMLTextAreaElement;
  preview: HTMLElement;
};

/** Both panes exist in the DOM from the start; the right one is hidden until split. */
const view: PaneUI[] = [0, 1].map((i) => ({
  root: el(`pane-${i}`),
  tabs: el(`tabs-${i}`),
  actions: el(`actions-${i}`),
  page: el(`page-${i}`),
  empty: el(`empty-${i}`),
  editor: el<HTMLTextAreaElement>(`editor-${i}`),
  preview: el(`preview-${i}`),
}));

// Selection toolbar, markdown shortcuts and the list/indent/wrap typing behaviour, for
// both editors. It reads and writes the textareas directly — no state of the app's own.
mountToolbar(view.map((v) => v.editor));

const MAX_PANES = 2;
const SIDE_KEY = "obsidian-lite:sidebar";
const ROOT_KEY = "obsidian-lite:root:";

let vault: Vault = new LocalVault();
/** The graph's arrangement, cached in the vault's own `.notes/` folder. */
const spatial = new SpatialStore();
/** Loose text pinned to the canvas — kept apart from the layout cache, it is not derived. */
const stickies = new StickyStore();
let entries: Entry[] = [];
/** The graph is pinned as the first tab of the left pane and is never closed. */
let panes: Pane[] = [{ tabs: [{ kind: "graph" }], active: 0, mode: "read" }];
let focused = 0;
/** Edits while the graph tab is hidden are folded into the next time it is shown. */
let graphStale = true;
let lastFile: string | null = null;

const pane = (index = focused): Pane => panes[index] ?? panes[0];
const tabOf = (p: Pane): Tab | undefined => p.tabs[p.active];
const pathOf = (p: Pane): string | null => {
  const tab = tabOf(p);
  return tab?.kind === "file" ? tab.path : null;
};

const sidebar = new Sidebar(ui.tree, {
  onOpen: (path) => void openFile(path),
  onSelectDir: (path) => {
    ui.crumb.textContent = "/" + path;
  },
  onNewNote: (dir) => void newNote(dir),
  onRename: (path, kind, name) => void applyRename(path, kind, name),
  onDelete: (path, kind) => void deleteEntry(path, kind),
  onMenu: (path, _kind, at) =>
    showMenu(at, [
      { label: "Copy relative path", run: () => void copyPath(path, false) },
      { label: "Copy absolute path", run: () => void copyPath(path, true) },
      { label: "Rename", run: () => sidebar.beginRename(path) },
    ]),
  onMove: (path, kind, dir) => void moveEntry(path, kind, dir),
});

const graphView = new GraphView(ui.cy, {
  onOpen: (path) => void openFile(path),
  onOpenEdge: (source, target, label) => void openEdgeNote(source, target, label),
  onLinkExisting: (source, target) => linkNotes(source, target),
  onLinkNew: (source, at, folder) => void linkToNewNote(source, at, folder),
  onReparent: (path, folder) => void moveEntry(path, "file", folder, true),
  onGroup: (paths, frame) => void groupIntoFolder(paths, frame),
  onNodeMenu: (path, client) =>
    showMenu(client, [
      { label: "Link to a note…", run: () => graphView.startLink(path) },
      { label: `Rename "${noteName(path)}"`, run: () => renameOnGraph(path) },
      { label: `Delete "${noteName(path)}"`, run: () => void deleteEntry(path, "file") },
    ]),
  onCanvasMenu: (at, client, folder) =>
    showMenu(client, [
      { label: folder ? `New note in "${folder}"` : "New note", run: () => void createNoteAt(at, folder) },
      // A folder with nothing in it has no box, so "new folder" IS the rectangle:
      // pick the notes and the folder is made around them.
      { label: "New folder", run: () => graphView.startGroup() },
      { label: "New sticky", run: () => graphView.addSticky(at) },
    ]),
  onHint: (hint) => {
    ui.status.textContent = hint ?? statusText();
  },
}, spatial, stickies);

/* -------------------------------------------------------------- reading --- */

const filePaths = (): string[] => entries.filter((e) => e.kind === "file").map((e) => e.path);

async function readDocs(): Promise<Doc[]> {
  return Promise.all(filePaths().map(async (path) => ({ path, text: await vault.read(path) })));
}

/**
 * Which connections have been written about. Only the file names are needed — the graph
 * draws a described edge thicker, it does not read what the description says.
 */
const describedEdges = async (): Promise<Set<string>> => new Set(await vault.listFiles(EDGE_DIR));

async function refresh(): Promise<void> {
  entries = await vault.entries();
  pruneTabs();
  graphStale = true;
  render();
  if (tabOf(panes[0])?.kind === "graph") await drawGraph();
}

/** Drops tabs whose file is gone, in both panes, and keeps the graph where it belongs. */
function pruneTabs(): void {
  const live = new Set(filePaths());
  for (const p of panes) {
    // A connection note is never in `entries()` — it is not a note about a thing, it is a
    // note about a link between two — so `live` would close its tab the moment anything
    // else in the vault changed.
    p.tabs = p.tabs.filter((tab) => tab.kind === "graph" || isEdgeNote(tab.path) || live.has(tab.path));
    p.active = Math.max(0, Math.min(p.active, p.tabs.length - 1));
  }
  pinGraph();
}

/**
 * The graph tab is a fixture of the left pane: first position, no close button,
 * and never in the right pane. Anything that reshuffles tabs runs this after.
 */
function pinGraph(): void {
  if (panes.length > 1) panes[1].tabs = panes[1].tabs.filter((tab) => tab.kind !== "graph");
  const left = panes[0];
  const at = left.tabs.findIndex((tab) => tab.kind === "graph");
  if (at === 0) return;
  if (at < 0) {
    left.tabs.unshift({ kind: "graph" });
    left.active += 1;
    return;
  }
  const [tab] = left.tabs.splice(at, 1);
  left.tabs.unshift(tab);
  if (left.active === at) left.active = 0;
  else if (left.active < at) left.active += 1;
}

/* -------------------------------------------------------------- rendering --- */

function statusText(): string {
  const tab = tabOf(pane());
  if (!tab) return "Open or create a note";
  if (tab.kind === "graph") {
    return `${filePaths().length} notes — right-drag to link, click a connection to describe it`;
  }
  // A connection note's path is `.notes/edges/…`, which says nothing useful; what it is
  // FOR does. Said here rather than at the moment it opens, so a later repaint keeps it.
  if (isEdgeNote(tab.path)) return `${noteName(tab.path)} — how they connect, and what flows`;
  return tab.path;
}

function render(): void {
  pinGraph();
  ui.vaultName.textContent = vault.name;
  sidebar.render(entries, pathOf(pane()));
  ui.panes.classList.toggle("split", panes.length > 1);
  ui.splitter.classList.toggle("hidden", panes.length < 2);
  view.forEach((v, i) => renderPane(i, v));
  ui.status.textContent = statusText();
}

function renderPane(index: number, v: PaneUI): void {
  const p = panes[index] as Pane | undefined;
  v.root.classList.toggle("hidden", !p);
  if (!p) return;
  // Only worth pointing out which side is live when there are two of them.
  v.root.classList.toggle("focused", index === focused && panes.length > 1);

  const tab = tabOf(p);
  v.tabs.innerHTML = p.tabs
    .map((t, i) => {
      const pinned = t.kind === "graph";
      const label = pinned ? "◍ Graph" : noteName(t.path);
      const title = pinned ? "Graph view — always open here" : t.path;
      return (
        `<div class="tab${i === p.active ? " active" : ""}${pinned ? " pinned" : ""}" ` +
        `data-tab="${i}" title="${escapeAttr(title)}">` +
        `<span>${escapeHtml(label)}</span>` +
        (pinned ? "" : `<button data-close="${i}" title="Close">✕</button>`) +
        `</div>`
      );
    })
    .join("");
  v.actions.innerHTML = actionsHtml(index, tab);

  const graphOpen = tab?.kind === "graph";
  if (index === 0) ui.cy.classList.toggle("hidden", !graphOpen);
  v.page.classList.toggle("hidden", graphOpen || !tab);
  v.empty.classList.toggle("hidden", !!tab);
  v.editor.classList.toggle("hidden", p.mode !== "edit");
  v.preview.classList.toggle("hidden", p.mode !== "read");
  if (graphOpen) graphView.resize();
}

/** One pane split down the middle, and the single pane it folds back to. */
const paneIcon = (divided: boolean): string =>
  `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true">` +
  `<rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2" fill="none" stroke="currentColor" stroke-width="1.4" />` +
  (divided ? `<path d="M8 2.6 V13.4" stroke="currentColor" stroke-width="1.4" />` : "") +
  `</svg>`;

const SPLIT_ICON = paneIcon(true);
const ONE_PANE_ICON = paneIcon(false);

/**
 * Pane controls live outside the scrolling tab strip — with enough tabs open they
 * used to be pushed off the end of it and out of reach.
 */
function actionsHtml(index: number, tab: Tab | undefined): string {
  const bits: string[] = [];
  if (tab?.kind === "file") {
    bits.push(`<button data-act="mode">${panes[index].mode === "edit" ? "Read" : "Edit"}</button>`);
  } else if (tab?.kind === "graph") {
    bits.push(
      `<label class="toggle" title="Show or hide the folder boxes">` +
        `<input data-act="boxes" type="checkbox"${graphView.boxesShown() ? " checked" : ""} /> Boxes</label>`,
    );
  }
  if (panes.length < MAX_PANES) {
    bits.push(`<button data-act="split" title="Open a second pane">${SPLIT_ICON} Split</button>`);
  } else if (index === 1) {
    bits.push(`<button data-act="unsplit" title="Close this pane">${ONE_PANE_ICON} Unsplit</button>`);
  }
  return bits.join("");
}

async function renderPage(index: number): Promise<void> {
  const tab = tabOf(pane(index));
  if (tab?.kind !== "file") return;
  const text = await vault.read(tab.path);
  view[index].editor.value = text;
  await paint(index, tab.path, text);
  render();
}

/** Preview HTML + the attachment pass that gives its `![[…]]` embeds real bytes. */
async function paint(index: number, path: string, text: string): Promise<void> {
  view[index].preview.innerHTML = renderMarkdown(text);
  await hydrateImages(view[index].preview, path, vault);
}

/** Only call with the graph tab already rendered — the layout needs a sized container. */
async function drawGraph(): Promise<void> {
  graphStale = false;
  graphView.render(await readDocs(), lastFile, await describedEdges());
}

/** Brings one pane's visible content back in line with its active tab. */
async function showPane(index: number): Promise<void> {
  const tab = tabOf(pane(index));
  if (tab?.kind === "file") await renderPage(index);
  else if (tab?.kind === "graph" && graphStale) await drawGraph();
}

const showAll = async (): Promise<void> => {
  for (let i = 0; i < panes.length; i++) await showPane(i);
};

/* ----------------------------------------------------------------- panes --- */

function focusTab(index: number, tab: number): void {
  focused = Math.min(index, panes.length - 1);
  const p = panes[focused];
  p.active = tab;
  const open = tabOf(p);
  if (open?.kind === "file") {
    lastFile = open.path;
    void renderPage(focused);
    return;
  }
  render(); // unhides #cy first, so the layout has real dimensions to work with
  if (open?.kind === "graph" && graphStale) void drawGraph();
}

/** Splits off a second pane, handing it the note you were on — as Obsidian does. */
async function splitPane(): Promise<void> {
  if (panes.length >= MAX_PANES) return;
  const left = panes[0];
  const open = tabOf(left);
  // The graph never moves, so splitting from it hands over the last note instead.
  const take = open?.kind === "file" ? open : [...left.tabs].reverse().find((t) => t.kind === "file");
  if (take) {
    const at = left.tabs.indexOf(take);
    left.tabs.splice(at, 1);
    if (left.active >= at) left.active = Math.max(0, left.active - 1);
  }
  panes.push({ tabs: take ? [take] : [], active: 0, mode: "read" });
  focused = 1;
  render();
  await showAll(); // the left pane just lost a tab — it has a different note on it now
}

/** Folds the right pane away, keeping whatever was open in it. */
async function unsplit(): Promise<void> {
  if (panes.length < 2) return;
  await flushAll();
  const right = panes.pop()!;
  const left = panes[0];
  for (const tab of right.tabs) {
    if (tab.kind !== "file") continue;
    if (!left.tabs.some((t) => t.kind === "file" && t.path === tab.path)) left.tabs.push(tab);
  }
  focusTab(0, left.active);
}

/**
 * Deliberately not a full render(): this runs on mousedown, and replacing the tab
 * strip out from under a click would leave the click with no element to land on.
 */
function setFocus(index: number): void {
  if (index >= panes.length || focused === index) return;
  focused = index;
  view.forEach((v, i) => v.root.classList.toggle("focused", i === focused && panes.length > 1));
  sidebar.render(entries, pathOf(pane()));
  ui.status.textContent = statusText();
}

async function closeTab(index: number, tab: number): Promise<void> {
  const p = panes[index];
  if (p.tabs[tab]?.kind === "graph") return; // pinned
  await flushAll();
  p.tabs.splice(tab, 1);
  if (p.active > tab) p.active -= 1;
  p.active = Math.max(0, Math.min(p.active, p.tabs.length - 1));
  // An empty right pane is just a split nobody is using.
  if (index === 1 && p.tabs.length === 0) return void unsplit();
  focusTab(index, p.active);
}

/* --------------------------------------------------------------- actions --- */

async function openFile(path: string, where = focused): Promise<void> {
  await flushAll();
  const index = Math.min(where, panes.length - 1);
  const p = panes[index];
  const existing = p.tabs.findIndex((t) => t.kind === "file" && t.path === path);
  if (existing >= 0) {
    focusTab(index, existing);
    return;
  }
  p.tabs.push({ kind: "file", path });
  focusTab(index, p.tabs.length - 1);
  graphView.markActive(path);
}

function openGraph(): void {
  pinGraph();
  focusTab(0, 0);
}

/** Creates `Untitled.md` at once and opens the tree's rename field on it. */
async function newNote(dir = sidebar.activeDir): Promise<void> {
  const path = uniquePath(filePaths(), dir, "Untitled", ".md");
  await vault.createFile(path, "");
  await refresh();
  await openFile(path);
  sidebar.beginRename(path);
}

async function newFolder(dir = sidebar.activeDir): Promise<void> {
  const dirs = entries.filter((e) => e.kind === "dir").map((e) => e.path);
  const path = uniquePath(dirs, dir, "Untitled folder", "");
  await vault.createDir(path);
  sidebar.reveal(path);
  ui.crumb.textContent = "/" + path;
  await refresh();
  sidebar.beginRename(path);
}

/**
 * Every note path a rename or move changes: one entry for a file, and one per descendant
 * note for a folder. Build it BEFORE the vault call, while `entries` still describes the
 * old shape of things.
 */
function movesFor(from: string, to: string, kind: "file" | "dir"): Map<string, string> {
  if (kind === "file") return new Map([[from, to]]);
  const moves = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.path.startsWith(from + "/")) continue;
    moves.set(entry.path, to + entry.path.slice(from.length));
  }
  return moves;
}

/**
 * Rewrites the [[links]] in every note so they follow the notes that just moved. Returns
 * how many notes were touched. A vault whose links break whenever a file is filed away is
 * not much of a vault, so this runs on every rename, move and group.
 */
async function relinkVault(moves: Map<string, string>): Promise<number> {
  if (!moves.size) return 0;
  await carryEdgeNotes(moves);
  entries = await vault.entries();
  const wasAt = new Map([...moves].map(([from, to]) => [to, from]));
  const resolver = new LinkResolver(filePaths().map((path) => wasAt.get(path) ?? path));
  let touched = 0;
  for (const path of filePaths()) {
    const text = await vault.read(path);
    const next = relinkText(text, moves, (target) => resolver.resolve(target));
    if (next === text) continue;
    await vault.write(path, next);
    touched++;
  }
  return touched;
}

/**
 * A connection note is named after the notes at its two ends, so renaming either of them
 * has to carry the file along — otherwise the description of how two notes are wired
 * together is orphaned by renaming one of them. Filing a note into a folder changes no
 * name and so moves nothing here, which is exactly the point of naming these by note name.
 */
async function carryEdgeNotes(moves: Map<string, string>): Promise<void> {
  const renames = new Map<string, string>();
  for (const [from, to] of moves) {
    if (noteName(from) !== noteName(to)) renames.set(noteName(from), noteName(to));
  }
  if (!renames.size) return;
  for (const path of await vault.listFiles(EDGE_DIR)) {
    const next = renamedEdgeNote(path, renames);
    // A note renamed onto a connection that is already described: leave both files alone
    // rather than overwrite somebody's prose with somebody else's.
    if (!next || (await vault.exists(next))) continue;
    if (!(await tryVault(`could not rename ${basename(path)}`, () => vault.rename(path, next, "file")))) {
      return;
    }
    retargetTabs(path, next);
  }
}

/** " — relinked 3 notes", or nothing when no reference had to change. */
const relinked = (count: number): string =>
  count ? ` — relinked ${count} note${count === 1 ? "" : "s"}` : "";

/** Points every open tab at a path that just moved, in both panes. */
function retargetTabs(from: string, to: string): void {
  for (const p of panes) {
    p.tabs = p.tabs.map((tab) =>
      tab.kind === "file" && (tab.path === from || tab.path.startsWith(from + "/"))
        ? { kind: "file", path: to + tab.path.slice(from.length) }
        : tab,
    );
  }
  if (lastFile === from) lastFile = to;
  else if (lastFile?.startsWith(from + "/")) lastFile = to + lastFile.slice(from.length);
}

/** Applies a name typed inline, in the tree or on a graph node. Returns the path it ended up at. */
async function applyRename(path: string, kind: "file" | "dir", name: string): Promise<string | null> {
  const current = kind === "file" ? noteName(path) : basename(path);
  if (!name || name === current) return path;
  const next = join(dirname(path), kind === "file" && !isMarkdown(name) ? `${name}.md` : name);
  if (next !== path && (filePaths().includes(next) || entries.some((e) => e.path === next))) {
    ui.status.textContent = `${next} already exists — not renamed`;
    return path;
  }
  await flushAll();
  const moves = movesFor(path, next, kind);
  if (kind === "file") graphView.carryPosition(path, next);
  else {
    // Renaming a folder re-ids everything under it; without this the box and every
    // note in it would be re-placed from scratch the moment it is named.
    graphView.carryFrame(path, next);
    graphView.carrySubtree(path, next);
  }
  if (!(await tryVault(`could not rename ${basename(path)}`, () => vault.rename(path, next, kind)))) {
    return path;
  }
  retargetTabs(path, next);
  // "New note" targets the selected folder, so a rename has to follow it there.
  if (kind === "dir" && (sidebar.activeDir === path || sidebar.activeDir.startsWith(path + "/"))) {
    sidebar.reveal(next + sidebar.activeDir.slice(path.length));
    ui.crumb.textContent = "/" + sidebar.activeDir;
  }
  const count = await relinkVault(moves);
  await syncAfterStructuralChange();
  ui.status.textContent = `renamed to ${next}${relinked(count)}`;
  return next;
}

/**
 * Drag in the tree, or a note dropped into a folder box on the graph. `carry` keeps
 * the graph node exactly where it was let go of — right for a drop on the canvas,
 * wrong for a tree drag, where the node should re-appear inside its new box.
 */
async function moveEntry(path: string, kind: "file" | "dir", dir: string, carry = false): Promise<void> {
  const next = join(dir, basename(path));
  if (next === path) return;
  if (kind === "dir" && (dir === path || dir.startsWith(path + "/"))) {
    ui.status.textContent = "a folder cannot be moved inside itself";
    return;
  }
  if (entries.some((e) => e.path === next)) {
    ui.status.textContent = `${next} already exists — not moved`;
    graphStale = true;
    if (tabOf(panes[0])?.kind === "graph") await drawGraph();
    return;
  }
  await flushAll();
  const moves = movesFor(path, next, kind);
  if (carry && kind === "file") graphView.carryPosition(path, next);
  if (!(await tryVault(`could not move ${basename(path)}`, () => vault.rename(path, next, kind)))) return;
  retargetTabs(path, next);
  const count = await relinkVault(moves);
  await syncAfterStructuralChange();
  ui.status.textContent = `moved ${basename(path)} → ${dir || "vault root"}${relinked(count)}`;
}

/**
 * A vault write can fail — a permission, a locked file, a half-copied folder. Report it
 * and put the tree and the graph back in step with what is actually on disk, rather than
 * carrying on against a vault that no longer matches.
 */
async function tryVault(what: string, run: () => Promise<void>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (err) {
    ui.status.textContent = `${what}: ${(err as Error).message}`;
    entries = await vault.entries();
    pruneTabs();
    render();
    return false;
  }
}

/** Deepest folder holding every one of `paths` — where a group of them belongs. */
function commonDir(paths: string[]): string {
  const dirs = paths.map((path) => parts(dirname(path)));
  let shared = dirs[0] ?? [];
  for (const other of dirs.slice(1)) {
    let i = 0;
    while (i < shared.length && i < other.length && shared[i] === other[i]) i++;
    shared = shared.slice(0, i);
  }
  return shared.join("/");
}

/**
 * A rectangle drawn on the graph becomes a folder holding the notes inside it.
 * This is the only way to get a folder onto the graph: a box is drawn from the notes
 * it holds, so an empty folder has nothing to draw and creating one first gets you
 * nowhere. The notes keep their positions and the box is sized to the rectangle, so
 * the folder appears exactly where it was drawn.
 */
async function groupIntoFolder(paths: string[], frame: { w: number; h: number }): Promise<void> {
  const taken = new Set(filePaths());
  const dirs = entries.filter((e) => e.kind === "dir").map((e) => e.path);
  const folder = uniquePath(dirs, commonDir(paths), "New folder", "");
  await flushAll();
  await vault.createDir(folder);

  const moves = new Map<string, string>();
  const moved: string[] = [];
  const clashed: string[] = [];
  for (const path of paths) {
    const next = join(folder, basename(path));
    // Two notes of the same name from different folders: the second one stays put.
    if (taken.has(next)) {
      clashed.push(basename(path));
      continue;
    }
    graphView.carryPosition(path, next); // the box forms around the notes, where they are
    if (!(await tryVault(`could not move ${basename(path)}`, () => vault.rename(path, next, "file")))) {
      break; // the vault is unhappy — stop rather than half-group the selection
    }
    taken.delete(path);
    taken.add(next);
    retargetTabs(path, next);
    moves.set(path, next);
    moved.push(next);
  }

  const count = await relinkVault(moves);
  graphView.presetFrame(folder, frame);
  await syncAfterStructuralChange();
  sidebar.reveal(folder);
  ui.crumb.textContent = "/" + folder;
  ui.status.textContent = clashed.length
    ? `${moved.length} notes → ${folder}${relinked(count)}; left ${clashed.join(", ")} (name already taken)`
    : `${moved.length} notes → ${folder}${relinked(count)} — type a name`;
  // Name it on the box itself, so the whole gesture stays on the graph.
  graphView.renameNode(folder, (name) => {
    if (name) void applyRename(folder, "dir", name);
  });
}

/**
 * Re-reads the vault and patches the graph without re-running cola, so moves,
 * renames and merges never throw the existing layout around.
 */
async function syncAfterStructuralChange(): Promise<void> {
  entries = await vault.entries();
  pruneTabs();
  render();
  if (tabOf(panes[0])?.kind === "graph") await drawGraph();
  else graphStale = true;
  await showAll();
}

async function deleteEntry(path: string, kind: "file" | "dir"): Promise<void> {
  if (!(await askConfirm(`Delete ${path}?`))) return;
  await vault.remove(path, kind);
  await refresh();
  await showAll();
}

async function pickFolder(): Promise<void> {
  if (!canPickFolder()) {
    ui.status.textContent = "folder opening needs the File System Access API (Chrome/Edge/Electron)";
    return;
  }
  try {
    vault = await FolderVault.pick();
  } catch {
    return; // user cancelled
  }
  await spatial.attach(vault); // this folder's own arrangement, not the last one's
  await stickies.attach(vault);
  panes = [{ tabs: [{ kind: "graph" }], active: 0, mode: "read" }];
  focused = 0;
  lastFile = null;
  sidebar.reveal("");
  ui.crumb.textContent = "/";
  await refresh();
}

/* ----------------------------------------------------------------- paths --- */

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* no clipboard permission — fall back to a scratch selection */
  }
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.appendChild(scratch);
  scratch.select();
  document.execCommand("copy");
  scratch.remove();
}

/**
 * Neither localStorage nor the File System Access API hands out a real filesystem
 * path, so the vault's location on disk is asked for once and remembered per vault.
 */
async function vaultRoot(): Promise<string | null> {
  const stored = localStorage.getItem(ROOT_KEY + vault.name);
  if (stored) return stored;
  const typed = await askText(
    `Where does "${vault.name}" live on disk? Asked once, then remembered.`,
    `~/${vault.name}`,
    "Remember",
  );
  if (!typed) return null;
  const root = typed.replace(/\/+$/, "");
  localStorage.setItem(ROOT_KEY + vault.name, root);
  return root;
}

async function copyPath(path: string, absolute: boolean): Promise<void> {
  let text = path;
  if (absolute) {
    const root = await vaultRoot();
    if (!root) return;
    text = `${root}/${path}`;
  }
  await copyText(text);
  ui.status.textContent = `copied ${text}`;
}

/* ------------------------------------------------------------- saving --- */

function scheduleSave(index: number): void {
  const p = panes[index];
  clearTimeout(p.timer);
  p.timer = window.setTimeout(() => {
    p.timer = undefined;
    void save(index);
  }, 400);
}

/** Writes one pane's editor buffer through to the vault. */
async function flushSave(index: number): Promise<void> {
  const p = panes[index] as Pane | undefined;
  if (!p || p.timer === undefined) return;
  clearTimeout(p.timer);
  p.timer = undefined;
  await save(index);
}

const flushAll = async (): Promise<void> => {
  for (let i = 0; i < panes.length; i++) await flushSave(i);
};

async function save(index: number): Promise<void> {
  const tab = tabOf(pane(index));
  if (tab?.kind !== "file") return;
  const text = view[index].editor.value;
  /*
   * `write` creates whatever is missing, so a save aimed at a note that has since been
   * moved or deleted does not fail — it puts the file back, with the editor's buffer in
   * it. That is how a moved note leaves a stub behind in the folder it came from, and
   * why the same note then shows up twice on the graph. Never resurrect a path.
   */
  if (!(await vault.exists(tab.path))) {
    ui.status.textContent = `${tab.path} is no longer in the vault — not written back`;
    return;
  }
  await vault.write(tab.path, text);
  await paint(index, tab.path, text);
  // The same note can be open on both sides; the other one must not go stale.
  for (let other = 0; other < panes.length; other++) {
    if (other === index) continue;
    if (pathOf(panes[other]) !== tab.path) continue;
    view[other].editor.value = text;
    await paint(other, tab.path, text);
  }
  ui.status.textContent = `${tab.path} — saved`;
  graphStale = true; // picked up when the graph tab is next shown
}

/* ------------------------------------------------------------ graph links --- */

/**
 * Appends the link to `source` unless it already links there. A named connection is written as
 * `label:: [[target]]` — see `links.ts` — so the relation lives in the markdown, not in app state.
 */
async function insertCitation(source: string, target: string, label: string | null = null): Promise<void> {
  if (source === target) return;
  const text = await vault.read(source);
  const resolver = new LinkResolver(filePaths());
  if (linkTargets(text).some((t) => resolver.resolve(t) === target)) return;
  const gap = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  await vault.write(source, `${text}${gap}${labelledLink(label, target.replace(/\.md$/i, ""))}\n`);
}

/**
 * Click on an edge: open the markdown that describes that connection. A note says what a
 * thing is and how it works; its edges say how the things are wired together and what
 * flows between them. The file is written on first click, so the connection is described
 * by writing in it rather than by creating anything first.
 */
async function openEdgeNote(source: string, target: string, label: string | null): Promise<void> {
  const path = edgeNotePath(source, target);
  const fresh = !(await vault.exists(path));
  if (fresh) {
    if (!(await tryVault(`could not describe ${edgeTitle(source, target)}`, () =>
      vault.createFile(path, edgeNoteTemplate(source, target, label)),
    ))) {
      return;
    }
    graphView.setEdgeDescribed(source, target); // thicken the line now, not at the next rebuild
    graphStale = true;
  }
  await openFile(path);
  // A brand-new connection note is empty apart from its heading — open it ready to write in.
  if (fresh) panes[focused].mode = "edit";
  render();
}

/** Sidebar-only refresh — avoids render()'s graph fit, which would jump the viewport. */
async function refreshSidebar(): Promise<void> {
  entries = await vault.entries();
  sidebar.render(entries, pathOf(pane()));
}

/** Click (or menu) on empty canvas / inside a folder box: spawn a note there. */
async function createNoteAt(at: { x: number; y: number }, folder: string | null): Promise<void> {
  const path = uniquePath(filePaths(), folder ?? "", "Untitled", ".md");
  await vault.createFile(path, `# ${noteName(path)}\n\n`);
  await refreshSidebar();
  graphView.commitNode(path, noteName(path), folder ?? undefined, at);
  graphStale = true;
  ui.status.textContent = `created ${path}`;
  renameOnGraph(path);
}

/** Name field floating on the node itself, pre-selected. */
function renameOnGraph(path: string): void {
  graphView.renameNode(path, (name) => {
    if (name) void applyRename(path, "file", name);
  });
}

/**
 * Right-drag landed on an existing note: draw the edge, then name the connection. The edge is on
 * screen while it is being named, and the file is written once — with the relation if one was typed.
 */
function linkNotes(source: string, target: string): void {
  graphView.commitLink(source, target);
  graphStale = true;
  graphView.promptConnection(source, target, (label) => void finishLink(source, target, label));
}

/** Writes the (possibly named) link through to the file and labels the live edge. */
async function finishLink(source: string, target: string, label: string | null): Promise<void> {
  await insertCitation(source, target, label);
  // Re-commit before labelling: if the note was renamed between drawing and naming, the rename's
  // sync dropped the provisional edge (the file did not carry the link yet at that moment).
  graphView.commitLink(source, target);
  graphView.setEdgeLabel(source, target, label);
  graphStale = true;
  await showAll();
  ui.status.textContent = label
    ? `${noteName(source)} —${label}→ ${noteName(target)}`
    : `linked ${noteName(source)} → ${noteName(target)}`;
}

/**
 * Right-drag landed on empty canvas: place the note where it was dropped, name it, then name the
 * connection. The node, the edge and the name field go up FIRST and the vault work follows — on a
 * real folder vault the `entries()` walk takes long enough that doing it first made the name field
 * appear seconds after the click, which read as the gesture having failed.
 */
async function linkToNewNote(source: string, at: { x: number; y: number }, folder: string | null): Promise<void> {
  // The note belongs to the box it was dropped in; only fall back to the source's folder at the root.
  const dir = folder ?? "";
  const path = uniquePath(filePaths(), dir, "Untitled", ".md");
  await vault.createFile(path, `# ${noteName(path)}\n\n`);
  entries = [...entries, { path, kind: "file" }]; // so the rename's collision check sees it
  graphView.commitLink(source, path, { label: noteName(path), parent: dir || undefined, at });
  graphStale = true;
  ui.status.textContent = `created ${path} — name it, then name the connection`;

  // name the note → rename it on disk → name the connection → write the link.
  // A dismissed name field (null) keeps "Untitled" and still moves on to the connection.
  graphView.renameNode(path, (name) => {
    void (async () => {
      const finalPath = name ? ((await applyRename(path, "file", name)) ?? path) : path;
      graphView.promptConnection(source, finalPath, (label) =>
        void finishLink(source, finalPath, label),
      );
    })();
  });
  await refreshSidebar();
}

/** [[link]] click: open the target, creating the note if it does not exist yet. */
async function followLink(target: string, where: number): Promise<void> {
  const from = pathOf(pane(where));
  const resolved = new LinkResolver(filePaths()).resolve(target);
  if (resolved) {
    await openFile(resolved, where);
    return;
  }
  const base = from ? dirname(from) : sidebar.activeDir;
  const path = join(base, isMarkdown(target) ? target : `${target}.md`);
  await vault.createFile(path, `# ${noteName(path)}\n\n`);
  await refresh();
  await openFile(path, where);
}

/* ----------------------------------------------------------------- wiring --- */

ui.openFolder.addEventListener("click", () => void pickFolder());
ui.newNote.addEventListener("click", () => void newNote());
ui.newFolder.addEventListener("click", () => void newFolder());
ui.graph.addEventListener("click", () => openGraph());

/* ------------------------------------------------------------ attachments --- */

/**
 * Store the images and write their embeds into the open note. In edit mode they land at the caret;
 * dropping onto the rendered page appends instead — there is no caret there, and the alternative
 * (silently switching to edit mode) loses the reading position.
 */
async function attachImages(index: number, files: File[], at: "caret" | "end"): Promise<void> {
  const tab = tabOf(pane(index));
  if (tab?.kind !== "file") {
    ui.status.textContent = "open a note first — images are attached to a note";
    return;
  }
  if (!files.length) return;

  const editor = view[index].editor;
  const saved: string[] = [];
  for (const file of files) {
    try {
      const { path, embed } = await saveImage(vault, file);
      saved.push(path);
      if (at === "caret") {
        insertAtCaret(editor, embed);
      } else {
        const text = editor.value;
        const gap = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
        editor.value = `${text}${gap}${embed}\n`;
      }
    } catch (err) {
      ui.status.textContent = `could not attach ${file.name}: ${(err as Error).message}`;
      break;
    }
  }
  if (!saved.length) return;
  await flushSave(index);
  await save(index); // writes the note and repaints, so the image shows immediately
  ui.status.textContent =
    saved.length === 1 ? `attached ${saved[0]}` : `attached ${saved.length} images to ${tab.path}`;
}

/** Drop targets: the editor (caret) and the rendered page (append). */
function makeDropZone(zone: HTMLElement, index: number, where: "caret" | "end"): void {
  zone.addEventListener("dragover", (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    zone.classList.add("drop-target");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drop-target"));
  zone.addEventListener("drop", (event: DragEvent) => {
    const files = imageFiles(event.dataTransfer);
    zone.classList.remove("drop-target");
    if (!files.length) return; // not images — let the default handling have it
    event.preventDefault();
    void attachImages(index, files, where);
  });
}

/* ------------------------------------------------------------- pane wiring --- */

view.forEach((v, index) => {
  v.root.addEventListener("mousedown", () => setFocus(index), true);

  v.tabs.addEventListener("click", (event) => {
    const node = event.target as HTMLElement;
    const close = node.closest<HTMLElement>("[data-close]")?.dataset.close;
    if (close !== undefined) {
      void closeTab(index, Number(close));
      return;
    }
    const pick = node.closest<HTMLElement>("[data-tab]")?.dataset.tab;
    if (pick !== undefined) void flushAll().then(() => focusTab(index, Number(pick)));
  });

  v.actions.addEventListener("click", (event) => {
    const act = (event.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    switch (act) {
      case "mode":
        panes[index].mode = panes[index].mode === "edit" ? "read" : "edit";
        render();
        break;
      case "split":
        void splitPane();
        break;
      case "unsplit":
        void unsplit();
        break;
    }
  });

  v.actions.addEventListener("change", (event) => {
    const node = event.target as HTMLInputElement;
    if (node.dataset.act === "boxes") graphView.setBoxesVisible(node.checked);
  });

  v.editor.addEventListener("input", () => scheduleSave(index));

  v.editor.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    void flushSave(index).then(() => {
      panes[index].mode = "read";
      render();
    });
  });

  v.preview.addEventListener("click", (event) => {
    const node = event.target as HTMLElement;
    const link = node.closest<HTMLElement>(".wikilink");
    if (link?.dataset.link) {
      event.preventDefault();
      void followLink(link.dataset.link, index);
      return;
    }
    if (node.closest("a")) return; // external link — let it open
    // Clicking the rendered text drops into edit mode, as Obsidian does.
    if (!window.getSelection()?.isCollapsed) return; // they were selecting text
    panes[index].mode = "edit";
    render();
    v.editor.focus();
    v.editor.setSelectionRange(v.editor.value.length, v.editor.value.length);
  });

  // Pasted screenshots (⌘V) take the same path — the clipboard hands us the same File objects.
  v.editor.addEventListener("paste", (event) => {
    const files = imageFiles(event.clipboardData);
    if (!files.length) return; // plain text — default paste
    event.preventDefault();
    void attachImages(index, files, "caret");
  });

  makeDropZone(v.editor, index, "caret");
  makeDropZone(v.preview, index, "end");
});

/* -------------------------------------------------------------- chrome --- */

/** Shared drag handler for the two column dividers. */
function dragColumn(handle: HTMLElement, apply: (x: number) => void): void {
  handle.addEventListener("mousedown", (event: MouseEvent) => {
    event.preventDefault();
    const onMove = (move: MouseEvent) => apply(move.clientX);
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

dragColumn(ui.sideResize, (x) => {
  ui.app.style.setProperty("--side-w", `${Math.min(Math.max(x, 150), 520)}px`);
  graphView.resize();
});

dragColumn(ui.splitter, (x) => {
  const box = ui.panes.getBoundingClientRect();
  const width = Math.min(Math.max(x - box.left, 240), box.width - 240);
  ui.panes.style.setProperty("--pane-w", `${width}px`);
  graphView.resize();
});

function foldSidebar(collapsed: boolean): void {
  ui.sidebar.classList.toggle("collapsed", collapsed);
  ui.sideResize.classList.toggle("hidden", collapsed);
  ui.foldSide.textContent = collapsed ? "☰" : "⟨";
  ui.foldSide.title = collapsed ? "Show sidebar" : "Collapse sidebar";
  localStorage.setItem(SIDE_KEY, collapsed ? "off" : "on");
  graphView.resize();
}

ui.foldSide.addEventListener("click", () => foldSidebar(!ui.sidebar.classList.contains("collapsed")));
foldSidebar(localStorage.getItem(SIDE_KEY) === "off");

window.addEventListener("beforeunload", () => {
  for (let i = 0; i < panes.length; i++) if (panes[i].timer !== undefined) void save(i);
  void spatial.flush(); // don't lose the last drag to a quick ⌘Q
  void stickies.flush();
});

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => escapeHtml(s).replace(/"/g, "&quot;");

// Open the first note before the first render, so launching the app doesn't solve
// a graph layout the user never asked to see behind the note they land on.
void (async () => {
  await spatial.attach(vault);
  await stickies.attach(vault);
  entries = await vault.entries();
  const first = filePaths()[0];
  if (first) {
    panes[0].tabs.push({ kind: "file", path: first });
    panes[0].active = 1;
    lastFile = first;
  }
  await refresh();
  if (first) await renderPage(0);
})();
