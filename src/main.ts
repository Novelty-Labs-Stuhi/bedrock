import "./style.css";
import { GraphView, type Client, type Doc, type Mark, type SessionState } from "./graph";
import {
  LinkResolver,
  labelledLink,
  parseField,
  parseStyle,
  relinkText,
  setField,
  setGhost,
  setStyle,
  type NodeStyle,
} from "./links";
import { showFolderStylePicker, showStylePicker } from "./node-style";
import { askChoice, askConfirm, askText } from "./dialog";
import { EDGE_DIR, edgeNotePath, edgeNoteTemplate, edgeTitle, isEdgeNote, renamedEdgeNote } from "./edges";
import { showMenu, type MenuItem } from "./menu";
import { mountHelp } from "./help";
import { SettingsStore, mountSettings } from "./settings";
import { imageFiles, resetAssets, saveImage } from "./images";
import { createEditor, type Editor } from "./editor";
import { linkTargets } from "./markdown";
import { Sidebar } from "./sidebar";
import { SpatialStore } from "./spatial";
import { STICKY_DIR, StickyStore, isCardPath, stamp } from "./sticky";
import {
  IdStore,
  ISSUE_DIR,
  LinearApi,
  LocalIssues,
  issueTemplate,
  parseIssue,
  writeIssue,
  type IssueSource,
} from "./linear";
import type { IssueChange } from "./graph";
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
 * One side of the split. The pending save is per pane, so the two sides never fight over
 * each other's buffer. There is no read/edit mode: the editor renders as you type, and an
 * editor you are not typing in renders everything.
 */
type Pane = { tabs: Tab[]; active: number; timer?: number };

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
  settings: el<HTMLButtonElement>("settings"),
  settingsPanel: el("settings-panel"),
  gitCommit: el<HTMLButtonElement>("git-commit"),
};

mountHelp(ui.help, ui.helpPanel);

type PaneUI = {
  root: HTMLElement;
  tabs: HTMLElement;
  actions: HTMLElement;
  page: HTMLElement;
  empty: HTMLElement;
  mount: HTMLElement;
};

/** Both panes exist in the DOM from the start; the right one is hidden until split. */
const view: PaneUI[] = [0, 1].map((i) => ({
  root: el(`pane-${i}`),
  tabs: el(`tabs-${i}`),
  actions: el(`actions-${i}`),
  page: el(`page-${i}`),
  empty: el(`empty-${i}`),
  mount: el(`editor-${i}`),
}));

const MAX_PANES = 2;
const SIDE_KEY = "obsidian-lite:sidebar";
const ROOT_KEY = "obsidian-lite:root:";

let vault: Vault = new LocalVault();
/** The graph's arrangement, cached in the vault's own `.notes/` folder. */
const spatial = new SpatialStore();
/** Loose text pinned to the canvas — kept apart from the layout cache, it is not derived. */
const stickies = new StickyStore();
/** Which integrations this vault runs with — `.notes/config.json`. */
const settings = new SettingsStore();
let entries: Entry[] = [];
/** The graph is pinned as the first tab of the left pane and is never closed. */
let panes: Pane[] = [{ tabs: [{ kind: "graph" }], active: 0 }];
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

/**
 * The editing surfaces. Built after the vault and the pane list, because the live-preview
 * layer asks both of them what it is looking at the moment it is constructed.
 */
const editors: Editor[] = view.map((v, index) =>
  createEditor(v.mount, {
    changed: () => scheduleSave(index),
    escaped: () => void flushSave(index),
    followLink: (target) => void followLink(target, index),
    pasted: (data) => {
      const files = imageFiles(data);
      if (!files.length) return false; // plain text — let the ordinary paste have it
      void attachImages(index, files, null);
      return true;
    },
    dropped: (data, pos) => {
      const files = imageFiles(data);
      if (!files.length) return false;
      void attachImages(index, files, pos);
      return true;
    },
    note: () => pathOf(pane(index)) ?? "",
    vault: () => vault,
  }),
);

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
  onOpen: (path) => void openFile(path, graphPane()),
  onOpenGemini: (path, url) => openGeminiNode(path, url),
  onOpenClaude: (path, session) => void openClaudeSession(path, session),
  onOpenPath: (path, target, kind) => void openFsNode(path, target, kind),
  onOpenWeb: (path, url) => void openWebNode(path, url),
  onIssueEdit: (path, text, change) => editIssue(path, text, change),
  onOpenIssue: (url) => {
    if (!window.open(url, "_blank", "noopener")) ui.status.textContent = `the browser blocked ${url}`;
  },
  onOpenEdge: (source, target, label) => void openEdgeNote(source, target, label),
  onLinkExisting: (source, target) => linkNotes(source, target),
  onLinkNew: (source, at, folder, kind) => {
    if (kind === "gemini") void createGeminiAt(at, folder, source);
    else if (kind === "claude") void createClaudeAt(at, folder, source);
    else if (kind === "file" || kind === "folder") void createFsAt(at, folder, kind, source);
    else if (kind === "web") void createWebAt(at, folder, source);
    else void linkToNewNote(source, at, folder);
  },
  onReparent: (path, folder) => void moveEntry(path, "file", folder, true),
  onRefolder: (path, folder) => void moveEntry(path, "dir", folder, true),
  onGroup: (picked, frame) => void groupIntoFolder(picked, frame),
  onNodeMenu: (path, client) => {
    const items: MenuItem[] = [{ label: "Link to a note…", run: () => graphView.startLink(path) }];
    if (settings.enabled("gemini")) {
      items.push({ label: "Link to a Gemini chat…", run: () => graphView.startLink(path, "gemini") });
    }
    if (settings.enabled("claude")) {
      items.push({ label: "Link to a Claude session…", run: () => graphView.startLink(path, "claude") });
      // Only a session note can be plugged into one; on any other note it would mean nothing.
      if (graphView.sessionNote(path)) {
        items.push({ label: "Plug in a session…", run: () => void plugInSession(path) });
      }
    }
    if (settings.enabled("files")) {
      items.push(
        { label: "Link to a file…", run: () => graphView.startLink(path, "file") },
        { label: "Link to a folder…", run: () => graphView.startLink(path, "folder") },
      );
    }
    if (settings.enabled("web")) {
      items.push({ label: "Link to a webpage…", run: () => graphView.startLink(path, "web") });
    }
    if (settings.enabled("active")) {
      const mark = graphView.nodeMark(path);
      items.push(
        { label: "Style…", run: () => void styleNode(path, client) },
        {
          label: mark === "ghost" ? "Bring it back" : "Make it a ghost",
          run: () => void markNode(path, mark === "ghost" ? null : "ghost"),
        },
      );
    }
    items.push(
      { label: `Rename "${noteName(path)}"`, run: () => renameOnGraph(path) },
      { label: `Delete "${noteName(path)}"`, run: () => void deleteEntry(path, "file") },
    );
    showMenu(client, items);
  },
  onEdgeMenu: (source, target, label, client) => {
    // The same statuses a note can wear, on the line between two of them. Opening the
    // connection's own note stays a click on the line; the menu offers it too, so the
    // right button is never a dead end.
    const items: MenuItem[] = [
      { label: `Open "${edgeTitle(source, target)}"`, run: () => void openEdgeNote(source, target, label) },
    ];
    if (settings.enabled("active")) {
      const mark = graphView.edgeMark(source, target);
      items.push(
        {
          label: mark === "radiate" ? "Stop radiating" : "Make it radiate",
          run: () => graphView.setEdgeMark(source, target, mark === "radiate" ? null : "radiate"),
        },
        {
          label: mark === "ghost" ? "Bring it back" : "Make it a ghost",
          run: () => graphView.setEdgeMark(source, target, mark === "ghost" ? null : "ghost"),
        },
      );
    }
    showMenu(client, items);
  },
  onCanvasMenu: (at, client, folder) => {
    const items: MenuItem[] = [
      { label: folder ? `New note in "${folder}"` : "New note", run: () => void createNoteAt(at, folder) },
      // A folder with nothing in it has no box, so "new folder" IS the rectangle:
      // pick the notes and the folder is made around them.
      { label: "New folder", run: () => graphView.startGroup() },
      { label: "Unstack notes", run: () => unstackNotes() },
    ];
    // Right-clicked inside a box: that box can be coloured, and told apart from the
    // others at a glance — which is most of what a folder is for on a canvas.
    if (folder) {
      items.push({
        label: `Style "${basename(folder)}"…`,
        run: () =>
          showFolderStylePicker(client, graphView.folderStyle(folder), (style) =>
            graphView.setFolderStyle(folder, style),
          ),
      });
    }
    // Switched-off integrations do not appear anywhere, the menu included.
    if (settings.enabled("stickies")) items.push({ label: "New sticky", run: () => graphView.addSticky(at) });
    if (settings.enabled("linear")) {
      items.push({ label: "New Linear issue", run: () => void createIssueAt(at, folder) });
    }
    if (settings.enabled("gemini")) {
      items.push({ label: "New Gemini conversation", run: () => void createGeminiAt(at, folder) });
    }
    if (settings.enabled("claude")) {
      items.push({ label: "New Claude session", run: () => void createClaudeAt(at, folder) });
    }
    if (settings.enabled("files")) {
      items.push(
        { label: "Link a file…", run: () => void createFsAt(at, folder, "file") },
        { label: "Link a folder…", run: () => void createFsAt(at, folder, "folder") },
      );
    }
    if (settings.enabled("web")) {
      items.push({ label: "Link a webpage…", run: () => void createWebAt(at, folder) });
    }
    showMenu(client, items);
  },
  onHint: (hint) => {
    ui.status.textContent = hint ?? statusText();
  },
}, spatial, stickies, settings);

/* -------------------------------------------------------------- reading --- */

const filePaths = (): string[] => entries.filter((e) => e.kind === "file").map((e) => e.path);

/**
 * What the graph draws. Sticky files are real notes in a real folder — the
 * tree shows them — but on the canvas the CARD is their rendering, so they are never
 * also nodes. That holds with the integrations off too: the folders' contents simply
 * do not appear on the graph.
 */
async function readDocs(): Promise<Doc[]> {
  const drawn = filePaths().filter((path) => !isCardPath(path));
  return Promise.all(drawn.map(async (path) => ({ path, text: await vault.read(path) })));
}

/**
 * Which connections have been written about. Only the file names are needed — the graph
 * draws a described edge thicker, it does not read what the description says.
 */
const describedEdges = async (): Promise<Set<string>> => new Set(await vault.listFiles(EDGE_DIR));

async function refresh(): Promise<void> {
  entries = await vault.entries();
  await stickies.sync(filePaths()); // card files deleted or added in the tree
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
    const drawn = filePaths().filter((path) => !isCardPath(path)).length;
    return `${drawn} notes — right-drag to link, click a connection to describe it`;
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
  v.actions.innerHTML = actionsHtml(index);

  const graphOpen = tab?.kind === "graph";
  if (index === 0) ui.cy.classList.toggle("hidden", !graphOpen);
  v.page.classList.toggle("hidden", graphOpen || !tab);
  v.empty.classList.toggle("hidden", !!tab);
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
function actionsHtml(index: number): string {
  const bits: string[] = [];
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
  /*
   * Settle any save still queued for this pane before the buffer underneath it is replaced.
   * The timer was scheduled against the note being navigated away from, and the editor still
   * holds that note's text — so flush it now. Letting it fire after the load would write this
   * note's text to the other one's path.
   */
  await flushSave(index);
  editors[index].load(await vault.read(tab.path));
  render();
}

/** Only call with the graph tab already rendered — the layout needs a sized container. */
async function drawGraph(): Promise<void> {
  graphStale = false;
  graphView.render(await readDocs(), lastFile, await describedEdges());
  void pollSessions(); // the dots belong to the graph that has just gone up
  refreshWebIcons(); // likewise the faces: a page linked in another window is scraped here too
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
  panes.push({ tabs: take ? [take] : [], active: 0 });
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

/**
 * Where a note opened FROM the graph lands. The graph is pinned to the left pane, so with
 * a split open the note belongs on the other side: the whole point of the split is to keep
 * the canvas in view while you write, and opening over it would close the thing you split
 * to watch. With one pane there is nowhere else to put it.
 */
const graphPane = (): number => (panes.length > 1 ? 1 : focused);

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
  // The loop above rewrote sticky files on disk like any other note;
  // the cards' cache has to hear about it or a later card edit writes the old link back.
  stickies.rewriteTexts((text) => relinkText(text, moves, (target) => resolver.resolve(target)));
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
  if (carry) {
    if (kind === "file") graphView.carryPosition(path, next);
    else {
      // Filing a folder changes the id of the box and of everything under it. Without
      // this the whole box would be re-placed from scratch the moment it was dropped —
      // the arrangement inside it is the point of dragging it there in one piece.
      graphView.carryFrame(path, next);
      graphView.carrySubtree(path, next);
    }
  }
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
 * A rectangle drawn on the graph becomes a folder holding whatever was inside it —
 * loose notes, whole folder boxes, or both. This is the only way to get a folder onto
 * the graph: a box is drawn from what it holds, so an empty folder has nothing to draw
 * and creating one first gets you nowhere. Everything keeps its position and the box is
 * sized to the rectangle, so the folder appears exactly where it was drawn.
 */
async function groupIntoFolder(
  picked: Array<{ path: string; kind: "file" | "dir" }>,
  frame: { w: number; h: number },
): Promise<void> {
  const taken = new Set([...filePaths(), ...entries.filter((e) => e.kind === "dir").map((e) => e.path)]);
  const dirs = entries.filter((e) => e.kind === "dir").map((e) => e.path);
  const folder = uniquePath(dirs, commonDir(picked.map((one) => one.path)), "New folder", "");
  await flushAll();
  await vault.createDir(folder);

  const moves = new Map<string, string>();
  const moved: string[] = [];
  const clashed: string[] = [];
  for (const { path, kind } of picked) {
    const next = join(folder, basename(path));
    // Two things of the same name from different folders: the second one stays put.
    if (taken.has(next)) {
      clashed.push(basename(path));
      continue;
    }
    // The box forms around what it holds, where it already is.
    if (kind === "file") graphView.carryPosition(path, next);
    else {
      graphView.carryFrame(path, next);
      graphView.carrySubtree(path, next);
    }
    if (!(await tryVault(`could not move ${basename(path)}`, () => vault.rename(path, next, kind)))) {
      break; // the vault is unhappy — stop rather than half-group the selection
    }
    taken.delete(path);
    taken.add(next);
    retargetTabs(path, next);
    for (const [from, to] of movesFor(path, next, kind)) moves.set(from, to);
    moved.push(next);
  }

  const count = await relinkVault(moves);
  graphView.presetFrame(folder, frame);
  await syncAfterStructuralChange();
  sidebar.reveal(folder);
  ui.crumb.textContent = "/" + folder;
  ui.status.textContent = clashed.length
    ? `${moved.length} → ${folder}${relinked(count)}; left ${clashed.join(", ")} (name already taken)`
    : `${moved.length} → ${folder}${relinked(count)} — type a name`;
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
  await stickies.sync(filePaths());
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
  // Throw the old vault's graph away FIRST. A live instance makes the next render take
  // the `sync` path, which would treat the whole new vault as newly-added notes, scatter
  // them, and then save that over the arrangement this folder already had.
  graphView.reset();
  await spatial.attach(vault); // this folder's own arrangement, not the last one's
  await stickies.attach(vault);
  await issueIds.attach(vault); // and this folder's own issues
  await settings.attach(vault); // and its own set of switched-on integrations
  applyFeatures();
  panes = [{ tabs: [{ kind: "graph" }], active: 0 }];
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
/** The vault's location if it has already been given, without asking for it. */
const knownVaultRoot = (): string | null => localStorage.getItem(ROOT_KEY + vault.name);

async function vaultRoot(): Promise<string | null> {
  const stored = knownVaultRoot();
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

/* ------------------------------------------------------------------- git --- */

/**
 * The whole git integration: stage everything and commit, in the vault's folder on
 * disk. The work happens in the desktop shell (see `electron/main.cjs`) because a
 * renderer cannot run git; in a plain browser the button says so instead of failing.
 */
async function commitVault(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) {
    ui.status.textContent = "git needs the desktop app — npm start";
    return;
  }
  const root = await vaultRoot();
  if (!root) return;
  await flushAll();
  ui.gitCommit.disabled = true;
  ui.status.textContent = "git: committing…";
  try {
    ui.status.textContent = `git: ${await bridge.gitCommit(root)}`;
  } catch (err) {
    ui.status.textContent = `git: ${(err as Error).message}`;
  } finally {
    ui.gitCommit.disabled = false;
  }
}

/** Follows the toggles: what is switched off appears nowhere. */
function applyFeatures(): void {
  ui.gitCommit.classList.toggle("hidden", !settings.enabled("git"));
  graphView.refreshOverlay();
  watchSessions();
  void ensureCardDirs();
}

/** A switched-on integration shows its folder in the tree from the start. */
async function ensureCardDirs(): Promise<void> {
  let made = false;
  try {
    if (settings.enabled("stickies") && !entries.some((e) => e.path === STICKY_DIR)) {
      await vault.createDir(STICKY_DIR);
      made = true;
    }
    if (settings.enabled("linear") && !entries.some((e) => e.path === ISSUE_DIR)) {
      await vault.createDir(ISSUE_DIR);
      made = true;
    }
  } catch {
    return; // read-only vault — cards still work for the session
  }
  if (made) await refreshSidebar();
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
  const text = editors[index].text();
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
  // The same note can be open on both sides; the other one must not go stale. `sync` keeps
  // that side's caret and undo history — it is the same note, not a newly opened one.
  for (let other = 0; other < panes.length; other++) {
    if (other === index) continue;
    if (pathOf(panes[other]) !== tab.path) continue;
    editors[other].sync(text);
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
  await openFile(path, graphPane());
  // A brand-new connection note is empty apart from its heading — put the caret in it.
  if (fresh) {
    editors[focused].focus();
    editors[focused].caretToEnd();
  }
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

/** Separates any notes left piled up by a layout cached before dragging refused to stack them. */
function unstackNotes(): void {
  const moved = graphView.unstackAll();
  ui.status.textContent = moved
    ? `moved ${moved} note${moved === 1 ? "" : "s"} off the ones underneath`
    : "nothing was stacked";
}

/** Name field floating on the node itself, pre-selected. */
function renameOnGraph(path: string): void {
  graphView.renameNode(path, (name) => {
    if (name) void applyRename(path, "file", name);
  });
}

/* ---------------------------------------------------------------- linear --- */

/**
 * Where a tick goes. `LocalIssues` until a key is stored, and it is not a stub: with no
 * Linear at all the notes are the issues and the ticks are just ticks, which is a whole
 * feature. Connecting swaps in the real API and nothing else in the app changes.
 */
let issues: IssueSource = new LocalIssues();
/** Linear's uuids, kept out of the notes — see `linear.ts`. */
const issueIds = new IdStore();
/** Who the stored key belongs to, or null when there is no key. */
let linearUser: string | null = null;

/** Reads back whatever the shell has stored and points `issues` at the right source. */
async function adoptLinearKey(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) {
    issues = new LocalIssues(); // a browser tab has no keychain, and no way past CORS
    linearUser = null;
    return;
  }
  const status = await bridge.linearStatus().catch(() => ({ connected: false, user: "" }));
  issues = status.connected ? new LinearApi((query, vars) => bridge.linearCall(query, vars)) : new LocalIssues();
  linearUser = status.connected ? status.user || "connected" : null;
}

/**
 * The whole setup: paste a personal API key once. It is proved against Linear before it
 * is kept, and kept by the SHELL — encrypted in the OS keychain, deliberately not in the
 * vault, which the commit button snapshots wholesale.
 */
async function setUpLinear(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) {
    ui.status.textContent = "Linear needs the desktop app — npm start";
    return;
  }
  if (linearUser) {
    if (!(await askConfirm(`Disconnect Linear (${linearUser})? Ticks stay in the notes.`))) return;
    await bridge.linearForget();
    await adoptLinearKey();
    ui.status.textContent = "Linear disconnected — the notes keep every tick";
    redrawSettings();
    return;
  }
  const key = await askText(
    "Paste a Linear personal API key. It is kept in this machine's keychain — never in the vault.",
    "lin_api_…",
    "Connect",
  );
  if (!key) return;
  try {
    const { user } = await bridge.linearConnect(key.trim());
    await adoptLinearKey();
    ui.status.textContent = `Linear: connected as ${user || "you"}`;
  } catch (err) {
    ui.status.textContent = `Linear: ${(err as Error).message}`;
  }
  redrawSettings();
}

/** What the settings panel says under the Linear row. */
function linearDetail(): { text: string; action?: string } | null {
  if (!window.bedrock) return { text: "ticks stay in the notes — the API needs the desktop app" };
  return linearUser
    ? { text: `connected as ${escapeHtml(linearUser)}`, action: "Disconnect" }
    : { text: "not connected — ticks stay in the notes", action: "Connect…" };
}

/* --------------------------------------------------------- issue writing --- */

/** Per-note debounce, so typing in a card is not one write per keystroke. */
const issueTimers = new Map<string, number>();

/**
 * An edit made in an issue card. A tick or a new row is a decision, so it is written and
 * announced at once; typing is not, so it settles first. Either way the graph has already
 * redrawn — this is only the part that touches the disk and the network.
 */
function editIssue(path: string, text: string, change: IssueChange): void {
  clearTimeout(issueTimers.get(path));
  const decided =
    change.ticked !== undefined || change.created !== undefined || change.issueState !== undefined;
  if (decided) {
    void applyIssueEdit(path, text, change);
    return;
  }
  issueTimers.set(
    path,
    window.setTimeout(() => {
      issueTimers.delete(path);
      void applyIssueEdit(path, text, {});
    }, 400),
  );
}

async function applyIssueEdit(path: string, text: string, change: IssueChange): Promise<void> {
  // Same guard as an ordinary save: never resurrect a note that has since been deleted.
  if (!(await vault.exists(path))) {
    ui.status.textContent = `${path} is no longer in the vault — the tick was not written`;
    return;
  }
  await vault.write(path, text);
  syncOpenPanes(path, text);
  graphStale = true;
  // A tick may have just melted an arrow — or finished the whole issue, which takes its
  // node down. That disappearing IS the feedback, so it happens now, not when the graph
  // tab is next opened. Typing changes nothing an arrow shows; it waits like before.
  if (change.ticked !== undefined || change.issueState !== undefined) {
    if (panes.some((p) => tabOf(p)?.kind === "graph")) await drawGraph();
  }
  await pushIssue(path, text, change);
}

/** The same note open in a pane must not go stale behind the card. */
function syncOpenPanes(path: string, text: string): void {
  for (let i = 0; i < panes.length; i++) if (pathOf(panes[i]) === path) editors[i].sync(text);
}

/**
 * Announces the change to Linear, and writes back whatever Linear names.
 *
 * An issue is created there lazily — the first tick or the first row is what makes it
 * real, so a note somebody started and abandoned never becomes an issue anybody has to
 * triage. Identifiers come back into the note as `linear:: ENG-214`, which is how the
 * app knows, next time, that this row already exists over there.
 */
async function pushIssue(path: string, text: string, change: IssueChange): Promise<void> {
  const announce = change.ticked !== undefined || change.created !== undefined || change.issueState !== undefined;
  if (!issues.connected || !announce) return;

  const doc = parseIssue(text, noteName(path));
  let next = text;
  let failed = false;

  let ref = issueIds.ref(doc.identifier);
  if (!ref) {
    const made = await issues.create(doc.title);
    if (made) {
      issueIds.remember(made);
      ref = { id: made.id, identifier: made.identifier };
      doc.identifier = made.identifier;
      doc.url = made.url;
      next = writeIssue(next, doc);
    } else {
      failed = true;
    }
  }

  if (ref && change.created !== undefined) {
    const row = doc.rows[change.created];
    if (row?.title.trim() && !row.identifier) {
      const made = await issues.addRow(ref, row.title.trim());
      if (made) {
        issueIds.remember(made);
        doc.rows[change.created].identifier = made.identifier;
        next = writeIssue(next, doc);
      } else {
        failed = true;
      }
    }
  }

  if (change.ticked !== undefined) {
    const row = doc.rows[change.ticked];
    const rowRef = issueIds.ref(row?.identifier ?? null);
    // A row with no sub-issue of its own yet: its state rides along when it gets one.
    if (row && rowRef && !(await issues.setState(rowRef, row.state))) failed = true;
  }
  if (ref && change.issueState !== undefined && !(await issues.setState(ref, change.issueState))) {
    failed = true;
  }

  if (next !== text) {
    await vault.write(path, next);
    graphView.setIssueRaw(path, next);
    syncOpenPanes(path, next);
    graphStale = true;
  }
  ui.status.textContent = failed
    ? `${noteName(path)} — saved here; Linear did not take it`
    : `${noteName(path)} → Linear${doc.identifier ? ` (${doc.identifier})` : ""}`;
}

/**
 * Right-click → "New Linear issue": the note goes down where the click was, gets its
 * name — which IS the issue's title — and opens its checklist ready to type into.
 * Nothing is announced to Linear until the first tick or the first row.
 */
async function createIssueAt(at: { x: number; y: number }, folder: string | null): Promise<void> {
  const dir = folder ?? ISSUE_DIR;
  // Named for the moment it was raised, as the cards are — "New issue" was a name
  // nobody meant, and one you had to clear before typing the one you did. The rename
  // field opens on it selected, so a real name is still one gesture away.
  const path = uniquePath(filePaths(), dir, stamp(), ".md");
  const text = issueTemplate();
  await vault.createFile(path, text);
  entries = [...entries, { path, kind: "file" }]; // so the rename's collision check sees it
  graphView.commitNode(path, noteName(path), dir || undefined, at, "linear");
  graphView.setIssueRaw(path, text);
  graphStale = true;
  ui.status.textContent = `created ${path} — name it, and its checklist opens`;
  graphView.renameNode(path, (name) => {
    void (async () => {
      const finalPath = name ? ((await applyRename(path, "file", name)) ?? path) : path;
      graphView.toggleIssue(finalPath, true); // its first line opens offering an arrow
    })();
  });
  await refreshSidebar();
}

/* ---------------------------------------------------------------- active --- */

/**
 * Right-click → "Style…": the note's own look on the canvas — a sign engraved on its
 * node, a colour, an animation and the animation's colour. The panel confirms nothing;
 * every click in it lands here, so the canvas answers the pick immediately and the vault
 * catches up behind. What is chosen is four lines in the note's own markdown (`sign::`,
 * `color::`, `anim::`, `anim-color::`), so a look travels with the folder and can be
 * typed or deleted by hand like any other field.
 */
async function styleNode(path: string, at: Client): Promise<void> {
  await flushAll(); // the note may be open and mid-edit — don't read behind its own buffer
  const text = await vault.read(path);
  showStylePicker(at, parseStyle(text), (style) => writeStyle(path, style));
}

/**
 * One write at a time, in the order the panel asked for them. Each pick reads the note
 * afresh: a style write must not carry a copy of the file taken before the pick before
 * it, or the last two clicks in the panel would undo each other.
 */
let styling: Promise<void> = Promise.resolve();

function writeStyle(path: string, style: NodeStyle): void {
  graphView.setNodeStyle(path, style); // the look answers the click; the file follows
  styling = styling.then(async () => {
    await flushAll();
    const text = await vault.read(path);
    // Animating a note un-parks it, in the file as well as on the canvas: a ghost left
    // behind in the markdown would put the note back on ice at the next rebuild.
    const next = style.anim ? setGhost(setStyle(text, style), false) : setStyle(text, style);
    if (next !== text) {
      if (!(await tryVault(`could not style ${noteName(path)}`, () => vault.write(path, next)))) return;
      // Open in a pane: the fields appear in the editor too, caret and undo history intact.
      for (let i = 0; i < panes.length; i++) if (pathOf(panes[i]) === path) editors[i].sync(next);
    }
    graphStale = true;
  });
}

/**
 * Right-click → "Make it a ghost": the note is parked — grey, dimmed and dotted. A line
 * in the note's own markdown (`ghost:: true`) like everything else the canvas knows about
 * it. A ghost does not animate: being on ice and being the live end of the vault are
 * opposite statements, so the pulse comes off with the same write.
 */
async function markNode(path: string, mark: Mark | null): Promise<void> {
  const before = graphView.nodeMark(path);
  graphView.setNodeMark(path, mark);
  await flushAll(); // the note may be open and mid-edit — don't write over its own buffer
  const text = await vault.read(path);
  const style = parseStyle(text);
  const next = setGhost(
    setStyle(text, { ...style, anim: mark === "ghost" ? "" : style.anim }),
    mark === "ghost",
  );
  if (next !== text) {
    if (!(await tryVault(`could not mark ${noteName(path)}`, () => vault.write(path, next)))) {
      graphView.setNodeMark(path, before); // the vault refused; the look must not claim otherwise
      return;
    }
    // Open in a pane: the field appears in the editor too, caret and undo history intact.
    for (let i = 0; i < panes.length; i++) if (pathOf(panes[i]) === path) editors[i].sync(next);
  }
  graphStale = true;
  ui.status.textContent =
    mark === "ghost"
      ? `${noteName(path)} is a ghost — right-click it to bring it back`
      : `${noteName(path)} is back to itself`;
}

/* ---------------------------------------------------------------- gemini --- */

const GEMINI_URL = "https://gemini.google.com/app";

/**
 * What a conversation note holds: the link its node opens, and its type on the last
 * line — `type:: gemini` is the whole notion of a typed note, written in markdown.
 * Google mints the conversation's own URL once you start chatting; paste it over
 * the generic one and the node points at that exact chat from then on.
 */
const geminiTemplate = (name: string): string => `# ${name}\n\n${GEMINI_URL}\n\ntype:: gemini\n`;

/**
 * Opens a chat and, when the note has no conversation of its own yet, arranges for
 * the minted URL to come back on its own. The desktop shell opens the chat in a
 * window it WATCHES: the moment Google assigns gemini.google.com/app/<id>, the link
 * is handed back and saved — no gesture at all. A plain browser cannot watch another
 * tab, so there the clipboard catch below stays the way home. Returns the status line.
 */
function openGeminiChat(path: string, target: string): string {
  const generic = target === GEMINI_URL; // no conversation of its own yet
  if (generic) armGeminiCapture(path); // follows renames; doubles as the fallback
  if (window.bedrock?.geminiChat) {
    void window.bedrock.geminiChat(target).then((convo) => {
      if (convo && generic) void adoptGeminiLink(convo);
    });
    return generic
      ? `${noteName(path)} — chat opened; the link saves itself once the conversation starts`
      : `${noteName(path)} → ${target}`;
  }
  const opened = window.open(target, "_blank", "noopener");
  if (!opened) return `the browser blocked the popup — ${target}`;
  return generic
    ? `${noteName(path)} — copy the conversation's URL in Gemini; it lands in the note when you come back`
    : `${noteName(path)} → ${target}`;
}

/** Click on a Gemini node: it is a link, not a page. Editing stays in the tree. */
function openGeminiNode(path: string, url: string | null): void {
  const message = openGeminiChat(path, url || GEMINI_URL);
  // One tick later: a click is also a grab+free to cytoscape, and the free handler
  // clears the hint right after this — the message has to land after that reset.
  window.setTimeout(() => {
    ui.status.textContent = message;
  }, 0);
}

/* ------------------------------------------------------- catching the link --- */
/*
 * Google mints a conversation's URL (gemini.google.com/app/<id>) only after the
 * first message, and no API hands it out — so the app catches it instead. Opening
 * a chat ARMS a capture for that note; the first gemini conversation URL copied
 * AFTER that moment is written into the note the instant this window is focused
 * again. One ⌘L ⌘C in the browser is the whole ceremony.
 */

const GEMINI_CONVO_RE = /^https:\/\/gemini\.google\.com\/(?:app|share)\/[\w-]+/;

/** The gemini note waiting for its conversation link, if any. */
let geminiCapture: string | null = null;
/** What the clipboard held when the capture was armed — only NEW copies count. */
let clipboardBefore = "";

function armGeminiCapture(path: string): void {
  geminiCapture = path;
  navigator.clipboard.readText().then(
    (text) => (clipboardBefore = text.trim()),
    () => {}, // no clipboard permission — an old link may be matched, nothing worse
  );
}

/**
 * Writes a caught conversation URL into the note that is waiting for one — reading
 * `geminiCapture` at write time rather than closing over a path, so a note renamed
 * mid-chat still receives its link.
 */
async function adoptGeminiLink(url: string): Promise<void> {
  const path = geminiCapture;
  if (!path) return;
  if (!(await vault.exists(path))) {
    geminiCapture = null; // the note went away while they were chatting
    return;
  }
  const text = await vault.read(path);
  if (!text.includes(url)) {
    // Swap the note's current link (the generic /app one) for the real conversation;
    // a note somebody stripped the link from gets it appended instead.
    const held = /https?:\/\/[^\s)\]>]+/.exec(text)?.[0];
    const next = held ? text.replace(held, url) : `${text.replace(/\n*$/, "")}\n\n${url}\n`;
    await vault.write(path, next);
    graphView.setGeminiUrl(path, url);
    graphStale = true;
    for (let i = 0; i < panes.length; i++) if (pathOf(panes[i]) === path) await renderPage(i);
    ui.status.textContent = `${noteName(path)} now opens its own conversation`;
  }
  geminiCapture = null;
}

async function catchGeminiLink(): Promise<void> {
  if (!geminiCapture) return;
  let copied = "";
  try {
    copied = (await navigator.clipboard.readText()).trim();
  } catch {
    return; // no clipboard permission — the feature just stays quiet
  }
  if (copied === clipboardBefore) return; // still whatever was there before the chat
  const url = GEMINI_CONVO_RE.exec(copied)?.[0];
  if (url) await adoptGeminiLink(url);
}

window.addEventListener("focus", () => void catchGeminiLink());

/**
 * "New Gemini conversation" — from the canvas menu, or from a link draft released on
 * empty space (`source` is then the note the arrow came from). The chat is NOT opened
 * yet: first the conversation gets its name, and committing the name is what sends
 * you to Gemini.
 */
async function createGeminiAt(
  at: { x: number; y: number },
  folder: string | null,
  source: string | null = null,
): Promise<void> {
  const dir = folder ?? "";
  const path = uniquePath(filePaths(), dir, "Gemini chat", ".md");
  await vault.createFile(path, geminiTemplate(noteName(path)));
  entries = [...entries, { path, kind: "file" }]; // so the rename's collision check sees it
  if (source) {
    graphView.commitLink(source, path, {
      label: noteName(path),
      parent: dir || undefined,
      at,
      type: "gemini",
      url: GEMINI_URL,
    });
  } else {
    graphView.commitNode(path, noteName(path), dir || undefined, at, "gemini", GEMINI_URL);
  }
  graphStale = true;
  ui.status.textContent = `created ${path} — name the conversation, and the chat opens`;
  graphView.renameNode(path, (name) => {
    // Standalone conversation: committing the name is the user gesture the popup
    // blocker honours, so the chat opens HERE, synchronously; the rename's own
    // async work follows behind and the capture follows the rename.
    if (!source) {
      const message = openGeminiChat(path, GEMINI_URL);
      window.setTimeout(() => {
        ui.status.textContent = message;
      }, 0);
    }
    void (async () => {
      const finalPath = name ? ((await applyRename(path, "file", name)) ?? path) : path;
      if (geminiCapture === path) geminiCapture = finalPath;
      if (!source) return;
      // Linked conversation: the connection gets its name too, exactly like drawing
      // any link — and only THEN does Gemini open. All the naming happens at home;
      // committing the label is itself a gesture, so the popup ban stays satisfied.
      graphView.promptConnection(source, finalPath, (label) => {
        const message = openGeminiChat(finalPath, GEMINI_URL);
        window.setTimeout(() => {
          ui.status.textContent = message;
        }, 0);
        void finishLink(source, finalPath, label);
      });
    })();
  });
  await refreshSidebar();
}

/* ----------------------------------------------------------------- files --- */

/**
 * A file/folder note is a pointer in the session note's mould: no prose, just what it
 * points at. `path::` is the disk path exactly as the picker handed it over — absolute,
 * in whichever slash flavour this machine writes.
 */
const fsTemplate = (kind: "file" | "folder", target: string): string =>
  `type:: ${kind}\n\npath:: ${target}\n`;

/** The last path segment, either slash flavour — what the node is named after. */
const fsBasename = (target: string): string =>
  target.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || target;

/**
 * "Link a file/folder…" — from the canvas menu, or from a link draft released on empty
 * space (`source` is then the note the arrow came from). The OS picker does the choosing,
 * and for a folder its own New Folder button is how one that does not exist yet gets
 * made — no in-app naming step. The node is named after what was picked; dismissing the
 * picker makes nothing.
 */
async function createFsAt(
  at: { x: number; y: number },
  folder: string | null,
  kind: "file" | "folder",
  source: string | null = null,
): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) {
    ui.status.textContent = "File and folder links need the desktop app — npm start";
    return;
  }
  const target = await bridge.pickPath(kind);
  if (!target) return; // the picker was dismissed — nothing made
  const dir = folder ?? "";
  const path = uniquePath(filePaths(), dir, fsBasename(target), ".md");
  await vault.createFile(path, fsTemplate(kind, target));
  entries = [...entries, { path, kind: "file" }];
  if (source) {
    graphView.commitLink(source, path, {
      label: noteName(path),
      parent: dir || undefined,
      at,
      type: kind,
      fspath: target,
    });
    // The connection can be named like any drawn link. The note itself is not renamed
    // here: its name came off the disk, which is the whole point of it.
    graphView.promptConnection(source, path, (label) => void finishLink(source, path, label));
  } else {
    graphView.commitNode(path, noteName(path), dir || undefined, at, kind, undefined, target);
  }
  graphStale = true;
  ui.status.textContent = `${noteName(path)} → ${target}`;
  await refreshSidebar();
}

/**
 * Opens a file/folder node's target the OS way — the default app for a file, a
 * Finder/Explorer window for a folder. A target that has gone missing (or a note whose
 * `path::` line was stripped) is offered the picker again, and the new choice is written
 * back into the note — the node heals itself rather than just complaining.
 */
async function openFsNode(path: string, target: string | null, kind: "file" | "folder"): Promise<void> {
  const bridge = window.bedrock;
  // One tick later: a click is also a grab+free to cytoscape, and the free handler
  // clears the hint right after this — the message has to land after that reset.
  const say = (message: string): void => {
    window.setTimeout(() => {
      ui.status.textContent = message;
    }, 0);
  };
  if (!bridge) {
    say("Opening files needs the desktop app — npm start");
    return;
  }
  const opened = target ? await bridge.openPath(target) : "missing";
  if (opened === "opened") {
    say(`${noteName(path)} → ${target}`);
    return;
  }
  if (opened !== "missing") {
    say(`the OS could not open ${target} — ${opened}`);
    return;
  }
  say(`${target ? `${target} is gone` : "the note carries no path"} — pick where the ${kind} lives now`);
  const next = await bridge.pickPath(kind);
  if (!next) return; // declined — the note keeps saying what it said
  await flushAll(); // the note may be open and mid-edit; the rewrite must not clobber
  const text = await vault.read(path);
  await vault.write(path, setField(text, "path", next));
  graphView.setFsPath(path, next);
  graphStale = true;
  for (let i = 0; i < panes.length; i++) if (pathOf(panes[i]) === path) await renderPage(i);
  const retry = await bridge.openPath(next);
  say(retry === "opened" ? `${noteName(path)} → ${next}` : `the OS could not open ${next} — ${retry}`);
}

/* ------------------------------------------------------------------- web --- */

/**
 * A webpage note is a pointer, in the file/folder note's mould: the address it stands
 * for, and nothing said on its behalf. `url::` is the address after the shell has
 * followed whatever redirects the site felt like — the one that actually answered.
 * The icon is deliberately NOT in here: a scraped logo is cache, it lives in the app's
 * own folder, and a vault of plain files keeps facts.
 */
const webTemplate = (url: string): string => `type:: web\n\nurl:: ${url}\n`;

/**
 * What somebody pasted, made into an address. A bare `stripe.com/docs` is what people
 * actually paste, so it is read as https; anything that is not a web address at all
 * (a file path, a sentence) comes back null and the node is never made.
 */
function readUrl(typed: string): string | null {
  const text = typed.trim();
  if (!text || /\s/.test(text)) return null;
  const guessed = /^[a-z][\w+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(guessed);
    // Only the web: `file:` and friends are the Files integration's business, not this one.
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The host, minus the `www.` nobody reads — the name a page wears until it has told us its own. */
const webHost = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "webpage";
  }
};

/** A page title is somebody else's text: it has to survive being used as a file name. */
const asFileName = (title: string): string =>
  title.replace(/[\\/:*?"<>|[\]#^]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

/**
 * "Link a webpage…" — from the canvas menu, or from a link draft released on empty space
 * (`source` is then the note the arrow came from). Paste an address and the node is there
 * at once, named after the host and wearing a globe; the site is asked for its title and
 * its icon behind that, and the node takes both on as soon as they arrive.
 */
async function createWebAt(
  at: { x: number; y: number },
  folder: string | null,
  source: string | null = null,
): Promise<void> {
  const typed = await askText("Paste the webpage's address", "", "Add");
  if (typed === null) return; // dismissed — nothing made
  const url = readUrl(typed);
  if (!url) {
    ui.status.textContent = `${typed} is not a web address`;
    return;
  }
  const dir = folder ?? "";
  const path = uniquePath(filePaths(), dir, webHost(url), ".md");
  await vault.createFile(path, webTemplate(url));
  entries = [...entries, { path, kind: "file" }];
  if (source) {
    graphView.commitLink(source, path, {
      label: noteName(path),
      parent: dir || undefined,
      at,
      type: "web",
      url,
    });
  } else {
    graphView.commitNode(path, noteName(path), dir || undefined, at, "web", url);
  }
  graphStale = true;
  ui.status.textContent = `${noteName(path)} → ${url}`;
  await refreshSidebar();
  // The site is asked BEFORE the connection is named, because its answer can rename the
  // note — and a link written against the name it had a moment ago points at nothing.
  // Same order as naming a new note by hand: the note settles, then the line does.
  const settled = await adoptWebPage(path, url, noteName(path));
  if (source) {
    graphView.promptConnection(source, settled, (label) => void finishLink(source, settled, label));
  }
}

/**
 * Asks the site who it is, and lets the node say so: the icon goes on, and the note takes
 * the page's own title for a name — `Hacker News` rather than `news.ycombinator.com`. The
 * host stands in until then, and stays if the site says nothing, so this failing costs the
 * node nothing it had. `born` is the name the note was made with: anything else means
 * somebody has named it themselves while the site was thinking, and that name wins.
 *
 * Returns where the note ended up — which is what anything written afterwards has to
 * point at.
 */
async function adoptWebPage(path: string, url: string, born: string): Promise<string> {
  const found = await fetchWebPage(url);
  if (!found) return path;
  if (!(await vault.exists(path))) return path; // deleted while the site was thinking
  const wanted = asFileName(found.title);
  if (!wanted || wanted === born || noteName(path) !== born) return path;
  // A second bookmark on the same page is "Hacker News 2", not the host it started as.
  const free = uniquePath(
    filePaths().filter((other) => other !== path),
    dirname(path),
    wanted,
    ".md",
  );
  return (await applyRename(path, "file", noteName(free))) ?? path;
}

/**
 * One scrape, shared: several nodes pointing at the same page ask once between them, and
 * the icon is handed to the graph the moment it lands. Answers are remembered here for the
 * session and in the shell across launches, so a graph of bookmarks costs one scrape each,
 * ever. Without the desktop shell there is nothing to ask — the nodes keep their globes.
 */
const webPages = new Map<string, Promise<{ title: string; icon: string } | null>>();

function fetchWebPage(url: string): Promise<{ title: string; icon: string } | null> {
  const known = webPages.get(url);
  if (known) return known;
  const bridge = window.bedrock;
  const job: Promise<{ title: string; icon: string } | null> = bridge
    ? bridge.webPage(url).then(
        (found) => {
          graphView.setWebIcon(url, found.icon);
          return { title: found.title, icon: found.icon };
        },
        () => {
          // A site that is unreachable now may not be later: forget the refusal rather
          // than remember it, so the next draw of the graph tries again.
          webPages.delete(url);
          return null;
        },
      )
    : Promise.resolve(null);
  webPages.set(url, job);
  return job;
}

/**
 * The faces of every webpage node on the canvas, fetched once each. Runs after a draw
 * rather than during one: a node must appear the instant it is made, wearing a globe if
 * that is all it has yet.
 */
function refreshWebIcons(): void {
  if (!settings.enabled("web") || !window.bedrock) return;
  for (const node of graphView.webNodes()) {
    if (node.url && !node.fetched) void fetchWebPage(node.url);
  }
}

/**
 * Click on a webpage node: the page opens in the real browser — the shell sends http(s)
 * links there, and that is where somebody's actual session with that site lives. A note
 * whose `url::` line has been stripped asks for the address again and writes it back,
 * the way a file node offers the picker when its target has moved.
 */
async function openWebNode(path: string, url: string | null): Promise<void> {
  // One tick later: a click is also a grab+free to cytoscape, and the free handler
  // clears the hint right after this — the message has to land after that reset.
  const say = (message: string): void => {
    window.setTimeout(() => {
      ui.status.textContent = message;
    }, 0);
  };
  if (!url) {
    say(`${noteName(path)} carries no address — paste the one it stands for`);
    const typed = await askText("Paste the webpage's address", "", "Use this");
    const next = typed === null ? null : readUrl(typed);
    if (!next) {
      if (typed !== null) say(`${typed} is not a web address`);
      return;
    }
    await flushAll(); // the note may be open and mid-edit; the rewrite must not clobber
    await vault.write(path, setField(await vault.read(path), "url", next));
    graphView.setWebUrl(path, next);
    graphStale = true;
    for (let i = 0; i < panes.length; i++) if (pathOf(panes[i]) === path) await renderPage(i);
    void fetchWebPage(next);
    say(`${noteName(path)} → ${next} — click it again to open the page`);
    return;
  }
  // In the desktop app this ALWAYS comes back null: the shell denies the popup and hands
  // the address to the system browser instead, which is the whole arrangement for links
  // here. Only a plain browser returning null means a popup was actually blocked.
  const opened = window.open(url, "_blank", "noopener");
  say(opened || window.bedrock ? `${noteName(path)} → ${url}` : `the browser blocked ${url}`);
}

/* ---------------------------------------------------------------- claude --- */

/**
 * A session note has NO PROSE IN IT. It is a handle on a session, not a document about one:
 * the folder the session runs in, the id the Claude app minted for it, how much of it has
 * been read — and nothing else, not even a heading. Its name on the graph is its filename,
 * which is the one place a name belongs when the file has nothing else in it.
 */
const claudeTemplate = (folder: string | null): string =>
  `type:: claude\n${folder ? `\nfolder:: ${folder}\n` : ""}`;

/** The name a session note is born with, until it is given one. */
const CLAUDE_NAME = "Claude session";

/**
 * Where a new session runs — asked, not guessed. "The folder Claude Code last worked in" is
 * a bad guess on a machine where anything else is using Claude Code: the most recent folder
 * is whatever happened to be touched last, which is rarely what this note is about. The
 * recent ones are offered because they are usually right; typing a path is always there.
 * Answered once per note, then it lives in the note as `folder::`.
 */
async function askClaudeFolder(): Promise<string | null> {
  const recent = (await window.bedrock?.claudeFolders(8).catch(() => [])) ?? [];
  // The vault itself belongs on the list — a session about these notes may well run in
  // them — but only if its location is already known. Asking where the vault lives in order
  // to ask which folder to run in is two questions to answer one.
  const root = knownVaultRoot();
  const choices = [...new Set([...recent, ...(root ? [root] : [])])];
  if (!choices.length) return askText("Which folder should this session run in?", "~/", "Use this");
  return askChoice(
    "Which folder should this session run in?",
    choices,
    "Another folder…",
    "Which folder should this session run in?",
  );
}

/** Notes with a start in flight — a second click must not open a second session. */
const claudeStarting = new Set<string>();

/**
 * Opens a session note's node.
 *
 * With an id in the note, that is `claude://resume` — the same session, in the state it was
 * left. Without one, the note may still HAVE a session: one was started, something was said
 * in it, and the id never made it home. So the note is given the chance to catch up with
 * itself off disk before anything new is opened — which is the difference between clicking a
 * node twice and ending up with two sessions.
 *
 * Only a note that has genuinely never been run starts one: the session opens in its folder
 * with the note's name already in the composer, and `started::` goes into the note first, so
 * even if this window never sees the id, the note knows enough to find it later.
 */
async function openClaudeSession(path: string, session: string | null): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) {
    ui.status.textContent = "Claude sessions need the desktop app — npm start";
    return;
  }
  if (session) return resumeClaudeSession(path, session);
  if (claudeStarting.has(path)) {
    ui.status.textContent = `${noteName(path)} — a session is already open for this note; send it a message and its id saves itself`;
    return;
  }
  await flushAll(); // the note may be open and mid-edit; its fields have to be current
  const text = await vault.read(path);
  // Started before and never caught? Then it is not a new session that is wanted.
  const caught = await adoptClaudeSession(path, parseField(text, "folder"), parseField(text, "started"));
  if (caught) return resumeClaudeSession(path, caught);

  const folder = parseField(text, "folder") || (await askClaudeFolder());
  if (!folder) return; // nowhere to run it, and the ask was declined
  const started = new Date().toISOString();
  // On disk BEFORE the link opens: this is the note's own record of what it is waiting for,
  // and it has to outlive this window.
  let next = setField(text, "started", started);
  if (!parseField(text, "folder")) next = setField(next, "folder", folder);
  if (next !== text) {
    if (!(await tryVault(`could not write to ${noteName(path)}`, () => vault.write(path, next)))) return;
    graphView.setClaudePending(path, folder, started);
    graphStale = true;
    syncOpenPanes(path, next);
  }
  claudeStarting.add(path);
  ui.status.textContent = `${noteName(path)} — empty session opening in ${folder}; the id saves itself on the first message`;
  try {
    const id = await bridge.claudeStart(folder);
    if (id) await saveClaudeSession(path, id);
  } catch (err) {
    ui.status.textContent = `Claude: ${(err as Error).message}`;
  } finally {
    claudeStarting.delete(path);
  }
}

/** Hands a note's session back to the Claude app, and counts that as having read it. */
async function resumeClaudeSession(path: string, session: string): Promise<void> {
  try {
    const how = await window.bedrock?.claudeOpen(session);
    await markSessionSeen(path);
    ui.status.textContent =
      how === "imported"
        ? `${noteName(path)} → its conversation, brought into Claude`
        : `${noteName(path)} → its conversation in Claude`;
  } catch (err) {
    ui.status.textContent = `Claude: ${(err as Error).message}`;
  }
}

/**
 * Looks on disk for the session a note started and never got the id of, and writes it in.
 * Returns the id, or null if there is nothing to catch up with — a note that was never
 * started, one whose session nobody has said anything in yet, or one the shell would only be
 * guessing at. Nothing is sent to Claude for these notes, so there is no fingerprint to match
 * on: when more than one session was started in that folder in the meantime, the note is left
 * unbound and SAYS SO, because a note pointing at the wrong session looks exactly as healthy
 * as one pointing at the right session — which is how this went unnoticed the first time.
 */
async function adoptClaudeSession(
  path: string,
  folder: string | null,
  started: string | null,
): Promise<string | null> {
  if (!folder || !started) return null;
  const found = await window.bedrock?.claudeAdopt(folder, started).catch(() => null);
  if (!found?.id) {
    if (found && found.candidates.length > 1 && !claudeAmbiguous.has(path)) {
      claudeAmbiguous.add(path);
      ui.status.textContent =
        `${noteName(path)} — ${found.candidates.length} sessions were started in ${folder} since; ` +
        `not guessing which is this note's. Right-click it → "Plug in a session…"`;
    }
    return null;
  }
  claudeAmbiguous.delete(path);
  await saveClaudeSession(path, found.id);
  return found.id;
}

/** Notes already reported as unbindable — the poll must not say it every four seconds. */
const claudeAmbiguous = new Set<string>();

/**
 * Writes a session's id into its note, and clears the `started::` marker it was found by —
 * the id says everything that line was standing in for. Safe to run twice: a note that
 * already carries this id is left exactly as it is.
 */
async function saveClaudeSession(path: string, id: string, folder?: string): Promise<void> {
  if (!(await vault.exists(path))) return; // the note went away mid-session
  await flushAll();
  const text = await vault.read(path);
  let next = setField(setField(text, "session", id), "started", null);
  // A session knows which folder it ran in better than the note does — a note plugged into
  // an existing session takes that folder rather than keeping whatever it was guessing at.
  if (folder) next = setField(next, "folder", folder);
  if (next === text) return;
  if (!(await tryVault(`could not write to ${noteName(path)}`, () => vault.write(path, next)))) return;
  graphView.setClaudeSession(path, id, folder);
  graphStale = true;
  syncOpenPanes(path, next);
  ui.status.textContent = `${noteName(path)} now opens its own session`;
}

/* --------------------------------------------------- plugging in a session --- */

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Compact enough to read in a list, and never the whole ISO stamp. */
const shortWhen = (ms: number): string => {
  const at = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${at.getMonth() + 1}/${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
};

/**
 * One line per session in the picker: what it was about, the folder it ran in, when it was
 * last touched, and the head of its id — which is there to be recognised, and to keep two
 * sessions with the same title from being the same line.
 */
const sessionLabel = (session: { id: string; folder: string; title: string; at: number }): string =>
  `${session.title || "(nothing said yet)"} — ${basename(session.folder) || "?"} · ` +
  `${shortWhen(session.at)} · ${session.id.slice(0, 8)}`;

/**
 * Right-click → "Plug in a session…": point this note at a session that already exists.
 *
 * The reliable counterpart to adoption. A note opened from the graph can only be guessed at,
 * because nothing is sent on its behalf to recognise it by — but a session already on this
 * machine can simply be CHOSEN, and then the note is plugged into it for good: its id goes
 * into the note, and a tap resumes it.
 */
async function plugInSession(path: string): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) {
    ui.status.textContent = "Claude sessions need the desktop app — npm start";
    return;
  }
  const sessions = (await bridge.claudeSessions(14).catch(() => [])) ?? [];
  const byLabel = new Map(sessions.map((session) => [sessionLabel(session), session]));
  const picked = await askChoice(
    `Which session should "${noteName(path)}" open?`,
    [...byLabel.keys()],
    "Paste a session id…",
    "Session id",
    "",
  );
  if (!picked) return;
  const chosen = byLabel.get(picked);
  const id = chosen?.id ?? picked.trim();
  if (!SESSION_ID_RE.test(id)) {
    ui.status.textContent = `"${id}" is not a session id`;
    return;
  }
  claudeAmbiguous.delete(path); // whatever it could not decide before, this settles
  await saveClaudeSession(path, id, chosen?.folder || undefined);
  void pollSessions(); // its dot should say something true immediately
}

/**
 * "New Claude session" — from the canvas menu, or from a link draft released on empty space
 * (`source` is then the note the arrow came from). The session is NOT opened yet: the note
 * gets its name first, which names the node on the graph and nothing else. Claude is never
 * told the name, or anything at all.
 */
async function createClaudeAt(
  at: { x: number; y: number },
  folder: string | null,
  source: string | null = null,
): Promise<void> {
  const dir = folder ?? "";
  // Asked now rather than at the click, so the note says where it runs from the start — and
  // only where the shell can answer: in a browser the note is made without a folder and the
  // click reports what it needs.
  const where = window.bedrock ? await askClaudeFolder() : null;
  const path = uniquePath(filePaths(), dir, CLAUDE_NAME, ".md");
  await vault.createFile(path, claudeTemplate(where));
  entries = [...entries, { path, kind: "file" }]; // so the rename's collision check sees it
  if (source) {
    graphView.commitLink(source, path, {
      label: noteName(path),
      parent: dir || undefined,
      at,
      type: "claude",
    });
  } else {
    graphView.commitNode(path, noteName(path), dir || undefined, at, "claude");
  }
  graphStale = true;
  ui.status.textContent = `created ${path} — name it, and the session opens${where ? ` in ${where}` : ""}`;
  graphView.renameNode(path, (name) => {
    void (async () => {
      const finalPath = name ? ((await applyRename(path, "file", name)) ?? path) : path;
      // No popup blocker to satisfy here — the shell hands the link to the Claude app — so
      // the session can wait for the rename to land and be prompted with the real name.
      if (!source) {
        await openClaudeSession(finalPath, null);
        return;
      }
      // Linked session: the connection gets its name too, exactly like drawing any link,
      // and only then does the session open.
      graphView.promptConnection(source, finalPath, (label) => {
        void finishLink(source, finalPath, label);
        void openClaudeSession(finalPath, null);
      });
    })();
  });
  await refreshSidebar();
}

/* ------------------------------------------------- what the sessions are doing --- */

/** How often the graph asks what the sessions are doing. */
const SESSION_POLL_MS = 4000;
let sessionTimer: number | undefined;

/**
 * Keeps the corner dots current. Polled rather than watched: the shell would need a file
 * watcher per transcript to push this, and reading the tail of a handful of files every few
 * seconds is both cheaper than that and unable to miss an append. Runs only while the
 * integration is on, the graph is actually on screen, and the vault has sessions to ask
 * about — a vault with none never wakes the shell at all.
 */
async function pollSessions(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge || !settings.enabled("claude")) return;
  if (!panes.some((p) => tabOf(p)?.kind === "graph")) return;
  const notes = graphView.sessionNodes();
  if (!notes.length) return;
  // A note still waiting on an id gets another go at finding it every time round. This is
  // the belt to the watch's braces: whatever happened to the window that opened the link —
  // a reload, a quit, a second click — the id lands as soon as the transcript exists.
  for (const note of notes) {
    if (!note.session && note.started && !claudeStarting.has(note.path)) {
      await adoptClaudeSession(note.path, note.folder, note.started);
    }
  }
  const sessions = graphView.sessionNodes().filter((note) => note.session);
  if (!sessions.length) return;
  const status = await bridge.claudeStatus(sessions.map((s) => s.session)).catch(() => null);
  if (!status) return; // the shell is unhappy; the dots keep saying what they last said
  for (const { path, session, seen } of sessions) {
    const found = status[session];
    // A finished turn is only worth a badge if nobody has read it. The note knows about
    // the readings that went through the graph (`seen::`); the Claude app knows about
    // the ones that did not (`focus` is when it last had the session on screen) — a
    // session opened straight in the app must not wear a blue dot forever.
    const read = found ? Math.max(seen, found.focus) : 0;
    const state: SessionState = !found
      ? "idle"
      : found.state === "done"
        ? found.at > read
          ? "unseen"
          : "idle"
        : found.state;
    graphView.setSessionState(path, state, found?.at ?? 0);
  }
}

/** Starts or stops the poll to match the toggles and what is on screen. */
function watchSessions(): void {
  const wanted = settings.enabled("claude") && !!window.bedrock;
  if (wanted && sessionTimer === undefined) {
    sessionTimer = window.setInterval(() => void pollSessions(), SESSION_POLL_MS);
    void pollSessions(); // don't make the first dot wait out a whole interval
  } else if (!wanted && sessionTimer !== undefined) {
    clearInterval(sessionTimer);
    sessionTimer = undefined;
  }
}

/**
 * Opening a session is reading it, so the blue dot goes out — `seen::` in the note, which
 * is why it stays out across a restart. Written only when there is something to have seen:
 * a session nobody has run yet has no turn to be caught up with.
 */
async function markSessionSeen(path: string): Promise<void> {
  const at = graphView.sessionActivity(path);
  if (!at) return;
  graphView.setSessionSeen(path, at);
  await flushAll();
  const text = await vault.read(path);
  const next = setField(text, "seen", new Date(at).toISOString());
  if (next === text) return;
  await tryVault(`could not mark ${noteName(path)} as seen`, () => vault.write(path, next));
  graphStale = true;
  for (let i = 0; i < panes.length; i++) if (pathOf(panes[i]) === path) editors[i].sync(next);
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
ui.gitCommit.addEventListener("click", () => void commitVault());

const redrawSettings = mountSettings(ui.settings, ui.settingsPanel, settings, {
  detail: (feature) => (feature === "linear" ? linearDetail() : null),
  onAction: (feature) => {
    if (feature === "linear") void setUpLinear();
  },
});
settings.onChange = applyFeatures;
// A card is a file in a visible folder, so making or deleting one must show in the tree.
stickies.onFilesChanged = () => void refreshSidebar();

/* ------------------------------------------------------------ attachments --- */

/**
 * Store the images and write their embeds into the open note. `at` is where they land — the
 * position under a drop, or null for the caret's own line. Several files go in one after
 * another, each after the last, so a drop of four pictures reads in the order they were picked.
 */
async function attachImages(index: number, files: File[], at: number | null): Promise<void> {
  const tab = tabOf(pane(index));
  if (tab?.kind !== "file") {
    ui.status.textContent = "open a note first — images are attached to a note";
    return;
  }
  if (!files.length) return;

  const editor = editors[index];
  const saved: string[] = [];
  let pos = at;
  for (const file of files) {
    try {
      const { path, embed } = await saveImage(vault, file);
      saved.push(path);
      pos = editor.insertAt(pos, embed);
    } catch (err) {
      ui.status.textContent = `could not attach ${file.name}: ${(err as Error).message}`;
      break;
    }
  }
  if (!saved.length) return;
  // The vault has files it did not have a moment ago, so what an embed resolves to has
  // changed — including embeds already cached as missing.
  resetAssets();
  await flushSave(index);
  await save(index);
  ui.status.textContent =
    saved.length === 1 ? `attached ${saved[0]}` : `attached ${saved.length} images to ${tab.path}`;
}

/**
 * The note's page as a drop target. A drop that lands in the text is handled by the editor,
 * which knows the position under the cursor; this catches the rest of the page — the margins
 * either side of the column — and puts those at the end of the note.
 */
function makeDropZone(zone: HTMLElement, index: number): void {
  zone.addEventListener("dragover", (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    zone.classList.add("drop-target");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drop-target"));
  zone.addEventListener("drop", (event: DragEvent) => {
    zone.classList.remove("drop-target");
    if (event.defaultPrevented) return; // the editor took it, at the position dropped on
    const files = imageFiles(event.dataTransfer);
    if (!files.length) return; // not images — let the default handling have it
    event.preventDefault();
    void attachImages(index, files, null);
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
      case "split":
        void splitPane();
        break;
      case "unsplit":
        void unsplit();
        break;
    }
  });

  // Typing, Escape, ⌘-click on a link and pasted screenshots all arrive through the editor's
  // own hooks, where the selection is — see the `createEditor` call above.
  makeDropZone(v.page, index);
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
  void issueIds.flush();
  void settings.flush();
});

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => escapeHtml(s).replace(/"/g, "&quot;");

// Open the first note before the first render, so launching the app doesn't solve
// a graph layout the user never asked to see behind the note they land on.
void (async () => {
  await spatial.attach(vault);
  await stickies.attach(vault);
  await issueIds.attach(vault);
  await settings.attach(vault);
  await adoptLinearKey(); // a key stored on a previous run connects itself
  applyFeatures();
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
