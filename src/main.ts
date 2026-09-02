import "./style.css";
import { GraphView, TYPE_ICONS, type Client, type Doc, type DraftKind, type SessionState } from "./graph";
import {
  LinkResolver,
  labelledLink,
  parseField,
  parseStyle,
  parseType,
  pinText,
  relinkText,
  setField,
  setStyle,
  unlinkText,
  type NodeStyle,
} from "./links";
import { showFolderStylePicker, showStylePicker } from "./node-style";
import { askChoice, askConfirm, askPick, askText } from "./dialog";
import { EDGE_DIR, isEdgeNote, renamedEdgeNote } from "./edges";
import { showMenu, type MenuItem } from "./menu";
import {
  SettingsStore,
  applyTheme,
  canvasHex,
  mountSettings,
  type Feature,
  type SetupLine,
  type SetupPage,
} from "./settings";
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
  fetchProjects,
  fetchTeams,
  issueTemplate,
  parseIssue,
  writeIssue,
  type Filing,
  type IssueSource,
  type LinearCall,
  type Team,
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
  newFolder: el<HTMLButtonElement>("new-folder"),
  graph: el<HTMLButtonElement>("graph"),
  crumb: el("crumb"),
  tree: el("tree"),
  floatControls: el("float-controls"),
  welcome: el("welcome"),
  panes: el("panes"),
  splitter: el("splitter"),
  cy: el("cy"),
  status: el("status"),
  settings: el<HTMLButtonElement>("settings"),
  settingsPanel: el("settings-modal"),
};


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

/** Bedrock's own folder in a menu: the blue frame a folder box is on the canvas —
    deliberately not the yellow disk folder, which is a different thing entirely. */
const BOX_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="2" fill="rgba(76,141,255,0.18)" stroke="#4c8dff" stroke-width="1.6"/></svg>',
  );

/** What "an existing note" looks like in a menu: the plain red circle a note is. */
const NOTE_DOT =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#f92411"/></svg>',
  );

const graphView = new GraphView(ui.cy, {
  // There are no pages any more — the graph is the whole app, and a note is a pointer
  // at something with its own home. A holder has nowhere to go yet, and says what would
  // give it somewhere.
  onOpen: (path) => {
    ui.status.textContent = `${noteName(path)} is a holder — right-click → Turn into makes it something`;
  },
  onOpenAntigravity: (path, conversation) => void openAntigravitySession(path, conversation),
  onOpenClaude: (path, session) => void openClaudeSession(path, session),
  onOpenPath: (path, target, kind) => void openFsNode(path, target, kind),
  onOpenWeb: (path, url) => void openWebNode(path, url),
  onIssueEdit: (path, text, change) => editIssue(path, text, change),
  onOpenIssue: (url) => {
    if (!window.open(url, "_blank", "noopener")) ui.status.textContent = `the browser blocked ${url}`;
  },
  onOpenEdge: (source, target) => relabelEdge(source, target),
  onOpenFreeform: (path, board) => void openFreeformNode(path, board),
  onOpenNotion: (path, url) => void openNotionNode(path, url),
  onOpenSlack: (path, url) => void openSlackNode(path, url),
  onOpenAppleNote: (path, note) => void openAppleNoteNode(path, note),
  onOpenWord: (path, doc) => void openWordNode(path, doc),
  onLinkExisting: (source, target) => linkNotes(source, target),
  onLinkNew: (source, at, folder, kind) => {
    if (kind === "antigravity") void createAntigravityAt(at, folder, source);
    else if (kind === "claude") void createClaudeAt(at, folder, source);
    else if (kind === "file" || kind === "folder") void createFsAt(at, folder, kind, source);
    else if (kind === "web") void createWebAt(at, folder, source);
    else if (kind === "freeform") void createFreeformAt(at, folder, source);
    else if (kind === "notion") void createNotionAt(at, folder, source);
    else if (kind === "slack") void createSlackAt(at, folder, source);
    else if (kind === "applenote") void createAppleNoteAt(at, folder, source);
    else if (kind === "word") void createWordAt(at, folder, source);
    // A plain draft released on empty space grows a holder: a named node with nothing
    // behind it yet, to be turned into something once it is known what.
    else void createHolderAt(at, folder, source);
  },
  onReparent: (path, folder) => void moveEntry(path, "file", folder, true),
  onRefolder: (path, folder) => void moveEntry(path, "dir", folder, true),
  onGroup: (picked, frame) => void groupIntoFolder(picked, frame),
  onNodeMenu: (path, client) => {
    /*
     * Right-click on a note. Everything here starts by drawing a LINK from this note, so
     * the two branches say so: "Link + Create" makes something new on the other end,
     * "Link + Attach" puts something that already exists there. Both leave you dragging a
     * draft, and where you drop it is where the new node lands — which is why picking a
     * Notion page in the menu still does not place anything yet.
     *
     * The same two branches, in the same order, as the canvas menu. A right-click should
     * not be a different vocabulary depending on what happened to be under it.
     */
    const create: MenuItem[] = [
      { label: "Holder", icon: NOTE_DOT, run: () => graphView.startLink(path) },
    ];
    const draft = (kind: DraftKind, label: string): void => {
      create.push({ label, icon: TYPE_ICONS[kind], run: () => graphView.startLink(path, kind) });
    };
    if (settings.enabled("antigravity")) draft("antigravity", "Antigravity session");
    if (settings.enabled("claude")) draft("claude", "Claude session");
    if (settings.enabled("files")) {
      draft("file", "File");
      draft("folder", "Folder");
    }
    if (settings.enabled("web")) draft("web", "Webpage");
    if (settings.enabled("freeform")) draft("freeform", "Freeform board");
    if (settings.enabled("notion")) draft("notion", "Notion page");
    if (settings.enabled("slack")) draft("slack", "Slack thread");
    if (settings.enabled("applenotes")) draft("applenote", "Apple note");
    if (settings.enabled("word")) draft("word", "Word document");

    const items: MenuItem[] = [{ label: "Link + Create", children: create }];
    // What already exists, starting with what is already on the canvas: a node. That draft
    // lands only on a note. The rest are drafts that already know what they are attaching
    // to — picking the thing arms the draft, and dropping it decides where. See
    // `startLink`'s `release`.
    const attach: MenuItem[] = [
      { label: "Existing node", icon: NOTE_DOT, run: () => graphView.startLink(path, "link") },
      ...attachMenu(
        (option, kind) => () =>
          graphView.startLink(path, kind, (at, folder, source) => void option.place(at, folder, source)),
      ),
    ];
    items.push({ label: "Link + Attach", children: attach });

    // A holder is a node waiting to be something: this is where it becomes one, keeping
    // its name, its place and its look. Only a note with no type yet is offered it — a
    // Notion page is not turned into a Word document, it is deleted and another made.
    if (graphView.nodeType(path) === "") {
      const into = turnIntoMenu(path);
      if (into.length) items.push({ label: "Turn into", children: into });
    }

    // Retargeting a note that is ALREADY a session note — a different thing from either
    // branch above, which both make a new note.
    if (settings.enabled("claude") && graphView.sessionNote(path)) {
      items.push({ label: "Plug in a session…", run: () => void plugInSession(path) });
    }
    if (settings.enabled("antigravity") && graphView.antigravityNote(path)) {
      items.push({ label: "Plug in a conversation…", run: () => void plugInAntigravitySession(path) });
    }
    if (settings.enabled("active")) {
      items.push({ label: "Style…", run: () => void styleNode(path, client) });
    }
    items.push(
      { label: "Copy path", run: () => void copyNotePath(path) },
      { label: "Rename", run: () => renameOnGraph(path) },
      { label: "Delete", run: () => void deleteEntry(path, "file") },
    );
    showMenu(client, items);
  },
  onEdgeMenu: (source, target, _label, client) => {
    // The pulse a note can wear, on the line between two of them. Naming the line stays
    // a click on it; the menu offers the same, so the right button is never a dead end.
    const items: MenuItem[] = [
      { label: "Name this connection…", run: () => relabelEdge(source, target) },
    ];
    if (settings.enabled("active")) {
      const mark = graphView.edgeMark(source, target);
      items.push({
        label: mark === "radiate" ? "Stop radiating" : "Make it radiate",
        run: () => graphView.setEdgeMark(source, target, mark === "radiate" ? null : "radiate"),
      });
    }
    showMenu(client, items);
  },
  onCanvasMenu: (at, client, folder) => {
    /*
     * Right-click on empty space. The same two branches as a note's menu, minus the
     * linking: "Create" makes a new thing here, "Attach" puts something that already
     * exists here. Each row wears its graph tile; switched-off integrations appear nowhere.
     */
    // The holder leads: it needs no integration and is what everything else can grow from.
    const create: MenuItem[] = [{ label: "Holder", icon: NOTE_DOT, run: () => void createHolderAt(at, folder) }];
    if (settings.enabled("applenotes")) {
      create.push({ label: "Apple note", icon: TYPE_ICONS.applenote, run: () => void createAppleNoteAt(at, folder) });
    }
    if (settings.enabled("notion")) {
      create.push({ label: "Notion page", icon: TYPE_ICONS.notion, run: () => void createNotionAt(at, folder) });
    }
    if (settings.enabled("slack")) {
      create.push({ label: "Slack thread", icon: TYPE_ICONS.slack, run: () => void createSlackAt(at, folder) });
    }
    if (settings.enabled("word")) {
      create.push({ label: "Word document", icon: TYPE_ICONS.word, run: () => void createWordAt(at, folder) });
    }
    if (settings.enabled("freeform")) {
      create.push({ label: "Freeform board", icon: TYPE_ICONS.freeform, run: () => void createFreeformAt(at, folder) });
    }
    if (settings.enabled("antigravity")) {
      create.push({
        label: "Antigravity session",
        icon: TYPE_ICONS.antigravity,
        run: () => void createAntigravityAt(at, folder),
      });
    }
    if (settings.enabled("claude")) {
      create.push({ label: "Claude session", icon: TYPE_ICONS.claude, run: () => void createClaudeAt(at, folder) });
    }
    if (settings.enabled("linear")) {
      create.push({ label: "Linear issue", icon: TYPE_ICONS.linear, run: () => void createIssueAt(at, folder) });
    }
    if (settings.enabled("stickies")) create.push({ label: "Sticky", run: () => graphView.addSticky(at) });
    if (settings.enabled("web")) {
      create.push({ label: "Webpage…", icon: TYPE_ICONS.web, run: () => void createWebAt(at, folder) });
    }
    if (settings.enabled("files")) {
      create.push(
        { label: "File on disk…", icon: TYPE_ICONS.file, run: () => void createFsAt(at, folder, "file") },
        { label: "Folder on disk…", icon: TYPE_ICONS.folder, run: () => void createFsAt(at, folder, "folder") },
      );
    }
    // A folder with nothing in it has no box, so "folder" IS the rectangle: pick the
    // notes and the folder is made around them.
    create.push({ label: "Folder", icon: BOX_ICON, run: () => graphView.startGroup() });

    const items: MenuItem[] = [{ label: "Create", children: create }];
    // Nothing to drag here: the click already said where, so a picked option lands at once.
    const attach = attachMenu((option) => () => void option.place(at, folder, null));
    if (attach.length) items.push({ label: "Attach", children: attach });

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
  const docs = await Promise.all(drawn.map(async (path) => ({ path, text: await vault.read(path) })));
  waiting = waitedFor(docs); // the graph's own read is also the answer `freshPath` needs
  return docs;
}

/**
 * The names something in the vault is already WAITING FOR: the target of every [[link]] that
 * resolves to nothing. Left behind by a note that was deleted, or typed for one that has not
 * been written yet. Read off the same pass the graph is drawn from, so it is as current as the
 * canvas the gesture is happening on.
 */
let waiting = new Set<string>();

function waitedFor(docs: Doc[]): Set<string> {
  const resolver = new LinkResolver(filePaths());
  const names = new Set<string>();
  for (const doc of docs) {
    for (const target of linkTargets(doc.text)) {
      const base = target.split("#")[0].trim();
      if (!base || resolver.resolve(base)) continue;
      // The bare name, however the link spelled it: a dangling `[[Untitled]]` is answered by
      // an Untitled in ANY folder, because that is how a bare link resolves.
      names.add(noteName(base).toLowerCase());
    }
  }
  return names;
}

/**
 * A path for a note the app is naming ITSELF — "Untitled", "Antigravity session", a page's host or its
 * title. Free like `uniquePath`, and free as well of the names something is already waiting for.
 *
 * A generated name is handed out again and again, and that is where connections from nowhere
 * came from. Draw a link to a new node, leave it "Untitled", delete it: the note it came from
 * keeps `[[Untitled]]`, pointing at nothing. The next Untitled the app makes answers that link
 * — and worse, when it is given its real name the rename carries the dead link along with it,
 * so a note nobody touched ends up pointing at something made minutes later, under a name that
 * looks entirely deliberate.
 */
function freshPath(dir: string, base: string, except?: string): string {
  const taken = filePaths().filter((path) => path !== except);
  const reserved = [...waiting].map((name) => join(dir, `${name}.md`));
  return uniquePath([...taken, ...reserved], dir, base, ".md");
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

/** The pill only speaks when something happened; at rest, the graph says everything. */
function statusText(): string {
  return "";
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
 * Takes the links to notes that have just been deleted out of every other note.
 *
 * A rename carries a note's incoming links along with it; a delete has to take them away. Left
 * behind, the line points at a note that is not there — it draws nothing, so the vault reads as
 * though the connection went with the note, and it lies there until something is given that
 * name again. That is what `waiting` then has to steer new notes around; better that there is
 * nothing to steer around.
 *
 * Only links that would be left dangling are touched: one that still finds a note of its own (a
 * name the vault has twice, say) is somebody's link to THAT note and stays. `before` is the
 * vault's paths as they were, the deleted ones included — without them there is no telling which
 * links used to point at what has gone. Returns how many notes were rewritten.
 */
async function unlinkVault(gone: Set<string>, before: string[]): Promise<number> {
  if (!gone.size) return 0;
  const was = new LinkResolver(before);
  const now = new LinkResolver(filePaths());
  const dead = (target: string): boolean => {
    const from = was.resolve(target);
    return !!from && gone.has(from) && now.resolve(target) === null;
  };
  let touched = 0;
  for (const path of filePaths()) {
    const text = await vault.read(path);
    const next = unlinkText(text, dead);
    if (next === text) continue;
    await vault.write(path, next);
    touched++;
  }
  // Same bargain as `relinkVault`: the loop rewrote the card files on disk like any other note,
  // and the cards' cache has to hear about it or a later card edit writes the dead link back.
  stickies.rewriteTexts((text) => unlinkText(text, dead));
  return touched;
}

/**
 * A note about to appear at `path` must not take links off the notes that have them. A bare
 * `[[Domain]]` means whichever Domain is filed nearest the root, so a new one named Domain and
 * filed nearer the root walks off with every one of those links — the new node draws edges
 * nobody gave it, and the old one loses the same edges in the same instant.
 *
 * Each of those links is pinned to what it means TODAY, written out as a full path, so the line
 * goes on saying what its author meant. Nothing is ever removed here: a link that resolves to
 * nothing is left alone, because writing `[[Roadmap]]` and making Roadmap afterwards is how a
 * note is linked before it exists, and that has to go on working. What stops a DEAD link being
 * inherited is that it should not be lying there — see `unlinkVault` — and that the names the
 * app hands out itself step around the ones being waited for — see `freshPath`.
 *
 * Returns how many notes were rewritten.
 */
async function pinShadowedLinks(path: string): Promise<number> {
  const paths = filePaths();
  if (!isMarkdown(path) || paths.includes(path)) return 0;
  const was = new LinkResolver(paths);
  const now = new LinkResolver([...paths, path]);
  const pin = (target: string): string | null => {
    // Only a link that changes hands, and only one that had a note of its own to begin with.
    if (now.resolve(target) !== path) return null;
    const held = was.resolve(target);
    return held && held !== path ? held.replace(/\.md$/i, "") : null;
  };
  let touched = 0;
  for (const note of paths) {
    const text = await vault.read(note);
    const next = pinText(text, pin);
    if (next === text) continue;
    await vault.write(note, next);
    touched++;
  }
  stickies.rewriteTexts((text) => pinText(text, pin));
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

/**
 * " — 2 older links left where they were": links this name would otherwise have walked off
 * with. Said out loud, because the app has just edited notes nobody asked it to open.
 */
const pinned = (count: number): string =>
  count
    ? ` — ${count} older link${count === 1 ? "" : "s"} left where ${count === 1 ? "it was" : "they were"}`
    : "";

/** " — unlinked from 3 notes", after a delete took its incoming links with it. */
const unlinkedFrom = (count: number): string =>
  count ? ` — unlinked from ${count} note${count === 1 ? "" : "s"}` : "";

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
  // Every name lands here — typed, or taken from a page's own title — so this is the one place
  // that has to hold the line: nothing in the vault is ever called something a [[link]] cannot
  // spell. See `tidyName`.
  const wanted = tidyName(name);
  if (!wanted || wanted === current) return path;
  const next = join(dirname(path), kind === "file" && !isMarkdown(wanted) ? `${wanted}.md` : wanted);
  if (next !== path && (filePaths().includes(next) || entries.some((e) => e.path === next))) {
    ui.status.textContent = `${next} already exists — not renamed`;
    return path;
  }
  await flushAll();
  // Before the name lands: the links elsewhere that this name would quietly take over.
  const shadowed = kind === "file" ? await pinShadowedLinks(next) : 0;
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
  ui.status.textContent = `renamed to ${next}${relinked(count)}${pinned(shadowed)}`;
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
  // An open buffer would write the links back over the top of the pass below.
  await flushAll();
  const gone = new Set(
    kind === "file"
      ? [path]
      : entries.filter((e) => e.kind === "file" && e.path.startsWith(path + "/")).map((e) => e.path),
  );
  const before = filePaths();
  await vault.remove(path, kind);
  entries = await vault.entries();
  // A deleted note takes its incoming links with it, or they lie in wait for the next note
  // to be given its name — which is how a connection nobody drew turns up on a new node.
  const unlinked = await unlinkVault(gone, before);
  await refresh();
  await showAll();
  ui.status.textContent = `deleted ${path}${unlinkedFrom(unlinked)}`;
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
  ui.welcome.hidden = true;
  vaultOpen = true;
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

/**
 * The note's absolute path on this disk, onto the clipboard — for handing to anything
 * outside the app. Absolute on purpose: a relative path only means something in here.
 */
async function copyNotePath(path: string): Promise<void> {
  const root = knownVaultRoot();
  if (!root) {
    ui.status.textContent = `where "${vault.name}" lives on disk is not known yet — Settings → Integrations → GitHub → Vault folder`;
    return;
  }
  const absolute = `${root.replace(/\/+$/, "")}/${path}`;
  await copyText(absolute);
  ui.status.textContent = `copied ${absolute}`;
}

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
 * The git integration lives on its own settings page now, not on the canvas: committing
 * and pushing are both actions there. The work happens in the desktop shell (see
 * `electron/main.cjs`) because a renderer cannot run git; in a plain browser these say so
 * instead of failing. Each leaves its outcome in the status line and redraws the page, so
 * the answer to "did it work?" lands both where you triggered it and where you can see it.
 */
/**
 * The repository as git last described it, or null when nothing has asked yet (no desktop
 * shell, or the vault's folder on disk is still unknown). Read from the shell rather than
 * remembered, for the same reason the CLIs are: it changes underneath the app constantly — every
 * note saved is a file changed — and a page quoting a stale count is worse than a blank one.
 */
let gitState: GitStatus | null = null;

/**
 * And why there is none, when the asking failed — which in practice means one thing: the
 * folder this vault is remembered as living in is not there any more. Kept and shown rather
 * than swallowed, because "could not read it" with no reason is a dead end, and this
 * particular reason has a fix the page can offer.
 */
let gitTrouble: string | null = null;

/**
 * What a rejected shell call actually said. Electron wraps a handler's error in a sentence
 * of its own ("Error invoking remote method 'git-status': Error: …") which names an internal
 * channel and buries the part meant to be read.
 */
const shellError = (err: unknown): string =>
  (err as Error).message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, "");

/**
 * Asks the shell where the repository stands, then redraws whatever is reporting it. Silent
 * by design: this runs when the settings window opens, so it uses the vault's folder only if
 * it is already known — being asked "where does this vault live?" by a window you just
 * opened to look at something else is not an answer to anything.
 */
async function refreshGit(): Promise<void> {
  const bridge = window.bedrock;
  const root = knownVaultRoot();
  if (!bridge || !root) {
    gitState = null;
    gitTrouble = null;
  } else {
    try {
      gitState = await bridge.gitStatus(root);
      gitTrouble = null;
    } catch (err) {
      gitState = null;
      gitTrouble = shellError(err);
    }
  }
  // A repository that already has an origin has answered the remote question itself, and
  // making somebody type a URL git could have told us is the sort of form this app avoids.
  if (gitState?.origin && !settings.setup().gitRemote) {
    settings.setSetup({ gitRemote: gitState.origin });
  }
  redrawSettings();
}

/**
 * Where this vault lives on disk — the folder every git action operates on.
 *
 * It is asked for once and remembered, which is right until the answer stops being true:
 * the folder gets renamed, or moved, or the vault is opened on a second machine where that
 * path means nothing. Before this existed there was no way to correct it from inside the
 * app, so a vault with a stale path had every git button fail at once and no way back.
 * The OS's own picker answers it where there is one, since the alternative is typing an
 * absolute path from memory.
 */
async function setVaultRoot(): Promise<void> {
  const bridge = window.bedrock;
  const current = knownVaultRoot();
  const chosen = bridge
    ? await bridge.pickPath("folder")
    : await askText(`Where does "${vault.name}" live on disk?`, current ?? `~/${vault.name}`, "Use this");
  if (!chosen) return;
  localStorage.setItem(ROOT_KEY + vault.name, chosen.replace(/\/+$/, ""));
  ui.status.textContent = `git: this vault is at ${chosen}`;
  await refreshGit();
}

async function commitVault(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) {
    ui.status.textContent = "git needs the desktop app — npm start";
    return;
  }
  const root = await vaultRoot();
  if (!root) return;
  await flushAll();
  ui.status.textContent = "git: committing…";
  try {
    ui.status.textContent = `git: ${await bridge.gitCommit(root)}`;
  } catch (err) {
    ui.status.textContent = `git: ${shellError(err)}`;
  }
  await refreshGit();
}

/**
 * Push what has been committed to the vault's GitHub remote. The remote is a choice kept
 * in the config; the machine's git holds who you are and the token or key that gets you
 * in, the same as it does for a commit. With no remote set there is nowhere to push, so
 * this asks for one first rather than failing at git.
 */
async function pushVault(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) {
    ui.status.textContent = "git needs the desktop app — npm start";
    return;
  }
  const root = await vaultRoot();
  if (!root) return;
  let remote = settings.setup().gitRemote;
  if (!remote) {
    if (!(await setGitRemote())) return; // asked, but nothing given
    remote = settings.setup().gitRemote;
  }
  await flushAll();
  ui.status.textContent = "git: pushing…";
  try {
    ui.status.textContent = `git: ${await bridge.gitPush(root, remote)}`;
  } catch (err) {
    ui.status.textContent = `git: ${shellError(err)}`;
  }
  await refreshGit();
}

/**
 * The other direction, without which the loop does not close: a repository made on GitHub
 * with a README, or a vault edited from a second machine, leaves push refused forever and
 * the only way out is a terminal. The shell aborts rather than leaving a half-rebased vault,
 * so the worst this can do is nothing — but the notes it brings in are notes the open panes
 * may be showing, so the sidebar is re-read afterwards.
 */
async function pullVault(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) {
    ui.status.textContent = "git needs the desktop app — npm start";
    return;
  }
  const root = await vaultRoot();
  if (!root) return;
  const remote = settings.setup().gitRemote;
  if (!remote) {
    ui.status.textContent = "git: set a remote first — there is nowhere to pull from";
    return;
  }
  await flushAll();
  ui.status.textContent = "git: pulling…";
  try {
    ui.status.textContent = `git: ${await bridge.gitPull(root, remote)}`;
    await refreshSidebar(); // the pull may have brought notes the tree does not know about
  } catch (err) {
    ui.status.textContent = `git: ${shellError(err)}`;
  }
  await refreshGit();
}

/**
 * The GitHub URL this vault pushes to. Kept in the config because it is a choice — which
 * repo — not a credential. Returns whether one is now set, so the push can ask for it and
 * carry on in the same gesture.
 */
async function setGitRemote(): Promise<boolean> {
  const current = settings.setup().gitRemote;
  const typed = await askText(
    "The GitHub repository to push to — an https:// or git@ URL. It says which repo; " +
      "this machine's git says who you are.",
    current || "https://github.com/you/vault.git",
    current ? "Change" : "Set",
  );
  if (typed === null) return Boolean(current); // dismissed (or emptied) — leave what was there
  settings.setSetup({ gitRemote: typed });
  ui.status.textContent = `git: pushes to ${typed}`;
  void refreshGit();
  return true;
}

/** Follows the toggles: what is switched off appears nowhere. */
function applyFeatures(): void {
  // Opening a vault runs this too, and the vault brings its own colours with it.
  applyLook();
  graphView.refreshOverlay();
  watchSessions();
  void ensureCardDirs();
}

/**
 * The vault's chosen ground, applied to the whole app. The canvas is only where the colour
 * is CHOSEN — a sidebar and an editor left behind on the old one read as a bug rather than
 * a setting, so the ground drives every surface (`applyTheme`) and the graph repaints to
 * match.
 */
function applyLook(): void {
  applyTheme(canvasHex(settings.look().bg));
  graphView.applyLook();
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
  const spelling = target.replace(/\.md$/i, "");
  // Resolved, or spelled the same. A link the vault cannot resolve is still a link that is
  // already in the note: without the second test, a target nothing can resolve — a name with a
  // space on the end, once — was written in again on every attempt, the same dead line twice.
  if (linkTargets(text).some((t) => resolver.resolve(t) === target || t.trim() === spelling.trim())) {
    return;
  }
  const gap = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  await vault.write(source, `${text}${gap}${labelledLink(label, spelling)}\n`);
}

/**
 * Click on an edge: name it, right on the line. There are no pages to open any more —
 * the graph is the whole app — so what a connection means is its label, edited in place
 * the same way it was given at birth.
 */
function relabelEdge(source: string, target: string): void {
  graphView.promptConnection(source, target, (label) => void applyEdgeLabel(source, target, label));
}

/**
 * Writes the new label home. The link line in the source note is rewritten whole —
 * which is the right thing for the standalone `label:: [[target]]` lines pointer notes
 * carry, and the known price for a link somebody once buried mid-sentence.
 */
async function applyEdgeLabel(source: string, target: string, fresh: string | null): Promise<void> {
  if (fresh === null) return; // Esc — leave it as it was
  const label = fresh.trim() || null;
  const text = await vault.read(source);
  const resolver = new LinkResolver(filePaths());
  const spelling = target.replace(/\.md$/i, "");
  const lines = text.split("\n");
  const at = lines.findIndex((line) =>
    linkTargets(line).some((t) => resolver.resolve(t) === target || t.trim() === spelling.trim()),
  );
  if (at < 0) {
    await insertCitation(source, target, label);
  } else {
    lines[at] = labelledLink(label, spelling);
    await vault.write(source, lines.join("\n"));
  }
  graphView.setEdgeLabel(source, target, label);
  graphStale = true;
  ui.status.textContent = label
    ? `${noteName(source)} —${label}→ ${noteName(target)}`
    : `unnamed: ${noteName(source)} → ${noteName(target)}`;
}

/** Sidebar-only refresh — avoids render()'s graph fit, which would jump the viewport. */
async function refreshSidebar(): Promise<void> {
  entries = await vault.entries();
  sidebar.render(entries, pathOf(pane()));
}

/** Click (or menu) on empty canvas / inside a folder box: spawn a note there. */
/** Name field floating on the node itself, pre-selected. */
function renameOnGraph(path: string): void {
  graphView.renameNode(path, (name) => {
    if (name) void applyRename(path, "file", name);
  });
}

/* --------------------------------------------------------------- holders --- */

/**
 * A holder is a node and nothing more: a name on the canvas, a place in a folder, a look if
 * it is given one — and no type, so a click opens nothing. It is what goes down when
 * something is known to belong HERE before it is known what it is. Right-click → "Turn into"
 * makes it any switched-on integration later, and it keeps its name, its links and its look
 * through that. On disk it is an empty note, which is what every plain note already was.
 */
const HOLDER_NAME = "Holder";

/**
 * "Holder" — from the canvas menu, or from a plain link draft released on empty space
 * (`source` is then the note the arrow came from). Made at once and named on the node, the
 * way every other new node is; nothing else to ask, because it stands for nothing yet.
 */
async function createHolderAt(
  at: { x: number; y: number },
  folder: string | null,
  source: string | null = null,
): Promise<void> {
  const dir = folder ?? "";
  const path = freshPath(dir, HOLDER_NAME);
  await vault.createFile(path, "");
  entries = [...entries, { path, kind: "file" }]; // so the rename's collision check sees it
  if (source) graphView.commitLink(source, path, { label: noteName(path), parent: dir || undefined, at });
  else graphView.commitNode(path, noteName(path), dir || undefined, at);
  graphStale = true;
  ui.status.textContent = `created ${path} — name it; right-click → Turn into makes it something`;
  graphView.renameNode(path, (name) => {
    void (async () => {
      const finalPath = name ? ((await applyRename(path, "file", name)) ?? path) : path;
      if (source) await finishLink(source, finalPath, null);
    })();
  });
  await refreshSidebar();
}

/** What a holder can become: any typed note the graph knows how to draw and open. */
type HolderKind = Exclude<DraftKind, "note"> | "linear";

/**
 * The integrations a holder can be turned into — the switched-on ones, in the order the
 * canvas menu offers them, each wearing its graph tile so the row looks like the node will.
 */
function turnIntoMenu(path: string): MenuItem[] {
  const rows: Array<[Feature, HolderKind, string]> = [
    ["applenotes", "applenote", "Apple note"],
    ["notion", "notion", "Notion page"],
    ["slack", "slack", "Slack thread"],
    ["word", "word", "Word document"],
    ["freeform", "freeform", "Freeform board"],
    ["antigravity", "antigravity", "Antigravity session"],
    ["claude", "claude", "Claude session"],
    ["linear", "linear", "Linear issue"],
    ["web", "web", "Webpage…"],
    ["files", "file", "File on disk…"],
    ["files", "folder", "Folder on disk…"],
  ];
  return rows
    .filter(([feature]) => settings.enabled(feature))
    .map(([, kind, label]) => ({
      label,
      icon: TYPE_ICONS[kind],
      run: () => void turnHolderInto(path, kind, label.replace(/…$/, "")),
    }));
}

/**
 * Right-click → "Turn into → X": the holder becomes an X note, and then what "Create → X"
 * does once a new note has its name happens to it — the page, board, note or document is
 * made under the holder's name; the session opens; the checklist unfolds. Two things are
 * settled BEFORE anything is written, so a change of mind leaves the holder exactly as it
 * was: whatever the integration needs to exist (the app, the shortcut, the sign-in), and
 * the one question a pointer type asks (an address, a pick in the OS dialog).
 */
async function turnHolderInto(path: string, kind: HolderKind, label: string): Promise<void> {
  const ready =
    kind === "applenote"
      ? await appleNotesReady()
      : kind === "notion"
        ? await notionReady()
        : kind === "slack"
          ? await slackReady()
          : kind === "word"
            ? await wordReady()
            : kind === "freeform"
              ? await freeformReady()
              : kind === "antigravity"
                ? await antigravityReady()
                : true;
  if (!ready) return;

  let pointer: string | null = null;
  if (kind === "web") {
    const typed = await askText("Paste the webpage's address", "", "Turn into");
    if (typed === null) return; // dismissed — still a holder
    pointer = readUrl(typed);
    if (!pointer) {
      ui.status.textContent = `${typed} is not a web address`;
      return;
    }
  } else if (kind === "file" || kind === "folder") {
    const bridge = window.bedrock;
    if (!bridge) {
      ui.status.textContent = "File and folder links need the desktop app — npm start";
      return;
    }
    pointer = await bridge.pickPath(kind);
    if (!pointer) return; // the picker was dismissed — still a holder
  }

  await flushAll(); // the note may be open and mid-edit — don't write behind its own buffer
  const text = await vault.read(path);
  const already = parseType(text);
  if (already) {
    ui.status.textContent = `${noteName(path)} is already a ${already} note`;
    return;
  }
  let next = setField(text, "type", kind);
  if (kind === "web" && pointer) next = setField(next, "url", pointer);
  if ((kind === "file" || kind === "folder") && pointer) next = setField(next, "path", pointer);
  // A session runs where the vault says its sessions run, when it has said; the note asks
  // otherwise, on its first opening, exactly as a session made from "Create" would.
  const runIn =
    kind === "claude" ? settings.claudeFolder() : kind === "antigravity" ? settings.antigravityFolder() : null;
  if (runIn) next = setField(next, "folder", runIn);
  // An issue is a checklist, so a holder with no rows gets the one an issue is born with.
  if (kind === "linear" && !/^\s*- \[[ xX]\]/m.test(next)) next = `- [ ] \n\n${next}`;
  if (!(await tryVault(`could not turn ${noteName(path)} into a ${label}`, () => vault.write(path, next)))) return;
  syncOpenPanes(path, next);
  graphView.setNodeType(path, kind, pointer ?? undefined);
  if (kind === "linear") graphView.setIssueRaw(path, next);
  graphStale = true;

  switch (kind) {
    case "applenote":
      return makeAppleNote(path);
    case "notion":
      return makeNotionPage(path);
    case "slack":
      return makeSlackThread(path);
    case "word":
      return makeWordDoc(path);
    case "freeform":
      return makeFreeformBoard(path);
    case "claude":
      return openClaudeSession(path, null);
    case "antigravity":
      return openAntigravitySession(path, null);
    case "linear":
      graphView.toggleIssue(path, true); // its first line opens offering an arrow
      ui.status.textContent = `${noteName(path)} → a Linear issue; its checklist is open`;
      return;
    case "web":
      if (pointer) void fetchWebPage(pointer); // the site's face goes on when it answers
      ui.status.textContent = `${noteName(path)} → ${pointer}`;
      return;
    default:
      ui.status.textContent = `${noteName(path)} → ${pointer}`;
  }
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
  issues = status.connected ? new LinearApi(linearCall, linearFiling()) : new LocalIssues();
  linearUser = status.connected ? status.user || "connected" : null;
}

/** One call to Linear, key added by the shell. Throws in a browser tab, which has none. */
const linearCall: LinearCall = (query, variables) => {
  const bridge = window.bedrock;
  if (!bridge) return Promise.reject(new Error("Linear needs the desktop app"));
  return bridge.linearCall(query, variables);
};

/** Where this vault files its issues, as the API wants it. */
const linearFiling = (): Filing => {
  const setup = settings.setup();
  return { team: setup.linearTeam, project: setup.linearProject };
};

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

/* ------------------------------------------------- the integrations' pages --- */

/**
 * What each integration's folded page says about itself.
 *
 * Worth being blunt about, because the four are not the same kind of thing at all. Only
 * Linear holds a credential of its own. Claude, Antigravity and git hold NONE — they run
 * through software already on this machine and already signed in, so their pages have
 * nothing to connect and say so. What those pages are for instead is saying WHERE the
 * work runs, and being honest about which of it Bedrock is not part of.
 */
function integrationPage(feature: Feature): SetupPage | null {
  const bridge = window.bedrock;
  const setup = settings.setup();
  switch (feature) {
    case "linear": {
      if (!bridge) {
        return {
          status: "desktop app only",
          lines: [
            {
              label: "Why",
              value: "the API needs a key, and a browser tab has neither a keychain to hold one nor a way past Linear's CORS. Ticks still work — they stay in the notes.",
            },
          ],
        };
      }
      if (!linearUser) {
        return {
          status: "not connected",
          lines: [
            {
              label: "API key",
              value: "not connected — ticks stay in the notes and nothing is pushed",
              action: { id: "connect", label: "Connect…" },
            },
            {
              label: "Where to get one",
              value: "linear.app → Settings → Security & access → Personal API keys. It is kept in this machine's keychain, never in the vault.",
            },
          ],
        };
      }
      return {
        status: setup.linearTeamName || "connected",
        ready: true,
        lines: [
          {
            label: "Account",
            value: linearUser,
            action: { id: "connect", label: "Disconnect" },
          },
          {
            label: "Team",
            value: setup.linearTeamName || "not chosen — issues go to the first team this key can see",
            action: { id: "team", label: setup.linearTeam ? "Change…" : "Choose…" },
          },
          {
            label: "Project",
            value: setup.linearProjectName || "none — issues go straight to the team",
            action: { id: "project", label: setup.linearProject ? "Change…" : "Choose…" },
          },
          {
            label: "What is pushed",
            value: "a new issue note, each checklist row under it as a sub-issue, and every tick's state. Nothing is ever read back — the notes are the truth.",
          },
        ],
      };
    }

    case "slack": {
      if (!bridge) {
        return {
          status: "desktop app only",
          lines: [
            {
              label: "Why",
              value: "the API needs a token, and a browser tab has neither a keychain to hold one nor a way past Slack's CORS.",
            },
          ],
        };
      }
      if (!slackState?.connected) {
        return {
          status: "not connected",
          lines: [
            {
              label: "Token",
              value: "not connected — no thread can be started or attached",
              action: { id: "connect", label: "Connect…" },
            },
            {
              label: "Where to get one",
              value:
                "api.slack.com/apps → Create New App → OAuth & Permissions. Under USER Token Scopes add chat:write, channels:history and channels:read (plus groups:history and groups:read for private channels), Install to Workspace, and copy the User OAuth Token (xoxp-…). Posts made with it are yours — your name, your face, no app in the channel. A bot token (xoxb-…) works too, and posts as the app.",
            },
          ],
        };
      }
      return {
        status: setup.slackChannelName || "connected",
        ready: !!setup.slackChannel,
        lines: [
          {
            label: "Workspace",
            value: `${slackState.team || "connected"}${slackState.user ? ` — posting as ${slackState.user}` : ""}${slackState.bot ? " (the app, not you — a user token would post as you)" : ""}`,
            action: { id: "connect", label: "Disconnect" },
          },
          {
            label: "Channel",
            value: setup.slackChannelName || "not chosen — threads have nowhere to start, and nothing to attach from",
            action: { id: "channel", label: setup.slackChannel ? "Change…" : "Choose…" },
          },
          {
            label: "What is posted",
            value:
              "a new thread note's name, as the first message of a thread in that channel — and nothing else, ever. Attaching a thread that is already going posts nothing: the note takes the head of its first message for a name.",
          },
        ],
      };
    }

    case "claude": {
      if (!bridge) return { status: "desktop app only", lines: [{ label: "Why", value: "sessions open through the Claude app, which a browser tab cannot reach — npm start" }] };
      const folder = settings.claudeFolder();
      const inTerminal = setup.claudeWindow === "terminal";
      const lines: SetupLine[] = [
        {
          label: "Run sessions in",
          value: "",
          choices: [
            { id: "run-app", label: "The Claude app", on: !inTerminal },
            { id: "run-terminal", label: "A terminal here", on: inTerminal },
          ],
        },
        {
          label: "Sign-in",
          value: inTerminal
            ? claudeAccount?.email
              ? `the CLI's own login — ${claudeAccount.email}` +
                (claudeAccount.org ? ` (${claudeAccount.org}` : "") +
                (claudeAccount.org && claudeAccount.seat ? `, ${claudeAccount.seat}` : "") +
                (claudeAccount.org ? ")" : "") +
                ". Separate from the Claude app's, so the two can be different accounts — `/login` in a session changes this one."
              : "the CLI's own login, which is separate from the Claude app's"
            : "none — the Claude app is already signed in as you. Bedrock never sees a token.",
        },
      ];
      if (inTerminal) {
        lines.push(
          {
            label: "The CLI",
            value: claudeCli
              ? `${claudeCli} — sessions run in your own terminal, not in a window here`
              : "not installed. Sessions are run by Claude Code's own CLI, so it has to be here: see claude.com/product/claude-code.",
          },
          {
            label: "How it behaves",
            value: "the node opens the session in whichever terminal owns .command files — Terminal, iTerm or Ghostty. The session is not Bedrock's process, so quitting Bedrock does nothing to it.",
          },
          {
            label: "In the Claude app",
            value: "a terminal session writes the ordinary transcript, so it can still be opened in the app later — switch this back and click the node.",
          },
        );
      } else {
        lines.push({
          label: "How it behaves",
          value: "the node opens the session in the Claude app's own window, which owns it from then on",
        });
      }
      lines.push({
        label: "Default folder",
        value: folder || "not set — every new session note asks where to run",
        action: { id: "folder", label: folder ? "Change…" : "Choose…" },
      });
      if (folder) {
        lines.push({
          label: "",
          value: "go back to asking for each new session",
          action: { id: "forget", label: "Forget it" },
        });
      }
      const status = inTerminal
        ? claudeCli
          ? "your terminal"
          : "claude CLI needed"
        : folder
          ? basename(folder) || folder
          : "asks each time";
      return { status, ready: !inTerminal || !!claudeCli, lines };
    }

    case "antigravity": {
      if (!bridge) {
        return {
          status: "desktop app only",
          lines: [
            {
              label: "Why",
              value: "sessions run the `agy` CLI in your own terminal, and a browser tab can start neither — npm start",
            },
          ],
        };
      }
      const folder = settings.antigravityFolder();
      if (!agyCli) {
        return {
          status: "agy not installed",
          lines: [
            {
              label: "The CLI",
              value: agyRan
                ? "not on the path Bedrock can see. It has run on this machine before, so it is probably installed somewhere a login shell finds and this app does not — check `which agy`."
                : "not installed. Sessions are run by Antigravity's own CLI, so it has to be here: see antigravity.google/docs/cli.",
            },
            {
              label: "Why a CLI",
              value: "so the agent is genuinely outside Bedrock — it keeps working when this app is shut, and its login is its own",
            },
          ],
        };
      }
      const lines: SetupLine[] = [
        {
          label: "The CLI",
          value: `${agyCli} — sessions run in your own terminal, not in a window here`,
        },
        {
          label: "Sign-in",
          value:
            "the CLI's own, held in this machine's keychain. Bedrock never reads it and has no sign-in of its own to offer: a session that needs a login asks for one in the terminal, where it can be answered.",
        },
        {
          label: "How it behaves",
          value:
            "the node mints a conversation, writes its id into the note, and opens it in whichever terminal owns .command files — Terminal, iTerm or Ghostty. Closing that window is between you and the CLI; Bedrock is not involved either way.",
        },
        {
          label: "Reopening a node",
          value: "resumes THAT conversation by id, with its history — never a new one, and never a guess at which",
        },
        {
          label: "Default folder",
          value: folder || "not set — every new session note asks where to run",
          action: { id: "folder", label: folder ? "Change…" : "Choose…" },
        },
      ];
      if (folder) {
        lines.push({
          label: "",
          value: "go back to asking for each new session",
          action: { id: "forget", label: "Forget it" },
        });
      }
      return { status: folder ? basename(folder) || folder : "asks each time", ready: true, lines };
    }

    /*
     * The one page whose subject changes constantly underneath it — every note saved is a
     * file changed — so almost every line here is read off `gitState` rather than written.
     * The status pill answers "is there anything to do?", which for git is the only useful
     * reading of "is this working?": connected but three commits behind is not working.
     */
    case "git": {
      if (!bridge) return { status: "desktop app only", lines: [{ label: "Why", value: "there is no git in a browser tab — npm start" }] };
      const remote = setup.gitRemote;
      const repo = gitState;
      const root = knownVaultRoot();
      if (repo && !repo.installed) {
        return {
          status: "no git here",
          lines: [
            {
              label: "git",
              value:
                "not installed on this machine. On a Mac, xcode-select --install gets it; " +
                "everywhere else, git-scm.com. Nothing else on this page works until it is there.",
            },
          ],
        };
      }
      const lines: SetupLine[] = [];
      lines.push({
        label: "Vault folder",
        value: root || `not known yet — every git action here needs to know where "${vault.name}" is on disk`,
        action: { id: "folder", label: root ? "Change…" : "Choose…" },
      });
      if (root) {
        lines.push({
          label: "Repository",
          value: gitTrouble
            ? `${gitTrouble} — the folder above is where this vault is remembered as living, and ` +
              "nothing here can work until it points at the right one"
            : !repo
              ? "not read yet"
              : !repo.repo
                ? "none in that folder yet — the first commit initialises one"
                : `on ${repo.branch || "no branch yet"}, ` +
                  (repo.changes
                    ? `${repo.changes} file${repo.changes === 1 ? "" : "s"} changed since the last commit`
                    : "everything committed"),
        });
      }
      if (repo?.repo && repo.lastCommit) lines.push({ label: "Last commit", value: repo.lastCommit });
      if (repo?.repo && !repo.identity) {
        lines.push({
          label: "Who commits",
          value:
            "git has no name or email on this machine, and refuses to commit without one. " +
            'Run git config --global user.name "…" and user.email "…" once, in a terminal.',
        });
      }
      lines.push({
        label: "Commit",
        value: "stages everything in the vault's folder and commits it, initialising a repository the first time",
        action: { id: "commit", label: "Commit" },
      });
      lines.push({
        label: "Remote",
        value: remote || "none yet — set a GitHub URL to push to",
        action: { id: "remote", label: remote ? "Change" : "Set" },
      });
      lines.push({
        label: "Push",
        value: !remote
          ? "set a remote first; then this pushes your commits to it"
          : repo?.upstream && repo.behind
            ? `the remote is ${repo.behind} commit${repo.behind === 1 ? "" : "s"} ahead of this vault — ` +
              "pull those in first or this is refused"
            : "sends your commits to the remote, over the git already set up on this machine — no token lives in the vault",
        action: { id: "push", label: "Push" },
      });
      lines.push({
        label: "Pull",
        value: !remote
          ? "and this brings the remote's commits back down, once there is a remote"
          : "brings the remote's commits down and replays yours on top. Uncommitted work is " +
            "refused and a clash is abandoned, so this never leaves the vault half-changed.",
        action: { id: "pull", label: "Pull" },
      });
      // Signing in is git's own business and cannot be checked without attempting a push,
      // so the page says where that lives rather than pretending to know.
      lines.push({
        label: "Signing in",
        value:
          "whoever this machine's git already is — an ssh key or a credential helper. " +
          "Bedrock keeps no token, so a push that is refused is answered outside the app, once.",
      });
      const status = gitTrouble
        ? "folder is not there"
        : !repo
          ? root
            ? "not read yet"
            : "folder unknown"
          : !repo.repo
          ? "no repository yet"
          : !repo.identity
            ? "git has no identity"
            : repo.changes
              ? `${repo.changes} to commit`
              : !remote
                ? "local snapshots"
                : repo.upstream && repo.behind
                  ? `${repo.behind} behind`
                  : repo.ahead
                    ? `${repo.ahead} to push`
                    : repo.upstream
                      ? "pushed"
                      : "committed";
      // Green means the vault and the remote hold the same thing — which a repository that
      // has a remote but has never pushed to it does not, however tidy it looks locally.
      const ready = Boolean(
        repo?.repo && repo.identity && !repo.changes && remote && repo.upstream && !repo.ahead && !repo.behind,
      );
      return { status, ready, lines };
    }

    case "freeform": {
      if (!bridge) {
        return {
          status: "desktop app only",
          lines: [
            {
              label: "Why",
              value: "boards are opened and made through the Mac's own Shortcuts and URL scheme, which a browser tab cannot reach — npm start",
            },
          ],
        };
      }
      if (freeformState && !freeformState.app) {
        return {
          status: "no Freeform here",
          lines: [
            {
              label: "Freeform",
              value: "not on this Mac. It comes with macOS 13 and later, and nothing here can work without it.",
            },
          ],
        };
      }
      const has = freeformState?.shortcut ?? false;
      const lines: SetupLine[] = [
        {
          label: "What this is",
          value:
            "notes that point at Freeform boards. Bedrock keeps only the pointer — a board's id and name — and the boards stay Freeform's own, in iCloud. Nothing is hosted here.",
        },
        {
          label: "Shortcut",
          value: has
            ? `“${FREEFORM_SHORTCUT}” is in your Shortcuts library — making a board runs it`
            : "Apple's one door into making a board is the Shortcuts app, so Bedrock ships a signed shortcut. Installing opens it there — a single Add Shortcut click, which Apple keeps for you on purpose.",
          ...(has ? {} : { action: { id: "install", label: "Install…" } }),
        },
        {
          label: "Try it",
          value:
            freeformWord ||
            (has
              ? "makes a real board called “Bedrock connected” and opens it — proof the whole road works"
              : "install the shortcut first; then this makes a real board and opens it"),
          ...(has ? { action: { id: "test", label: "Try it" } } : {}),
        },
      ];
      const status = !freeformState
        ? "not read yet"
        : !has
          ? "shortcut needed"
          : settings.enabled("freeform")
            ? "ready"
            : "try it";
      return { status, ready: has, lines };
    }

    case "notion": {
      if (!bridge) {
        return {
          status: "desktop app only",
          lines: [
            {
              label: "Why",
              value: "the OAuth window and the keychain the token lives in are the shell's — npm start",
            },
          ],
        };
      }
      const linked = notionState?.linked ?? false;
      const workspace = notionState?.workspace ?? "";
      const lines: SetupLine[] = [
        {
          label: "What this is",
          value:
            "page notes — notes that point at Notion pages. Bedrock keeps only the pointer (the page's own link), and the pages stay in Notion. A click opens the page where it lives.",
        },
        {
          label: "Workspace",
          value: notionWord
            ? notionWord
            : linked
              ? `linked${workspace ? ` — ${workspace}` : ""}. Unlinking forgets the token; notes keep their page links.`
              : "not linked yet. Linking opens Notion in your browser to ask you — the token lands in the OS keychain, never the vault.",
          action: linked ? { id: "unlink", label: "Unlink" } : { id: "connect", label: "Link…" },
        },
        {
          label: "How it talks",
          value:
            "over Notion's own MCP server (mcp.notion.com) — the door Notion built for AI apps, with nothing installed here and no API key to paste.",
        },
      ];
      const status = !notionState ? "not read yet" : linked ? workspace || "linked" : "not linked";
      return { status, ready: linked, lines };
    }

    case "applenotes": {
      if (!bridge) {
        return {
          status: "desktop app only",
          lines: [
            {
              label: "Why",
              value: "notes are listed, made and opened through the Mac's own scripting door, which a browser tab cannot reach — npm start",
            },
          ],
        };
      }
      if (appleNotesState && !appleNotesState.app) {
        return {
          status: "no Notes here",
          lines: [
            {
              label: "Apple Notes",
              value: "not on this Mac, and nothing here can work without it.",
            },
          ],
        };
      }
      const on = settings.enabled("applenotes");
      const notesFolder = setup.notesFolder;
      const lines: SetupLine[] = [
        {
          label: "What this is",
          value:
            "notes that point at notes in Apple Notes. Bedrock keeps only the pointer — a note's id and name — and the notes stay Apple's own, in iCloud. Nothing is hosted here.",
        },
        {
          label: "Permission",
          value:
            "unlike Freeform there is nothing to install: Notes answers to scripting directly. The first real action makes macOS ask whether Bedrock may drive Notes — one Allow click, which the OS remembers (and keeps under System Settings → Privacy & Security → Automation).",
        },
        {
          label: "New notes land in",
          value: notesFolder || `“${NOTES_DEFAULT_FOLDER}” — its own folder in Notes, made when first needed`,
          action: { id: "folder", label: notesFolder ? "Change…" : "Choose…" },
        },
      ];
      if (notesFolder) {
        lines.push({
          label: "",
          value: `go back to the default, “${NOTES_DEFAULT_FOLDER}”`,
          action: { id: "reset", label: "Forget it" },
        });
      }
      lines.push({
        label: "Try it",
        value:
          appleNotesWord ||
          "makes a real note called “Bedrock connected” and opens it — proof the whole road works",
        action: { id: "test", label: "Try it" },
      });
      const status = !appleNotesState ? "not read yet" : on ? "ready" : "try it";
      return { status, ready: on, lines };
    }

    case "word": {
      if (!bridge) {
        return {
          status: "desktop app only",
          lines: [
            {
              label: "Why",
              value: "documents are made and opened through the Mac's own scripting door, which a browser tab cannot reach — npm start",
            },
          ],
        };
      }
      if (wordState && !wordState.app) {
        return {
          status: "no Word here",
          lines: [
            {
              label: "Word",
              value: "not on this Mac — it is Microsoft's app, not the system's, and nothing here can work without it.",
            },
          ],
        };
      }
      const on = settings.enabled("word");
      const folder = setup.wordFolder;
      const lines: SetupLine[] = [
        {
          label: "What this is",
          value:
            "document notes — notes that point at Word files on this disk. A click opens the document in Word; the note keeps only the pointer (the file's path), and the file is yours like any other.",
        },
        {
          label: "New documents land in",
          value: folder || `${WORD_DEFAULT_FOLDER} — made when it is first needed`,
          action: { id: "folder", label: folder ? "Change…" : "Choose…" },
        },
      ];
      if (folder) {
        lines.push({
          label: "",
          value: `go back to the default, ${WORD_DEFAULT_FOLDER}`,
          action: { id: "reset", label: "Forget it" },
        });
      }
      lines.push({
        label: "Try it",
        value:
          wordWord ||
          "makes a real document called “Bedrock connected”, saves it there and opens it in Word — the first run is when macOS asks its Allow question",
        action: { id: "test", label: "Try it" },
      });
      const status = !wordState ? "not read yet" : on ? "ready" : "try it";
      return { status, ready: on, lines };
    }

    default:
      return null;
  }
}

/** A button on one of those pages. */
function runIntegrationAction(feature: Feature, action: string): void {
  if (feature === "linear" && action === "connect") void setUpLinear();
  else if (feature === "linear" && action === "team") void pickLinearTeam();
  else if (feature === "linear" && action === "project") void pickLinearProject();
  else if (feature === "claude" && action === "folder") void setUpClaudeFolder();
  else if (feature === "claude" && action === "forget") forgetClaudeFolder();
  else if (feature === "claude" && action.startsWith("run-")) setClaudeWindow(action.slice(4));
  else if (feature === "antigravity" && action === "folder") void setUpAntigravityFolder();
  else if (feature === "antigravity" && action === "forget") forgetAntigravityFolder();
  else if (feature === "freeform" && action === "install") void installFreeformShortcut();
  else if (feature === "freeform" && action === "test") void testFreeform();
  else if (feature === "slack" && action === "connect") void setUpSlack();
  else if (feature === "slack" && action === "channel") void pickSlackChannel();
  else if (feature === "notion" && action === "connect") void connectNotion();
  else if (feature === "notion" && action === "unlink") void unlinkNotion();
  else if (feature === "applenotes" && action === "test") void testAppleNotes();
  else if (feature === "applenotes" && action === "folder") void setUpNotesFolder();
  else if (feature === "applenotes" && action === "reset") forgetNotesFolder();
  else if (feature === "word" && action === "folder") void setUpWordFolder();
  else if (feature === "word" && action === "reset") forgetWordFolder();
  else if (feature === "word" && action === "test") void testWord();
  else if (feature === "git" && action === "folder") void setVaultRoot();
  else if (feature === "git" && action === "commit") void commitVault();
  else if (feature === "git" && action === "remote") void setGitRemote();
  else if (feature === "git" && action === "push") void pushVault();
  else if (feature === "git" && action === "pull") void pullVault();
}

/* ------------------------------------------------- antigravity's own page --- */

/**
 * Where `agy` is, and whether it has ever run here. Read from the shell rather than
 * remembered: it can be installed while the app is running, and "installed" is the only
 * prerequisite this integration has — there is no sign-in for Bedrock to track, because
 * the CLI's login is the CLI's and is asked for in the terminal.
 */
let agyCli: string | null = null;
let agyRan = false;

async function refreshAntigravity(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  const status = await bridge.agyStatus().catch(() => null);
  agyCli = status?.cli ?? null;
  agyRan = status?.ran ?? false;
  redrawSettings();
}

/**
 * Where a new Antigravity session runs — asked, and then remembered per vault, exactly as
 * the Claude folder is. The two are asked separately because they are usually different
 * answers: the folder a vault's coding sessions run in is rarely the folder its agent
 * sessions are wanted in.
 */
async function askAntigravityFolder(first?: string | null): Promise<string | null> {
  const root = knownVaultRoot();
  const choices = [...new Set([...(first ? [first] : []), ...(root ? [root] : [])])];
  const question = "Which folder should this session run in?";
  if (!choices.length) return askText(question, first ?? "~/", "Use this");
  return askChoice(question, choices, "Another folder…", question, first ?? undefined);
}

async function setUpAntigravityFolder(): Promise<void> {
  if (!window.bedrock) {
    ui.status.textContent = "Antigravity sessions need the desktop app — npm start";
    return;
  }
  const chosen = await askAntigravityFolder(settings.antigravityFolder());
  if (!chosen) return;
  settings.setSetup({ antigravityFolder: chosen });
  ui.status.textContent = `Antigravity: new sessions run in ${chosen}`;
  redrawSettings();
}

function forgetAntigravityFolder(): void {
  settings.setSetup({ antigravityFolder: "" });
  ui.status.textContent = "Antigravity: new sessions will ask where to run";
  redrawSettings();
}

/* ------------------------------------------------------ claude's own page --- */

/**
 * The vault's default folder for new Claude sessions. Asked here once instead of at every
 * new session note: a vault is usually about one codebase, and answering the same question
 * every time is what made the session note feel like a form.
 */
async function setUpClaudeFolder(): Promise<void> {
  if (!window.bedrock) {
    ui.status.textContent = "Claude sessions need the desktop app — npm start";
    return;
  }
  const chosen = await askClaudeFolder(settings.claudeFolder());
  if (!chosen) return;
  settings.setSetup({ claudeFolder: chosen });
  ui.status.textContent = `Claude: new sessions run in ${chosen}`;
  redrawSettings();
}

function forgetClaudeFolder(): void {
  settings.setSetup({ claudeFolder: "" });
  ui.status.textContent = "Claude: new sessions will ask where to run";
  redrawSettings();
}

/**
 * Where the `claude` CLI is, or null — the whole terminal mode hangs off this, the way
 * Antigravity's hangs off `agy`. Read from the shell rather than remembered, because it
 * can be installed while the app is running.
 */
let claudeCli: string | null = null;

/**
 * And who the CLI would run as. Read alongside it because it is the same kind of fact —
 * something true of this machine that the mode depends on and nothing else would tell you.
 */
let claudeAccount: { email: string; org: string; seat: string } | null = null;

async function refreshClaudeCli(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  const [status, account] = await Promise.all([
    bridge.claudeCliStatus().catch(() => null),
    bridge.claudeAccount().catch(() => null),
  ]);
  claudeCli = status?.cli ?? null;
  claudeAccount = account;
  redrawSettings();
}

function setClaudeWindow(where: string): void {
  const terminal = where === "terminal";
  settings.setSetup({ claudeWindow: terminal ? "terminal" : "app" });
  redrawSettings();
  if (terminal) void refreshClaudeCli(); // choosing it is when its prerequisite starts mattering
}

/**
 * Whether a terminal session may be opened. Asked of the shell each time, so installing the
 * CLI takes effect without a restart — and refused rather than half-done, because a session
 * note whose terminal cannot open is worse than no note at all.
 */
async function terminalReady(): Promise<boolean> {
  const bridge = window.bedrock;
  if (!bridge) return false;
  const status = await bridge.claudeCliStatus().catch(() => null);
  claudeCli = status?.cli ?? null;
  if (!claudeCli) {
    ui.status.textContent =
      "Claude: terminal sessions need the claude CLI — claude.com/product/claude-code";
    redrawSettings();
  }
  return !!claudeCli;
}

/* ---------------------------------------------------- freeform's own page --- */

/** The shortcut's name everywhere: the shipped file, the library, `shortcuts run`. */
const FREEFORM_SHORTCUT = "New Freeform Board (Bedrock)";

/**
 * Whether Freeform is on this Mac and whether the shortcut is in the library — the two
 * facts the page reports. Read from the shell rather than remembered, because the
 * shortcut is added in another app entirely, while this one is running.
 */
let freeformState: { app: boolean; shortcut: boolean } | null = null;

/** The last try's outcome, worded for the page. Empty until somebody presses the button. */
let freeformWord = "";

async function refreshFreeform(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  freeformState = await bridge.freeformStatus().catch(() => null);
  redrawSettings();
}

/**
 * Opens Shortcuts' import dialog, then watches for the add — the one click that has to
 * happen in another app, which this page should notice by itself rather than grow a
 * refresh button for.
 */
async function installFreeformShortcut(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  try {
    await bridge.freeformInstall();
  } catch (err) {
    ui.status.textContent = `Freeform: ${(err as Error).message}`;
    return;
  }
  ui.status.textContent = "Freeform: Shortcuts opened — click Add Shortcut there; this page will notice";
  for (let tries = 0; tries < 40; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const status = await bridge.freeformStatus().catch(() => null);
    if (!status) return;
    if (status.shortcut) {
      freeformState = status;
      ui.status.textContent = "Freeform: shortcut installed — try it";
      redrawSettings();
      return;
    }
  }
}

/**
 * The activation: make a real board, watch it appear, open it. Passing is the proof the
 * whole road works — shortcut, Freeform, index, URL scheme — so passing is also what
 * switches the integration on.
 */
async function testFreeform(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  freeformWord = "creating a board…";
  redrawSettings();
  try {
    const board = await bridge.freeformCreate("Bedrock connected");
    if (!board) throw new Error("the shortcut ran, but no new board showed up in Freeform's index");
    settings.set("freeform", true);
    freeformWord = `made “${board.title}” just now — it should be open on your screen`;
    ui.status.textContent = "Freeform: connected";
    void bridge.freeformOpen(board.id);
  } catch (err) {
    freeformWord = (err as Error).message;
    ui.status.textContent = `Freeform: ${freeformWord}`;
  }
  redrawSettings();
}

/* ------------------------------------------------------ notion's own page --- */

/** Whether a workspace is linked and what it is called; null until the shell says. */
let notionState: { linked: boolean; workspace: string } | null = null;

/** The last link attempt's outcome, worded for the page. */
let notionWord = "";

async function refreshNotion(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  notionState = await bridge.notionStatus().catch(() => null);
  redrawSettings();
}

/**
 * The OAuth round trip: a browser tab asks, the shell catches the answer. Coming back
 * linked is the proof the whole road works, so coming back linked is also what switches
 * the integration on.
 */
async function connectNotion(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  notionWord = "waiting on the browser — allow Bedrock there…";
  ui.status.textContent = "Notion: finish linking in the browser tab that opened";
  redrawSettings();
  try {
    const { workspace } = await bridge.notionConnect();
    settings.set("notion", true);
    notionWord = "";
    ui.status.textContent = `Notion: linked${workspace ? ` to ${workspace}` : ""}`;
  } catch (err) {
    notionWord = (err as Error).message;
    ui.status.textContent = `Notion: ${notionWord}`;
  }
  await refreshNotion();
}

async function unlinkNotion(): Promise<void> {
  if (!(await askConfirm("Unlink the Notion workspace? Notes keep their page links.", "Unlink"))) return;
  await window.bedrock?.notionForget().catch(() => false);
  notionWord = "";
  ui.status.textContent = "Notion: unlinked — the token is forgotten";
  await refreshNotion();
}

/**
 * Whether a Notion action may go ahead, asked of the shell rather than of a flag, so
 * the answer is never one unlink out of date.
 */
async function notionReady(): Promise<boolean> {
  const bridge = window.bedrock;
  if (!bridge) {
    ui.status.textContent = "Notion pages need the desktop app — npm start";
    return false;
  }
  const status = await bridge.notionStatus().catch(() => null);
  notionState = status;
  if (!status?.linked) {
    ui.status.textContent = "Notion: link the workspace first — Settings → Integrations → Notion";
    redrawSettings();
    return false;
  }
  return true;
}

/* ------------------------------------------------- apple notes' own page --- */

/** How the settings page names the default Notes folder — the shell owns the real one. */
const NOTES_DEFAULT_FOLDER = "Bedrock";

/** Whether Apple Notes is on this Mac; null until the shell says. Whether Bedrock may
    drive it is macOS's secret until the first action asks, so it is not in here. */
let appleNotesState: { app: boolean } | null = null;

/**
 * Which Notes folder new notes land in — asked over the folders Notes already has,
 * with typing a fresh name always open (it is made on first use).
 */
async function setUpNotesFolder(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  let folders: string[] = [];
  try {
    folders = await bridge.notesFolders();
  } catch (err) {
    ui.status.textContent = `Apple Notes: ${(err as Error).message}`;
    return;
  }
  const chosen = await askChoice(
    "Which Notes folder should new notes land in?",
    folders,
    "A new folder…",
    "Name the folder — it is made when first needed",
    settings.setup().notesFolder || NOTES_DEFAULT_FOLDER,
  );
  if (!chosen) return;
  settings.setSetup({ notesFolder: chosen });
  ui.status.textContent = `Apple Notes: new notes land in “${chosen}”`;
  redrawSettings();
}

function forgetNotesFolder(): void {
  settings.setSetup({ notesFolder: "" });
  ui.status.textContent = `Apple Notes: new notes land in “${NOTES_DEFAULT_FOLDER}”`;
  redrawSettings();
}

/** The last try's outcome, worded for the page. */
let appleNotesWord = "";

async function refreshAppleNotes(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  appleNotesState = await bridge.notesStatus().catch(() => null);
  redrawSettings();
}

/**
 * The activation: make a real note, open it. The first run is also when macOS asks its
 * Automation question, so passing proves the app, the permission and the road at once —
 * and passing is what switches the integration on.
 */
async function testAppleNotes(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  appleNotesWord = "creating a note — macOS may ask you to allow this…";
  redrawSettings();
  try {
    const note = await bridge.notesCreate(settings.setup().notesFolder, "Bedrock connected");
    settings.set("applenotes", true);
    appleNotesWord = `made “${note.title}” just now — it should be open on your screen`;
    ui.status.textContent = "Apple Notes: connected";
    void bridge.notesOpen(note.id);
  } catch (err) {
    appleNotesWord = (err as Error).message;
    ui.status.textContent = `Apple Notes: ${appleNotesWord}`;
  }
  redrawSettings();
}

/** Whether an Apple Notes action may go ahead — the app on this Mac, and a shell to ask. */
async function appleNotesReady(): Promise<boolean> {
  const bridge = window.bedrock;
  if (!bridge) {
    ui.status.textContent = "Apple notes need the desktop app — npm start";
    return false;
  }
  const status = await bridge.notesStatus().catch(() => null);
  appleNotesState = status;
  if (!status?.app) {
    ui.status.textContent = "Apple Notes is not on this Mac";
    redrawSettings();
    return false;
  }
  return true;
}

/* -------------------------------------------------------- word's own page --- */

/** How the settings page names the default save folder. The shell owns the real path
    (under the home folder); this is that path as a person would say it. */
const WORD_DEFAULT_FOLDER = "Documents/word-bedrock";

/** Whether Word is on this Mac; null until the shell says. */
let wordState: { app: boolean } | null = null;

/** The last try's outcome, worded for the page. */
let wordWord = "";

async function refreshWord(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  wordState = await bridge.wordStatus().catch(() => null);
  redrawSettings();
}

/** Where new documents land — asked with the OS's own folder picker, like git's root. */
async function setUpWordFolder(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  const chosen = await bridge.pickPath("folder").catch(() => null);
  if (!chosen) return;
  settings.setSetup({ wordFolder: chosen });
  ui.status.textContent = `Word: new documents land in ${chosen}`;
  redrawSettings();
}

function forgetWordFolder(): void {
  settings.setSetup({ wordFolder: "" });
  ui.status.textContent = `Word: new documents land in ${WORD_DEFAULT_FOLDER}`;
  redrawSettings();
}

/**
 * The activation: make a real document, open it. The first run is when macOS asks its
 * Automation question (and Word may ask its own about the folder), so passing proves
 * the app, the permission and the save folder at once — and switches the integration on.
 */
async function testWord(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  wordWord = "creating a document — macOS may ask you to allow this…";
  redrawSettings();
  try {
    const doc = await bridge.wordCreate(settings.setup().wordFolder, "Bedrock connected");
    settings.set("word", true);
    wordWord = `made “${doc.title}” just now — it should be open in Word`;
    ui.status.textContent = "Word: connected";
  } catch (err) {
    wordWord = (err as Error).message;
    ui.status.textContent = `Word: ${wordWord}`;
  }
  redrawSettings();
}

/** Whether a Word action may go ahead — the app on this Mac, and a shell to ask. */
async function wordReady(): Promise<boolean> {
  const bridge = window.bedrock;
  if (!bridge) {
    ui.status.textContent = "Word documents need the desktop app — npm start";
    return false;
  }
  const status = await bridge.wordStatus().catch(() => null);
  wordState = status;
  if (!status?.app) {
    ui.status.textContent = "Microsoft Word is not on this Mac";
    redrawSettings();
    return false;
  }
  return true;
}

/* ------------------------------------------------------ linear's own page --- */

/**
 * Which team new issues are filed under. Fetched live rather than remembered: a team you
 * have been added to since is a team you should be able to pick, and the list is one
 * cheap query. The names are kept beside the ids so the page can say where issues go
 * without a round trip every time it is drawn.
 */
async function pickLinearTeam(): Promise<void> {
  if (!linearUser) return;
  ui.status.textContent = "Linear: reading your teams…";
  const teams = await fetchTeams(linearCall);
  if (!teams.length) {
    ui.status.textContent = "Linear: that key can see no teams";
    return;
  }
  const label = (team: Team): string => `${team.key} — ${team.name}`;
  const picked = await askChoice("Which team should new issues go to?", teams.map(label), "Cancel");
  const team = teams.find((t) => label(t) === picked);
  if (!team) return;
  // A different team means the old project is somebody else's; it does not travel.
  settings.setSetup({
    linearTeam: team.id,
    linearTeamName: label(team),
    ...(team.id === settings.setup().linearTeam ? {} : { linearProject: "", linearProjectName: "" }),
  });
  await adoptLinearKey(); // the source caches team and states — it needs rebuilding
  ui.status.textContent = `Linear: new issues go to ${label(team)}`;
  redrawSettings();
}

/** And which project inside it, if any. "No project" is a real answer, so it is offered. */
async function pickLinearProject(): Promise<void> {
  const setup = settings.setup();
  if (!linearUser) return;
  if (!setup.linearTeam) {
    ui.status.textContent = "Linear: choose a team first — projects live inside one";
    return;
  }
  ui.status.textContent = "Linear: reading that team's projects…";
  const projects = await fetchProjects(linearCall, setup.linearTeam);
  const NONE = "No project — file straight to the team";
  const picked = await askChoice(
    "Which project should new issues belong to?",
    [NONE, ...projects.map((p) => p.name)],
    "Cancel",
  );
  if (picked === null) return;
  const project = projects.find((p) => p.name === picked);
  if (!project && picked !== NONE) return;
  settings.setSetup({
    linearProject: project?.id ?? "",
    linearProjectName: project?.name ?? "",
  });
  await adoptLinearKey();
  ui.status.textContent = project
    ? `Linear: new issues belong to ${project.name}`
    : "Linear: new issues go straight to the team";
  redrawSettings();
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
    const next = setStyle(text, style);
    if (next !== text) {
      if (!(await tryVault(`could not style ${noteName(path)}`, () => vault.write(path, next)))) return;
      // Open in a pane: the fields appear in the editor too, caret and undo history intact.
      for (let i = 0; i < panes.length; i++) if (pathOf(panes[i]) === path) editors[i].sync(next);
    }
    graphStale = true;
  });
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
  const path = freshPath(dir, fsBasename(target));
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
    // The note itself is not renamed here: its name came off the disk, which is the whole
    // point of it. The connection is unnamed, as every drawn link is — a click names it.
    void finishLink(source, path, null);
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

/**
 * No leading or trailing space or dot. A file whose name ends in a space cannot be linked to at
 * all: every `[[link]]` is read trimmed, so the name written into the note never finds the file
 * again — and because it never resolves, the app cannot tell it is already there and writes it
 * a second time on the next attempt. Trailing dots go for the same reason, plus Windows will
 * not keep one; a leading dot would make the note a hidden file.
 */
const tidyName = (name: string): string => name.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");

/**
 * A page title is somebody else's text: it has to survive being used as a file name. A post is
 * the awkward case — it has no title, so the whole first paragraph arrives as one — which is
 * why the cut comes before the tidy, and at a word boundary where there is one to take.
 */
const asFileName = (title: string): string => {
  const clean = title.replace(/[\\/:*?"<>|[\]#^]+/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= 60) return tidyName(clean);
  const cut = clean.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return tidyName(space > 30 ? cut.slice(0, space) : cut);
};

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
  const path = freshPath(dir, webHost(url));
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
  // The site is asked BEFORE the link is written, because its answer can rename the
  // note — and a link written against the name it had a moment ago points at nothing.
  // Same order as naming a new note by hand: the note settles, then the line does.
  const settled = await adoptWebPage(path, url, noteName(path));
  if (source) await finishLink(source, settled, null);
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
  // A second bookmark on the same page is "Hacker News 2", not the host it started as. The
  // title is the site's choice, not anybody here's, so it steps around a waited-for name too.
  const free = freshPath(dirname(path), wanted, path);
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

/* -------------------------------------------------------- freeform boards --- */

/**
 * A board note is a pointer in the webpage note's mould: the board's uuid, and nothing
 * said on its behalf. The uuid is what `freeform://board?id=` opens; the board itself —
 * every sticky and stroke on it — stays Freeform's own, in iCloud. A note without a
 * `board::` line is a board that has not been made yet, which a click makes.
 */
const freeformTemplate = (board: string): string =>
  board ? `type:: freeform\n\nboard:: ${board}\n` : `type:: freeform\n`;

/**
 * Whether a board action may go ahead: the app on this Mac, the shortcut in the library.
 * Asked of the shell each time rather than of a flag, so installing the shortcut takes
 * effect without a restart — and refused with directions rather than half-done.
 */
async function freeformReady(): Promise<boolean> {
  const bridge = window.bedrock;
  if (!bridge) {
    ui.status.textContent = "Freeform boards need the desktop app — npm start";
    return false;
  }
  const status = await bridge.freeformStatus().catch(() => null);
  freeformState = status;
  if (!status?.app || !status.shortcut) {
    ui.status.textContent = !status?.app
      ? "Freeform is not on this Mac — it comes with macOS 13 and later"
      : "Freeform: install the shortcut first — Settings → Integrations → Freeform";
    redrawSettings();
    return false;
  }
  return true;
}

/**
 * Makes the board a note stands for — named what the note is named — writes the uuid
 * home into the note, and opens the board on screen.
 */
async function makeFreeformBoard(path: string): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  ui.status.textContent = `Freeform: creating “${noteName(path)}”…`;
  let board: FreeformBoard | null = null;
  try {
    board = await bridge.freeformCreate(noteName(path));
  } catch (err) {
    ui.status.textContent = `Freeform: ${(err as Error).message}`;
    return;
  }
  if (!board) {
    ui.status.textContent = "Freeform: the shortcut ran, but no new board showed up";
    return;
  }
  await flushAll(); // the note may be open and mid-edit; the write must not clobber
  await vault.write(path, setField(await vault.read(path), "board", board.id));
  graphView.setFreeformBoard(path, board.id);
  graphStale = true;
  for (let i = 0; i < panes.length; i++) if (pathOf(panes[i]) === path) await renderPage(i);
  void bridge.freeformOpen(board.id);
  ui.status.textContent = `${noteName(path)} → its own board, open in Freeform`;
}

/**
 * Click on a board node: open the board in Freeform. A note whose board was never made
 * (the shortcut failed, or the line was stripped by hand) gets one made from its own
 * name instead — the node heals itself rather than just complaining.
 */
async function openFreeformNode(path: string, board: string | null): Promise<void> {
  // One tick later, for the same reason `openFsNode` waits: the click's own free
  // handler clears the hint right after this, and the message has to outlive that.
  const say = (message: string): void => {
    window.setTimeout(() => {
      ui.status.textContent = message;
    }, 0);
  };
  const bridge = window.bedrock;
  if (!bridge) {
    say("Freeform boards need the desktop app — npm start");
    return;
  }
  if (board) {
    const opened = await bridge.freeformOpen(board);
    say(opened ? `${noteName(path)} → Freeform` : `the note's board:: line is not a board id`);
    return;
  }
  if (!(await freeformReady())) return;
  await makeFreeformBoard(path);
}

/**
 * "New Freeform board" — from the canvas menu, or from a link draft released on empty
 * space (`source` is then the note the arrow came from). The note comes first and gets
 * its name, and committing the name is what makes the board: it is born called what the
 * note is called, opens on screen, and its uuid is written home.
 */
async function createFreeformAt(
  at: { x: number; y: number },
  folder: string | null,
  source: string | null = null,
): Promise<void> {
  if (!(await freeformReady())) return;
  const dir = folder ?? "";
  const path = uniquePath(filePaths(), dir, "Freeform board", ".md");
  await vault.createFile(path, freeformTemplate(""));
  entries = [...entries, { path, kind: "file" }]; // so the rename's collision check sees it
  if (source) {
    graphView.commitLink(source, path, {
      label: noteName(path),
      parent: dir || undefined,
      at,
      type: "freeform",
    });
  } else {
    graphView.commitNode(path, noteName(path), dir || undefined, at, "freeform");
  }
  graphStale = true;
  await refreshSidebar();
  ui.status.textContent = `created ${path} — name it, and the board is made to match`;
  graphView.renameNode(path, (name) => {
    void (async () => {
      const finalPath = name ? ((await applyRename(path, "file", name)) ?? path) : path;
      if (!source) {
        await makeFreeformBoard(finalPath);
        return;
      }
      // Linked board: the link is written home first, unnamed — a click on the line
      // names it — and then the board is made.
      await finishLink(source, finalPath, null);
      await makeFreeformBoard(finalPath);
    })();
  });
}


/* ---------------------------------------------------------------- notion --- */

/**
 * A page note is a pointer in the board note's mould: the page's own address, and
 * nothing said on its behalf. The page itself — every block on it — stays Notion's own.
 * A note without a `page::` line is a page that has not been made yet; a click makes it.
 */
const notionTemplate = (url: string): string =>
  url ? `type:: notion\n\npage:: ${url}\n` : `type:: notion\n`;

/**
 * Makes the page a note stands for — named what the note is named, private, at the
 * workspace root — writes its address home into the note, and opens it.
 */
async function makeNotionPage(path: string): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  ui.status.textContent = `Notion: creating “${noteName(path)}”…`;
  let page: NotionPage;
  try {
    page = await bridge.notionCreate(noteName(path));
  } catch (err) {
    ui.status.textContent = `Notion: ${(err as Error).message}`;
    return;
  }
  await flushAll(); // the note may be open and mid-edit; the write must not clobber
  await vault.write(path, setField(await vault.read(path), "page", page.url));
  graphView.setNotionPage(path, page.url);
  graphStale = true;
  for (let i = 0; i < panes.length; i++) if (pathOf(panes[i]) === path) await renderPage(i);
  void bridge.notionOpen(page.url);
  ui.status.textContent = `${noteName(path)} → its own page, open in Notion`;
}

/**
 * Click on a page node: open the page. A note whose page was never made (the call
 * failed, or the line was stripped by hand) gets one made from its own name instead —
 * the node heals itself rather than just complaining.
 */
async function openNotionNode(path: string, url: string | null): Promise<void> {
  // One tick later, for the same reason `openFsNode` waits: the click's own free
  // handler clears the hint right after this, and the message has to outlive that.
  const say = (message: string): void => {
    window.setTimeout(() => {
      ui.status.textContent = message;
    }, 0);
  };
  const bridge = window.bedrock;
  if (!bridge) {
    say("Notion pages need the desktop app — npm start");
    return;
  }
  if (url) {
    const opened = await bridge.notionOpen(url);
    say(opened ? `${noteName(path)} → Notion` : `the note's page:: line is not a Notion address`);
    return;
  }
  if (!(await notionReady())) return;
  await makeNotionPage(path);
}

/**
 * "New Notion page" — from the canvas menu, or from a link draft released on empty
 * space. The note comes first and gets its name, and committing the name is what makes
 * the page: it is born called what the note is called, and its address is written home.
 */
async function createNotionAt(
  at: { x: number; y: number },
  folder: string | null,
  source: string | null = null,
): Promise<void> {
  if (!(await notionReady())) return;
  const dir = folder ?? "";
  const path = uniquePath(filePaths(), dir, "Notion page", ".md");
  await vault.createFile(path, notionTemplate(""));
  entries = [...entries, { path, kind: "file" }]; // so the rename's collision check sees it
  if (source) {
    graphView.commitLink(source, path, {
      label: noteName(path),
      parent: dir || undefined,
      at,
      type: "notion",
    });
  } else {
    graphView.commitNode(path, noteName(path), dir || undefined, at, "notion");
  }
  graphStale = true;
  await refreshSidebar();
  ui.status.textContent = `created ${path} — name it, and the page is made to match`;
  graphView.renameNode(path, (name) => {
    void (async () => {
      const finalPath = name ? ((await applyRename(path, "file", name)) ?? path) : path;
      if (!source) {
        await makeNotionPage(finalPath);
        return;
      }
      // Linked page: the link is written home first, unnamed — a click on the line
      // names it — and then the page is made.
      await finishLink(source, finalPath, null);
      await makeNotionPage(finalPath);
    })();
  });
}


/**
 * "Search Notion…" — the row under the recent pages. A workspace is bigger than any menu,
 * so the one attachable whose list can never be complete keeps a way to ask for the rest.
 */
async function searchNotionAt(
  at: { x: number; y: number },
  folder: string | null,
  source: string | null = null,
): Promise<void> {
  if (!(await notionReady())) return;
  const bridge = window.bedrock;
  if (!bridge) return;
  const query = await askText("Search Notion — empty lists what is recent", "", "Search");
  if (query === null) return;
  ui.status.textContent = "Notion: searching…";
  let pages: NotionPage[];
  try {
    pages = await bridge.notionSearch(query);
  } catch (err) {
    ui.status.textContent = `Notion: ${(err as Error).message}`;
    return;
  }
  if (!pages.length) {
    ui.status.textContent = "Notion: nothing found to link";
    return;
  }
  // Titles repeat over there, so the doubles are numbered rather than guessed between —
  // a modal picks by label, unlike the menu, where each row carries its own answer.
  const byLabel = new Map<string, NotionPage>();
  for (const page of pages) {
    const title = page.title || "Untitled";
    let label = title;
    for (let n = 2; byLabel.has(label); n++) label = `${title} (${n})`;
    byLabel.set(label, page);
  }
  const picked = await askChoice("Which page should the note point at?", [...byLabel.keys()], "Cancel");
  if (picked === null) return;
  const page = byLabel.get(picked);
  if (!page) return;
  await attachNodeAt(
    {
      kind: "notion",
      title: page.title,
      text: notionTemplate(page.url),
      handle: page.url,
      done: `${page.title || "Untitled"} → its page in Notion`,
    },
    at,
    folder,
    source,
  );
}

/* ----------------------------------------------------------- apple notes --- */

/**
 * The same pointer again: the id Apple minted, and nothing said on the note's behalf.
 * The field is `note::` — a note here pointing at a note there, which is exactly what
 * it is. Empty means "not made yet", which a click makes.
 */
const appleNoteTemplate = (id: string): string =>
  id ? `type:: applenote\n\nnote:: ${id}\n` : `type:: applenote\n`;

/**
 * Makes the Apple note a note here stands for — titled what the note is named — writes
 * the id home, and opens it in Notes. The first run ever is when macOS asks its
 * Automation question, so a refusal is worded as directions, not a code.
 */
async function makeAppleNote(path: string): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  ui.status.textContent = `Apple Notes: creating “${noteName(path)}”…`;
  let note: AppleNote;
  try {
    note = await bridge.notesCreate(settings.setup().notesFolder, noteName(path));
  } catch (err) {
    ui.status.textContent = `Apple Notes: ${(err as Error).message}`;
    return;
  }
  await flushAll(); // the note may be open and mid-edit; the write must not clobber
  await vault.write(path, setField(await vault.read(path), "note", note.id));
  graphView.setAppleNote(path, note.id);
  graphStale = true;
  for (let i = 0; i < panes.length; i++) if (pathOf(panes[i]) === path) await renderPage(i);
  void bridge.notesOpen(note.id).catch(() => false);
  ui.status.textContent = `${noteName(path)} → its own note, open in Apple Notes`;
}

/** Click on an Apple note node: open the note in Notes, or make the one never made. */
async function openAppleNoteNode(path: string, note: string | null): Promise<void> {
  const say = (message: string): void => {
    window.setTimeout(() => {
      ui.status.textContent = message;
    }, 0);
  };
  const bridge = window.bedrock;
  if (!bridge) {
    say("Apple notes need the desktop app — npm start");
    return;
  }
  if (note) {
    try {
      const opened = await bridge.notesOpen(note);
      say(opened ? `${noteName(path)} → Apple Notes` : `the note's note:: line is not an Apple note id`);
    } catch (err) {
      say(`Apple Notes: ${(err as Error).message}`);
    }
    return;
  }
  if (!(await appleNotesReady())) return;
  await makeAppleNote(path);
}

/** "New Apple note" — the note here first, its name committed, the note there to match. */
async function createAppleNoteAt(
  at: { x: number; y: number },
  folder: string | null,
  source: string | null = null,
): Promise<void> {
  if (!(await appleNotesReady())) return;
  const dir = folder ?? "";
  const path = uniquePath(filePaths(), dir, "Apple note", ".md");
  await vault.createFile(path, appleNoteTemplate(""));
  entries = [...entries, { path, kind: "file" }]; // so the rename's collision check sees it
  if (source) {
    graphView.commitLink(source, path, {
      label: noteName(path),
      parent: dir || undefined,
      at,
      type: "applenote",
    });
  } else {
    graphView.commitNode(path, noteName(path), dir || undefined, at, "applenote");
  }
  graphStale = true;
  await refreshSidebar();
  ui.status.textContent = `created ${path} — name it, and the note is made to match`;
  graphView.renameNode(path, (name) => {
    void (async () => {
      const finalPath = name ? ((await applyRename(path, "file", name)) ?? path) : path;
      if (!source) {
        await makeAppleNote(finalPath);
        return;
      }
      // Linked note: the link is written home first, unnamed — a click on the line
      // names it — and then the note is made.
      await finishLink(source, finalPath, null);
      await makeAppleNote(finalPath);
    })();
  });
}


/* ------------------------------------------------------------------ word --- */

/**
 * A document note points at a file, so the pointer is a path — the one pointer here
 * that names something of the user's own rather than something inside an app. Empty
 * means "not made yet", which a click makes.
 */
const wordTemplate = (doc: string): string =>
  doc ? `type:: word\n\ndoc:: ${doc}\n` : `type:: word\n`;

/**
 * Makes the document a note stands for — named what the note is named, saved where the
 * vault said (or the default) — writes the path home, and Word opens it as it saves.
 */
async function makeWordDoc(path: string): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  ui.status.textContent = `Word: creating “${noteName(path)}”…`;
  let doc: WordDoc;
  try {
    doc = await bridge.wordCreate(settings.setup().wordFolder, noteName(path));
  } catch (err) {
    ui.status.textContent = `Word: ${(err as Error).message}`;
    return;
  }
  await flushAll(); // the note may be open and mid-edit; the write must not clobber
  await vault.write(path, setField(await vault.read(path), "doc", doc.path));
  graphView.setWordDoc(path, doc.path);
  graphStale = true;
  for (let i = 0; i < panes.length; i++) if (pathOf(panes[i]) === path) await renderPage(i);
  ui.status.textContent = `${noteName(path)} → its own document, open in Word`;
}

/** Click on a Word node: open the document in Word, or make the one never made. A
    pointer at a file that has since moved says so instead of opening nothing. */
async function openWordNode(path: string, doc: string | null): Promise<void> {
  const say = (message: string): void => {
    window.setTimeout(() => {
      ui.status.textContent = message;
    }, 0);
  };
  const bridge = window.bedrock;
  if (!bridge) {
    say("Word documents need the desktop app — npm start");
    return;
  }
  if (doc) {
    try {
      const answer = await bridge.wordOpen(doc);
      say(
        answer === "opened"
          ? `${noteName(path)} → Word`
          : `the document is not at ${doc} any more — it moved, or was deleted`,
      );
    } catch (err) {
      say(`Word: ${(err as Error).message}`);
    }
    return;
  }
  if (!(await wordReady())) return;
  await makeWordDoc(path);
}

/** "New Word document" — the note first, its name committed, the .docx made to match. */
async function createWordAt(
  at: { x: number; y: number },
  folder: string | null,
  source: string | null = null,
): Promise<void> {
  if (!(await wordReady())) return;
  const dir = folder ?? "";
  const path = uniquePath(filePaths(), dir, "Word document", ".md");
  await vault.createFile(path, wordTemplate(""));
  entries = [...entries, { path, kind: "file" }]; // so the rename's collision check sees it
  if (source) {
    graphView.commitLink(source, path, {
      label: noteName(path),
      parent: dir || undefined,
      at,
      type: "word",
    });
  } else {
    graphView.commitNode(path, noteName(path), dir || undefined, at, "word");
  }
  graphStale = true;
  await refreshSidebar();
  ui.status.textContent = `created ${path} — name it, and the document is made to match`;
  graphView.renameNode(path, (name) => {
    void (async () => {
      const finalPath = name ? ((await applyRename(path, "file", name)) ?? path) : path;
      if (!source) {
        await makeWordDoc(finalPath);
        return;
      }
      // Linked document: the link is written home first, unnamed — a click on the line
      // names it — and then the document is made.
      await finishLink(source, finalPath, null);
      await makeWordDoc(finalPath);
    })();
  });
}


/* --------------------------------------------------------- slack threads --- */

/**
 * A thread note is a pointer in the same mould: the thread's permalink, and nothing said
 * on its behalf. The channel and the timestamp that name the thread are both inside the
 * link, so the one line is the whole handle — and it is a link that works pasted anywhere.
 * Empty means "not started yet", which a click starts.
 */
const slackTemplate = (url: string): string =>
  url ? `type:: slack\n\nthread:: ${url}\n` : `type:: slack\n`;

/** Whether a workspace is connected and what it is called; null until the shell says. */
let slackState: { connected: boolean; team: string; user: string; bot: boolean } | null = null;

async function refreshSlack(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  slackState = await bridge.slackStatus().catch(() => null);
  redrawSettings();
}

/**
 * The whole setup: paste a bot token once. It is proved against Slack before it is kept,
 * so a bad one is told about now; connecting is also what switches the integration on.
 * Connected, the same button disconnects — the token is forgotten, the notes keep their
 * links.
 */
async function setUpSlack(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) {
    ui.status.textContent = "Slack needs the desktop app — npm start";
    return;
  }
  if (slackState?.connected) {
    const who = slackState.team ? ` (${slackState.team})` : "";
    if (!(await askConfirm(`Disconnect Slack${who}? Notes keep their thread links.`, "Disconnect"))) return;
    await bridge.slackForget().catch(() => false);
    ui.status.textContent = "Slack: disconnected — the token is forgotten";
    await refreshSlack();
    return;
  }
  const token = await askText(
    "Paste a Slack user token (xoxp-…) — posts then go out as you. It is kept in this machine's keychain, never in the vault.",
    "",
    "Connect",
  );
  if (!token) return;
  try {
    const { team } = await bridge.slackConnect(token.trim());
    settings.set("slack", true);
    ui.status.textContent = `Slack: connected to ${team || "the workspace"} — now choose a channel`;
  } catch (err) {
    ui.status.textContent = `Slack: ${shellError(err)}`;
  }
  await refreshSlack();
}

/** Which channel threads start in — the one question the vault answers about Slack. */
async function pickSlackChannel(): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge || !slackState?.connected) return;
  ui.status.textContent = "Slack: reading the channels…";
  let channels: Awaited<ReturnType<NonNullable<Window["bedrock"]>["slackChannels"]>>;
  try {
    channels = await bridge.slackChannels();
  } catch (err) {
    ui.status.textContent = `Slack: ${shellError(err)}`;
    return;
  }
  if (!channels.length) {
    ui.status.textContent = "Slack: that token can see no channels";
    return;
  }
  // A workspace has hundreds of these, so the pick is searched rather than scrolled.
  // Two channels cannot share a name, so the label is the whole answer.
  const rows = channels.map((channel) => ({
    label: `#${channel.name}`,
    hint: channel.member ? (channel.private ? "private" : "") : "not a member",
  }));
  const picked = await askPick("Which channel should threads start in?", rows, "Search channels…");
  const channel = channels.find((c) => `#${c.name}` === picked);
  if (!channel) return;
  settings.setSetup({ slackChannel: channel.id, slackChannelName: `#${channel.name}` });
  ui.status.textContent = channel.member
    ? `Slack: threads start in #${channel.name}`
    : `Slack: threads start in #${channel.name} — join it first, or Slack refuses the post`;
  redrawSettings();
}

/** A shell to ask, and a token in it. Enough to attach a thread by its link. */
async function slackConnected(): Promise<boolean> {
  const bridge = window.bedrock;
  if (!bridge) {
    ui.status.textContent = "Slack threads need the desktop app — npm start";
    return false;
  }
  slackState = await bridge.slackStatus().catch(() => null);
  if (!slackState?.connected) {
    ui.status.textContent = "Slack: connect the workspace first — Settings → Integrations → Slack";
    redrawSettings();
    return false;
  }
  return true;
}

/** Whether a thread may be STARTED: connected, and with a channel to start it in. */
async function slackReady(): Promise<boolean> {
  if (!(await slackConnected())) return false;
  if (!settings.setup().slackChannel) {
    ui.status.textContent = "Slack: choose a channel first — Settings → Integrations → Slack";
    return false;
  }
  return true;
}

/** How much of a first message becomes the note's name. */
const SLACK_LABEL_LENGTH = 36;

/**
 * What a thread is called here: the head of its first message, cut at a word. A thread
 * started from a note opens with the note's own name, so for those the two are the same
 * thing; for one attached from Slack this is the name the note is born with, and a name
 * given by hand afterwards is never touched.
 */
function slackLabel(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return "Slack thread";
  if (line.length <= SLACK_LABEL_LENGTH) return line;
  const cut = line.slice(0, SLACK_LABEL_LENGTH);
  const space = cut.lastIndexOf(" ");
  return `${(space > 12 ? cut.slice(0, space) : cut).replace(/[\s,;:.!?\-–—]+$/, "")}…`;
}

/**
 * What a pasted Slack link names: `…/archives/C0123ABCD/p1693000000123456`, with a
 * `thread_ts` alongside when it was copied from a reply. The thread's own timestamp wins,
 * so a link to any reply attaches the whole thread. Null for anything that is not one.
 */
function readSlackLink(typed: string): { channel: string; ts: string } | null {
  let url: URL;
  try {
    url = new URL(typed.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)slack\.com$/.test(url.hostname)) return null;
  const m = /\/archives\/([CGD][A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(url.pathname);
  if (!m) return null;
  const thread = url.searchParams.get("thread_ts");
  return { channel: m[1], ts: thread && /^\d+\.\d+$/.test(thread) ? thread : `${m[2]}.${m[3]}` };
}

/**
 * Starts the thread a note stands for. There is no other way to make one — a thread IS a
 * message with answers — so the note's name is posted as the first message, in the
 * vault's channel, and the link Slack mints for it is written home and opened.
 */
async function makeSlackThread(path: string): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) return;
  const { slackChannel, slackChannelName } = settings.setup();
  ui.status.textContent = `Slack: starting “${noteName(path)}” in ${slackChannelName}…`;
  let thread: SlackThread;
  try {
    thread = await bridge.slackPost(slackChannel, noteName(path));
  } catch (err) {
    ui.status.textContent = `Slack: ${shellError(err)}`;
    return;
  }
  await flushAll(); // the note may be open and mid-edit; the write must not clobber
  await vault.write(path, setField(await vault.read(path), "thread", thread.url));
  graphView.setSlackThread(path, thread.url);
  graphStale = true;
  for (let i = 0; i < panes.length; i++) if (pathOf(panes[i]) === path) await renderPage(i);
  void bridge.slackOpen(thread.url);
  ui.status.textContent = `${noteName(path)} → its own thread in ${slackChannelName}, open in Slack`;
}

/**
 * Click on a thread node: open the thread. A note whose thread was never started (the
 * post failed, or the line was stripped by hand) is offered a start — asked first, because
 * unlike making a page, starting a thread says something in front of other people.
 */
async function openSlackNode(path: string, url: string | null): Promise<void> {
  // One tick later, for the same reason `openFsNode` waits: the click's own free
  // handler clears the hint right after this, and the message has to outlive that.
  const say = (message: string): void => {
    window.setTimeout(() => {
      ui.status.textContent = message;
    }, 0);
  };
  const bridge = window.bedrock;
  if (!bridge) {
    say("Slack threads need the desktop app — npm start");
    return;
  }
  if (url) {
    const opened = await bridge.slackOpen(url);
    say(opened ? `${noteName(path)} → Slack` : `the note's thread:: line is not a Slack message link`);
    return;
  }
  if (!(await slackReady())) return;
  const where = settings.setup().slackChannelName;
  if (!(await askConfirm(`Start a thread in ${where}, with “${noteName(path)}” as its first message?`, "Post"))) return;
  await makeSlackThread(path);
}

/**
 * "New Slack thread" — from the canvas menu, or from a link draft released on empty
 * space. The note comes first and gets its name, and committing the name is what starts
 * the thread: the name is the first message, and the link comes home.
 */
async function createSlackAt(
  at: { x: number; y: number },
  folder: string | null,
  source: string | null = null,
): Promise<void> {
  if (!(await slackReady())) return;
  const dir = folder ?? "";
  const path = uniquePath(filePaths(), dir, "Slack thread", ".md");
  await vault.createFile(path, slackTemplate(""));
  entries = [...entries, { path, kind: "file" }]; // so the rename's collision check sees it
  if (source) {
    graphView.commitLink(source, path, {
      label: noteName(path),
      parent: dir || undefined,
      at,
      type: "slack",
    });
  } else {
    graphView.commitNode(path, noteName(path), dir || undefined, at, "slack");
  }
  graphStale = true;
  await refreshSidebar();
  ui.status.textContent = `created ${path} — name it, and that name opens a thread in ${settings.setup().slackChannelName}`;
  graphView.renameNode(path, (name) => {
    void (async () => {
      const finalPath = name ? ((await applyRename(path, "file", name)) ?? path) : path;
      if (!source) {
        await makeSlackThread(finalPath);
        return;
      }
      // Linked thread: the link is written home first, unnamed — a click on the line
      // names it — and then the thread starts.
      await finishLink(source, finalPath, null);
      await makeSlackThread(finalPath);
    })();
  });
}

/** A thread that already exists, made into a note named after its first message. */
const attachSlackThread = (
  thread: SlackThread,
  at: { x: number; y: number },
  folder: string | null,
  source: string | null,
): Promise<void> => {
  const title = slackLabel(thread.text);
  return attachNodeAt(
    {
      kind: "slack",
      title,
      text: slackTemplate(thread.url),
      handle: thread.url,
      done: `${title} → its thread in Slack`,
    },
    at,
    folder,
    source,
  );
};

/**
 * "Paste a link…" — the row under the channel's threads. Any message link will do, from
 * any channel the token can read: the thread it starts (or belongs to) is asked for, and
 * the note takes the head of its first message for a name.
 */
async function pasteSlackThreadAt(
  at: { x: number; y: number },
  folder: string | null,
  source: string | null = null,
): Promise<void> {
  if (!(await slackConnected())) return;
  const bridge = window.bedrock;
  if (!bridge) return;
  const typed = await askText("Paste a link to a Slack message — the one that started the thread, or any reply in it", "", "Attach");
  if (typed === null) return;
  const link = readSlackLink(typed);
  if (!link) {
    ui.status.textContent = `${typed.trim() || "that"} is not a Slack message link`;
    return;
  }
  ui.status.textContent = "Slack: reading the thread…";
  let thread: SlackThread;
  try {
    thread = await bridge.slackThread(link.channel, link.ts);
  } catch (err) {
    ui.status.textContent = `Slack: ${shellError(err)}`;
    return;
  }
  await attachSlackThread(thread, at, folder, source);
}

/* ----------------------------------------------------------- antigravity --- */

/**
 * A session note in the same mould as a Claude one: no prose, just the handle. The folder
 * the session runs in, and the conversation `agy` minted for it — nothing else, not even a
 * heading. Its name on the graph is its filename, which is the one place a name belongs
 * when the file has nothing else in it.
 */
const antigravityTemplate = (folder: string | null): string =>
  `type:: antigravity\n${folder ? `\nfolder:: ${folder}\n` : ""}`;

/** The name a session note is born with, until it is given one. */
const ANTIGRAVITY_NAME = "Antigravity session";

/** Notes with a mint in flight — a second click must not mint a second conversation. */
const antigravityStarting = new Set<string>();

/**
 * Click on an Antigravity session node.
 *
 * Two states, and the note's own `conversation::` line tells them apart. A note that has
 * one is resumed: `agy --conversation <id>` in a terminal, history and all. A note that
 * has none mints one first — and the id goes into the note BEFORE the terminal opens, so a
 * conversation can never end up running with nothing on disk pointing at it.
 *
 * The minting is the only part that waits, and it waits on the CLI announcing an id rather
 * than on any model call, so it is a couple of seconds. Nothing is watched for afterwards:
 * unlike the integration this replaced, the id is known before the session is opened.
 */
async function openAntigravitySession(path: string, conversation: string | null): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge) {
    ui.status.textContent = "Antigravity sessions need the desktop app — npm start";
    return;
  }
  if (!(await antigravityReady())) return;

  await flushAll(); // the note may be open and mid-edit; its fields have to be current
  const text = await vault.read(path);
  const held = conversation || parseField(text, "conversation");
  const folder =
    parseField(text, "folder") || settings.antigravityFolder() || (await askAntigravityFolder());
  if (!folder) return; // nowhere to run it, and the ask was declined

  if (held) {
    // A note that had to be asked where to run keeps the answer, so it is asked once and
    // not once per opening. Its conversation is already true, so only the folder is written.
    if (!parseField(text, "folder")) await saveAntigravityConversation(path, held, folder);
    await handAntigravityToTerminal(path, held, folder);
    return;
  }
  if (antigravityStarting.has(path)) {
    ui.status.textContent = `${noteName(path)} — a conversation is already being started for this note`;
    return;
  }

  antigravityStarting.add(path);
  ui.status.textContent = `${noteName(path)} — starting a conversation in ${folder}…`;
  try {
    const id = await bridge.agyCreate(folder, noteName(path));
    await saveAntigravityConversation(path, id, parseField(text, "folder") ? null : folder);
    await handAntigravityToTerminal(path, id, folder);
  } catch (err) {
    ui.status.textContent = `Antigravity: ${(err as Error).message}`;
  } finally {
    antigravityStarting.delete(path);
  }
}

/**
 * Hands a conversation to the terminal and says so. Deliberately says WHICH terminal it is
 * not: Bedrock does not own the window, cannot tell whether the session is still running
 * once it is in there, and should not imply otherwise.
 */
async function handAntigravityToTerminal(
  path: string,
  conversation: string,
  folder: string,
): Promise<void> {
  try {
    await window.bedrock?.agyOpen({ id: conversation, folder, title: noteName(path) });
    ui.status.textContent = `${noteName(path)} → its session, in your terminal (${folder})`;
  } catch (err) {
    ui.status.textContent = `Antigravity: ${(err as Error).message}`;
  }
}

/**
 * Whether an Antigravity action may go ahead, asked of the shell rather than of the flag,
 * so the answer is never one install out of date. The CLI is the whole prerequisite —
 * there is nothing to be signed into HERE, and a session that needs a login says so in the
 * terminal, which is a better place to answer it than a settings page.
 */
async function antigravityReady(): Promise<boolean> {
  const bridge = window.bedrock;
  if (!bridge) return false;
  const status = await bridge.agyStatus().catch(() => null);
  agyCli = status?.cli ?? null;
  agyRan = status?.ran ?? false;
  if (!agyCli) {
    ui.status.textContent =
      "Antigravity: the agy CLI is not installed — see antigravity.google/docs/cli, then click again";
    redrawSettings();
  }
  return !!agyCli;
}

/**
 * Writes a conversation's id into its note. Safe to run twice: a note that already carries
 * this id is left exactly as it is. `folder` is written only when the note was not already
 * carrying one, so a session's own folder is recorded once and then believed.
 */
async function saveAntigravityConversation(
  path: string,
  conversation: string,
  folder: string | null,
): Promise<void> {
  if (!(await vault.exists(path))) return; // the note went away mid-start
  await flushAll();
  const text = await vault.read(path);
  let next = setField(text, "conversation", conversation);
  if (folder) next = setField(next, "folder", folder);
  if (next === text) return;
  if (!(await tryVault(`could not write to ${noteName(path)}`, () => vault.write(path, next)))) return;
  graphView.setAntigravityConversation(path, conversation);
  graphStale = true;
  syncOpenPanes(path, next);
}

/**
 * "New Antigravity session" — from the canvas menu, or from a link draft released on empty
 * space (`source` is then the note the arrow came from).
 *
 * Nothing is started here. The note is created and named, and that is all: a conversation
 * is minted by the first click on the node, which is the click that also opens it. A node
 * whose session was never opened has cost nothing and left nothing behind — which is the
 * whole reason not to mint one at creation time.
 */
async function createAntigravityAt(
  at: { x: number; y: number },
  folder: string | null,
  source: string | null = null,
): Promise<void> {
  if (!(await antigravityReady())) return;
  const dir = folder ?? "";
  const path = freshPath(dir, ANTIGRAVITY_NAME);
  const runIn = settings.antigravityFolder();
  await vault.createFile(path, antigravityTemplate(runIn));
  entries = [...entries, { path, kind: "file" }]; // so the rename's collision check sees it
  if (source) {
    graphView.commitLink(source, path, {
      label: noteName(path),
      parent: dir || undefined,
      at,
      type: "antigravity",
    });
  } else {
    graphView.commitNode(path, noteName(path), dir || undefined, at, "antigravity");
  }
  graphStale = true;
  ui.status.textContent = `created ${path} — name it, and clicking it starts the session`;
  graphView.renameNode(path, (name) => {
    void (async () => {
      const finalPath = name ? ((await applyRename(path, "file", name)) ?? path) : path;
      if (source) await finishLink(source, finalPath, null);
    })();
  });
  await refreshSidebar();
}

/**
 * "Plug in a session…" — points a note at a conversation that already exists, whether it
 * was started here, in the Antigravity IDE, or by hand in a terminal.
 *
 * The list is the CLI's own inventory, which is two lists stitched together: the summaries
 * it keeps titles in, and every conversation database on disk. The second is what makes a
 * conversation minted here and never talked to appear at all — it has no summary row until
 * something is said in it.
 */
async function plugInAntigravitySession(path: string): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge || !(await antigravityReady())) return;
  const found = await bridge.agyConversations(20).catch(() => []);
  if (!found.length) {
    ui.status.textContent = "Antigravity: no conversations on this machine yet";
    return;
  }
  const label = (one: (typeof found)[number]): string => {
    const when = one.at ? new Date(one.at).toLocaleString() : "never opened";
    const what = one.title || one.preview.slice(0, 40) || `untitled — ${one.id.slice(0, 8)}`;
    return `${what} — ${when}`;
  };
  const picked = await askChoice(
    "Which conversation should this note open?",
    found.map(label),
    "Cancel",
  );
  const chosen = picked ? found[found.map(label).indexOf(picked)] : null;
  if (!chosen) return;
  await saveAntigravityConversation(path, chosen.id, chosen.folder || null);
  ui.status.textContent = `${noteName(path)} now opens ${chosen.title || chosen.id.slice(0, 8)}`;
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
 *
 * `first` is put at the top of the list — the vault's own default when there is one, which
 * is the answer being changed when this is asked from the settings window.
 */
async function askClaudeFolder(first?: string | null): Promise<string | null> {
  const recent = (await window.bedrock?.claudeFolders(8).catch(() => [])) ?? [];
  // The vault itself belongs on the list — a session about these notes may well run in
  // them — but only if its location is already known. Asking where the vault lives in order
  // to ask which folder to run in is two questions to answer one.
  const root = knownVaultRoot();
  const choices = [...new Set([...(first ? [first] : []), ...recent, ...(root ? [root] : [])])];
  const question = "Which folder should this session run in?";
  if (!choices.length) return askText(question, first ?? "~/", "Use this");
  return askChoice(question, choices, "Another folder…", question, first ?? undefined);
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
  if (settings.setup().claudeWindow === "terminal") return openClaudeTerminal(path, session);
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

  // The note's own answer first, then the vault's (Settings → Integrations → Claude Code),
  // and only then the question — a vault that has said where its sessions run is not asked
  // again for every note.
  const folder = parseField(text, "folder") || settings.claudeFolder() || (await askClaudeFolder());
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

/**
 * The same click, in terminal mode.
 *
 * Three states, and the note's own `session::` line tells them apart: a session that is
 * mid-turn somewhere is left alone and said so (see below); a session that has finished is
 * resumed on the same id, so its history comes back with it; a note that has never run
 * starts one. In every case the id is minted by the shell BEFORE the CLI starts, so the
 * note knows its session's name immediately — none of the app path's watching-for-a-
 * transcript is needed here.
 */
async function openClaudeTerminal(path: string, session: string | null): Promise<void> {
  const bridge = window.bedrock;
  if (!bridge || !(await terminalReady())) return;

  // A session that is mid-turn somewhere is NOT reopened. Bedrock cannot raise a terminal
  // window it does not own, so the only thing a second click could do is start a second
  // `claude --resume` on the same transcript — two processes appending to one file, which
  // is worse than being told to go and find the window.
  if (session) {
    const live = await bridge.claudeStatus([session]).catch(() => null);
    const state = live?.[session]?.state;
    if (state === "running" || state === "waiting") {
      ui.status.textContent =
        `${noteName(path)} — already ${state === "running" ? "running" : "waiting on you"} in a terminal; ` +
        `find that window rather than opening a second one on the same session`;
      return;
    }
  }

  await flushAll(); // the note may be open and mid-edit; its fields have to be current
  const text = await vault.read(path);
  const folder = parseField(text, "folder") || settings.claudeFolder() || (await askClaudeFolder());
  if (!folder) return; // nowhere to run it, and the ask was declined

  try {
    // A note that has run before resumes ITS session rather than starting a stranger.
    const id = await bridge.claudeCliStart(folder, session ?? null, noteName(path));
    await saveClaudeSession(path, id);
    if (!parseField(text, "folder")) {
      const next = setField(await vault.read(path), "folder", folder);
      await tryVault(`could not write to ${noteName(path)}`, () => vault.write(path, next));
      syncOpenPanes(path, next);
    }
    graphStale = true;
    await markSessionSeen(path);
    ui.status.textContent = session
      ? `${noteName(path)} → its session, resumed in your terminal (${folder})`
      : `${noteName(path)} → a session started in your terminal (${folder})`;
  } catch (err) {
    ui.status.textContent = `Claude: ${(err as Error).message}`;
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

/* ------------------------------------------- attaching to what is already there --- */
/*
 * Pointing a NEW note at something that already exists over there — an Apple note you
 * wrote last week, a Notion page, a Claude session that has been running all morning.
 *
 * Every integration used to grow its own copy of this: read a list, number the duplicate
 * titles, put them in a modal, make a note out of the answer. Four copies of one idea, and
 * the two agent integrations never got one at all. It is one table now. What genuinely
 * differs between them is only three things — what the list is, what the note says, and
 * what rides on the node — so that is all an entry says.
 *
 * The list is fetched when its row is OPENED, never when the menu is built: a right-click
 * must not wait on Notion, and a list nobody looked at costs nothing.
 */

/** One thing that could be attached to: its row in the menu, and what picking it does. */
type AttachOption = {
  label: string;
  /** Drawn dimmer, to the right — what tells two rows with the same name apart. */
  hint?: string;
  place: (at: { x: number; y: number }, folder: string | null, source: string | null) => Promise<void>;
};

type Attachable = {
  kind: DraftKind;
  feature: Feature;
  /** The row in the Attach branch — singular, because you pick one. */
  label: string;
  /** What could be attached to. Throws something worth reading when it cannot say. */
  options: () => Promise<AttachOption[]>;
};

/** A last-touched stamp, short enough to sit in a menu row. */
const when = (at: number): string =>
  at ? new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

/**
 * Makes the note, puts it on the graph, and — when it came off a link draft — draws the
 * link and asks that link's name. The one place any of the six does any of that.
 */
async function attachNodeAt(
  spec: {
    kind: DraftKind;
    title: string;
    text: string;
    /** What rides on the node, so a click opens the thing without reading the file first. */
    handle?: string;
    /** Anything the live node needs that does not ride as `handle`. */
    paint?: (path: string) => void;
    done: string;
  },
  at: { x: number; y: number },
  folder: string | null,
  source: string | null,
): Promise<void> {
  const dir = folder ?? "";
  const path = uniquePath(filePaths(), dir, asFileName(spec.title || "Untitled"), ".md");
  await vault.createFile(path, spec.text);
  entries = [...entries, { path, kind: "file" }];
  if (source) {
    graphView.commitLink(source, path, {
      label: noteName(path),
      parent: dir || undefined,
      at,
      type: spec.kind,
      url: spec.handle,
    });
    void finishLink(source, path, null);
  } else {
    graphView.commitNode(path, noteName(path), dir || undefined, at, spec.kind, spec.handle);
  }
  spec.paint?.(path);
  graphStale = true;
  ui.status.textContent = spec.done;
  await refreshSidebar();
}

/** The shell, or a thrown line saying why there is none — the menu draws that line. */
function shellOrThrow(): NonNullable<Window["bedrock"]> {
  const bridge = window.bedrock;
  if (!bridge) throw new Error("needs the desktop app");
  return bridge;
}

const ATTACHABLES: Attachable[] = [
  {
    kind: "applenote",
    feature: "applenotes",
    label: "Apple note",
    options: async () => {
      const notes = await shellOrThrow().notesList(30);
      return notes.map((note) => ({
        label: note.title || "Untitled",
        hint: when(note.at),
        place: (at, folder, source) =>
          attachNodeAt(
            {
              kind: "applenote",
              title: note.title,
              text: appleNoteTemplate(note.id),
              handle: note.id,
              done: `${note.title || "Untitled"} → its note in Apple Notes`,
            },
            at,
            folder,
            source,
          ),
      }));
    },
  },
  {
    kind: "notion",
    feature: "notion",
    label: "Notion page",
    options: async () => {
      // An empty query lists what is recent, which is the right default for a menu. A
      // workspace is bigger than any list, so the search stays reachable underneath it.
      const pages = await shellOrThrow().notionSearch("");
      const rows: AttachOption[] = pages.map((page) => ({
        label: page.title || "Untitled",
        place: (at, folder, source) =>
          attachNodeAt(
            {
              kind: "notion",
              title: page.title,
              text: notionTemplate(page.url),
              handle: page.url,
              done: `${page.title || "Untitled"} → its page in Notion`,
            },
            at,
            folder,
            source,
          ),
      }));
      rows.push({ label: "Search Notion…", place: searchNotionAt });
      return rows;
    },
  },
  {
    kind: "slack",
    feature: "slack",
    label: "Slack thread",
    options: async () => {
      // The threads going in the vault's channel, newest first; a thread anywhere else —
      // or one in this channel nobody has answered yet — comes in through a pasted link.
      const bridge = shellOrThrow();
      const channel = settings.setup().slackChannel;
      const rows: AttachOption[] = [];
      if (channel) {
        const threads = await bridge.slackThreads(channel, 30).catch((err: unknown) => {
          throw new Error(shellError(err));
        });
        for (const thread of threads) {
          rows.push({
            label: slackLabel(thread.text),
            hint: `${thread.replies} ${thread.replies === 1 ? "reply" : "replies"} · ${when(thread.latest)}`,
            place: (at, folder, source) => attachSlackThread(thread, at, folder, source),
          });
        }
      }
      rows.push({ label: "Paste a link…", place: pasteSlackThreadAt });
      return rows;
    },
  },
  {
    kind: "word",
    feature: "word",
    label: "Word document",
    options: async () => {
      const docs = await shellOrThrow().wordRecent(30);
      return docs.map((doc) => ({
        label: doc.title || "Untitled",
        hint: when(doc.at),
        place: (at, folder, source) =>
          attachNodeAt(
            {
              kind: "word",
              title: doc.title,
              text: wordTemplate(doc.path),
              handle: doc.path,
              done: `${doc.title || "Untitled"} → its document in Word`,
            },
            at,
            folder,
            source,
          ),
      }));
    },
  },
  {
    kind: "freeform",
    feature: "freeform",
    label: "Freeform board",
    options: async () => {
      const boards = await shellOrThrow().freeformBoards(30);
      return boards.map((board) => ({
        label: board.title || "Untitled",
        hint: when(board.at),
        place: (at, folder, source) =>
          attachNodeAt(
            {
              kind: "freeform",
              title: board.title,
              text: freeformTemplate(board.id),
              handle: board.id,
              done: `${board.title || "Untitled"} → its board in Freeform`,
            },
            at,
            folder,
            source,
          ),
      }));
    },
  },
  {
    kind: "antigravity",
    feature: "antigravity",
    label: "Antigravity session",
    options: async () => {
      const found = await shellOrThrow().agyConversations(40);
      return found.map((one) => {
        // A conversation minted here and not yet talked to has no summary row, so no
        // title: it is named by its id, which is at least true.
        const title = one.title || one.preview.slice(0, 40) || `Session ${one.id.slice(0, 8)}`;
        const runIn = one.folder || settings.antigravityFolder();
        return {
          label: title,
          hint: one.folder ? basename(one.folder) : when(one.at),
          place: (at, folder, source) =>
            attachNodeAt(
              {
                kind: "antigravity",
                title,
                text: setField(antigravityTemplate(runIn), "conversation", one.id),
                handle: one.id,
                done: `${title} → its Antigravity session`,
              },
              at,
              folder,
              source,
            ),
        };
      });
    },
  },
  {
    kind: "claude",
    feature: "claude",
    label: "Claude session",
    options: async () => {
      const sessions = await shellOrThrow().claudeSessions(60);
      return sessions.map((session) => {
        const title = session.title || `Session ${session.id.slice(0, 8)}`;
        return {
          label: title,
          hint: session.folder ? basename(session.folder) : when(session.at),
          place: (at, folder, source) =>
            attachNodeAt(
              {
                kind: "claude",
                title,
                // A session id does NOT ride as the node's handle: a Claude node keeps it
                // on its own key, because the corner that reports what the session is
                // doing is keyed off that same field.
                text: setField(claudeTemplate(session.folder), "session", session.id),
                paint: (path) => {
                  graphView.setClaudeSession(path, session.id, session.folder);
                  void pollSessions(); // its dot should say something true immediately
                },
                done: `${title} → its Claude session`,
              },
              at,
              folder,
              source,
            ),
        };
      });
    },
  },
];

/** The attachables whose integration is switched on, in the order the table lists them. */
const attachables = (): Attachable[] => ATTACHABLES.filter((one) => settings.enabled(one.feature));

/**
 * The Attach branch: one row per integration, each opening the things it can see. Those
 * inner rows are lazy — see the note on `Attachable.options`.
 *
 * `release` says what a picked option does about its position. From empty space that is
 * known already; from a node it is wherever the link draft lands.
 */
function attachMenu(release: (option: AttachOption, kind: DraftKind) => () => void): MenuItem[] {
  return attachables().map((one) => ({
    label: one.label,
    icon: TYPE_ICONS[one.kind],
    children: async () => {
      const options = await one.options();
      return options.map((option) => ({
        label: option.label,
        hint: option.hint,
        run: release(option, one.kind),
      }));
    },
  }));
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
  // Where it runs is settled now rather than at the click, so the note says so from the
  // start. The vault's own answer wins outright when it has one (Settings → Integrations →
  // Claude Code): "every session in this vault runs here" is the whole point of setting it,
  // and asking anyway would make it a suggestion. Only a vault that has NOT been told asks —
  // and only where the shell can answer, since a browser has no folders to offer.
  const where = settings.claudeFolder() || (window.bedrock ? await askClaudeFolder() : null);
  const path = freshPath(dir, CLAUDE_NAME);
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
      // Linked session: the link is written home, unnamed like every drawn link, and
      // then the session opens.
      await finishLink(source, finalPath, null);
      await openClaudeSession(finalPath, null);
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
 * Right-drag landed on an existing note: draw the edge and write the link home, unnamed. Most
 * connections never need a word on them; the one that does gets it from a click on the line.
 */
function linkNotes(source: string, target: string): void {
  graphView.commitLink(source, target);
  graphStale = true;
  void finishLink(source, target, null);
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
ui.newFolder.addEventListener("click", () => void newFolder());
ui.graph.addEventListener("click", () => openGraph());

const redrawSettings = mountSettings(ui.settings, ui.settingsPanel, settings, {
  page: integrationPage,
  onAction: runIntegrationAction,
});
// All of these are the shell's to know, and all can change while the app runs — an agy
// install, a claude install, a `/login` inside a session, a commit made in a terminal.
ui.settings.addEventListener("click", () => {
  void refreshAntigravity();
  void refreshClaudeCli();
  void refreshGit();
  void refreshFreeform();
  void refreshNotion();
  void refreshSlack();
  void refreshAppleNotes();
  void refreshWord();
});
// The desktop app has a real menu bar — Settings… under the app's name (⌘,), Open
// Vault… under File — so the floating corner cluster is only the browser's stand-in.
ui.floatControls.hidden = !!window.bedrock;
window.bedrock?.onMenu((what) => {
  if (what === "settings") ui.settings.click();
  // The folder picker refuses to open without a real click, so the menu item opens the
  // front door instead — its buttons are real clicks, and Esc backs out over a vault.
  else ui.welcome.hidden = false;
});
settings.onChange = applyFeatures;
settings.onLook = applyLook;
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

// No vault opens by itself — not the demo, not even the last one. The app starts at
// the front door, and everything attaches when a real folder is picked (`pickFolder`).
void adoptLinearKey(); // a key stored on a previous run connects itself
void refreshSlack(); // and so does a Slack token

/** Whether any real vault has been opened this run — what lets Esc close the door. */
let vaultOpen = false;

el("welcome-open").addEventListener("click", () => void pickFolder());
el("welcome-new").addEventListener("click", () => void pickFolder());
document.addEventListener("keydown", (event) => {
  // The door can be closed over an open vault; before one is open there is nothing behind it.
  if (event.key === "Escape" && vaultOpen && !ui.welcome.hidden) ui.welcome.hidden = true;
});
