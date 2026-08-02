// Graph view: notes are nodes, folders are compound boxes, [[wikilinks]] are edges.
// Styling follows cytoscape.js-cola's demo-compound.html; the layout is our own solver
// (`layout.ts` + `apply-layout.ts`) — no force simulation runs at any point.

import cytoscape from "cytoscape";
import type { Core, EdgeSingular, ElementDefinition, NodeSingular } from "cytoscape";
import {
  FrameStore,
  centreOf,
  clampInto,
  ensureFrames,
  frameCentre,
  interior,
  isAnchor,
  removeAnchors,
  setFrame,
  type Frame,
} from "./frames";
import { edgeNotePath, edgeTitle, isEdgeNote } from "./edges";
import { inlineEdit, type InlineEditor } from "./inline";
import { layoutGraph } from "./apply-layout";
import { LinkResolver, parseLinks, parseTags } from "./links";
import { ancestors, basename, dirname, noteName } from "./vault";
import type { SpatialStore } from "./spatial";
import type { Sticky, StickyStore } from "./sticky";

export type Doc = { path: string; text: string };

/** Folder boxes read as containers, not as content, so they are blue and barely there. */
const BOX = "#4c8dff";

/** A note with no tags. */
const UNTAGGED = "#f92411";

/**
 * How many tags can colour one note. Cytoscape draws a node's background as pie slices,
 * so two tags split it in half, three into thirds, and so on; past this many the note is
 * unreadable as a pie anyway and the extra tags simply do not get a slice.
 */
const TAG_SLICES = 6;

/** Stable colour per tag, so a tag keeps its hue between sessions. */
function tagColour(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) % 100003;
  // Times the golden angle: neighbouring hashes land on opposite sides of the wheel,
  // so `#a` and `#b` — or `work/api` and `work/apt` — do not come out the same green.
  const hue = Math.round(hash * 137.508) % 360;
  // Comma form: cytoscape parses colours itself and does not accept the modern
  // space-separated `hsl(h s% l%)` syntax — it renders those as black.
  return `hsl(${hue}, 72%, 58%)`;
}

/** The pie slots, wired to per-node data so each note colours its own. */
function pieStyle(): Record<string, string> {
  const style: Record<string, string> = { "pie-size": "100%" };
  for (let i = 1; i <= TAG_SLICES; i++) {
    style[`pie-${i}-background-color`] = `data(pie${i})`;
    style[`pie-${i}-background-size`] = `data(pie${i}size)`;
  }
  return style;
}

/** A note's slices: equal shares of its tags' colours, empty slots switched off. */
function pieData(tags: string[]): Record<string, string | number> {
  const slices = tags.slice(0, TAG_SLICES);
  const share = slices.length ? 100 / slices.length : 0;
  const data: Record<string, string | number> = {};
  for (let i = 0; i < TAG_SLICES; i++) {
    data[`pie${i + 1}`] = slices[i] ? tagColour(slices[i]) : UNTAGGED;
    data[`pie${i + 1}size`] = slices[i] ? share : 0;
  }
  return data;
}

/**
 * A note's circle grows with how many notes link TO it, so the hubs of a vault are
 * obvious at a glance. Square-rooted: the first couple of references count for a lot,
 * and a heavily referenced note still fits inside its folder.
 */
const NODE_MIN = 20;
const NODE_MAX = 68;
export const nodeSize = (incoming: number): number =>
  Math.min(NODE_MAX, Math.round(NODE_MIN + 16 * Math.sqrt(incoming)));

/** demo-compound.html's style, plus labels (a note graph is unusable without them). */
const STYLE: cytoscape.StylesheetJson = [
  {
    selector: "node",
    style: {
      "background-color": "#f92411",
      label: "data(label)",
      color: "#dcddde",
      "font-size": 10,
      "text-valign": "center",
      "text-halign": "right",
      "text-margin-x": 4,
      "min-zoomed-font-size": 8,
      width: 20,
      height: 20,
    },
  },
  // Sized by incoming links (`nodeSize`), coloured by its tags (`pieData`).
  {
    selector: 'node[kind = "file"]',
    style: { width: "data(size)", height: "data(size)", ...pieStyle() },
  },
  {
    selector: "node:parent",
    style: {
      "background-color": BOX,
      // Almost see-through: the box is a boundary, and whatever it sits on top of
      // (another box, an edge passing under) has to stay readable through it.
      "background-opacity": 0.07,
      "border-width": 1.5,
      "border-color": BOX,
      "border-opacity": 0.9,
      "text-valign": "top",
      "text-halign": "center",
      "text-margin-x": 0,
      "text-margin-y": -4,
      "font-size": 12,
      color: BOX,
      // No padding: the drawn border then sits exactly on the frame's corner anchors,
      // so where the box looks like it ends is where a note actually stops.
      padding: "0px",
      // A note's label hangs off its right side. Counted towards the parent's size it
      // would shove the border outwards as soon as a note was dragged near the edge —
      // the frame is the anchors, and only the anchors.
      "compound-sizing-wrt-labels": "exclude",
    },
  },
  /*
   * A link has a direction — the note that points and the note pointed at — and a bare line
   * says nothing about which is which. So every edge carries a head at its target end.
   *
   * Cytoscape scales an arrow with the line it sits on, so a 1px edge draws an arrowhead too
   * small to read a direction from; the line is a shade thicker and the arrow is scaled up
   * past it. `target-distance-from-node` holds the point clear of the circle instead of
   * letting it disappear into the fill.
   */
  {
    selector: "edge",
    style: {
      "line-color": "#f92411",
      width: 1.4,
      "curve-style": "bezier",
      "target-arrow-shape": "triangle",
      "target-arrow-color": "#f92411",
      "arrow-scale": 1.3,
      "target-distance-from-node": 2,
    },
  },
  // A connection that owns a note is drawn as a thicker line: the vault's documented
  // flows are then legible as a shape, the same way `nodeSize` makes its hubs one. The
  // arrow already grows with the line, so it is scaled back to stay in proportion.
  { selector: "edge[described]", style: { width: 3, "arrow-scale": 1.1 } },
  // A named connection writes its relation along the line, rotated with it and backed by the
  // canvas colour so it stays readable where it crosses other edges.
  {
    selector: "edge[label]",
    style: {
      label: "data(label)",
      "font-size": 9,
      color: "#dcddde",
      "text-rotation": "autorotate",
      "text-background-color": "#1e1f22",
      "text-background-opacity": 0.85,
      "text-background-padding": "2px",
      "text-background-shape": "roundrectangle",
    },
  },
  { selector: "node.active", style: { "border-width": 3, "border-color": "#dcddde" } },
  { selector: ".faded", style: { opacity: 0.25 } },
  // The arrow is recoloured with the line everywhere, or a highlighted edge keeps a red
  // head that reads as a different edge crossing it.
  {
    selector: ".highlight",
    style: { "line-color": "#ffffff", "target-arrow-color": "#ffffff", width: 2, "arrow-scale": 1.3 },
  },
  // The connection whose note is the open tab — the edge's answer to the node's ring.
  {
    selector: "edge.active",
    style: { "line-color": "#dcddde", "target-arrow-color": "#dcddde", width: 3, "arrow-scale": 1.1 },
  },
  // The link being drawn: an invisible cursor-following node plus an arrow to it.
  {
    selector: "node.draft",
    style: { width: 1, height: 1, "background-opacity": 0, label: "", events: "no" },
  },
  {
    selector: "edge.draft",
    style: {
      "line-color": "#ffffff",
      "line-style": "dashed",
      width: 2,
      "target-arrow-shape": "triangle",
      "target-arrow-color": "#ffffff",
      "curve-style": "straight",
      events: "no",
    },
  },
  { selector: "node.draft-source", style: { "border-width": 3, "border-color": "#ffffff" } },
  // Folder box under a dragged note: dashed while resisting, solid once armed.
  {
    selector: "node.drop-hover",
    style: { "border-width": 2, "border-color": "#ffffff", "border-style": "dashed" },
  },
  {
    selector: "node.drop-armed",
    style: { "border-width": 3, "border-color": "#ffffff", "background-opacity": 0.22 },
  },
  // Leaving a folder reads differently from entering one.
  {
    selector: "node.drop-leaving",
    style: { "border-width": 3, "border-color": "#ffd166", "border-style": "dashed" },
  },
  // Folder boxes toggled off. NOT `visibility: hidden` -- on a compound parent
  // that cascades and hides the notes inside it too. Leaving the box unpainted
  // hides only the box itself.
  {
    selector: "node.box-hidden",
    style: { "background-opacity": 0, "border-width": 0, label: "", events: "no" },
  },
  // The invisible corner children that hold a folder box at a constant size.
  {
    selector: "node.frame-anchor",
    style: { width: 1, height: 1, "background-opacity": 0, label: "", events: "no" },
  },
];

const BOXES_KEY = "obsidian-lite:boxes";

const DRAFT_NODE = "__draft_target__";
const DRAFT_EDGE = "__draft_edge__";

const clientPoint = (event: cytoscape.EventObject): { x: number; y: number } => {
  const original = event.originalEvent as MouseEvent | undefined;
  return { x: original?.clientX ?? 0, y: original?.clientY ?? 0 };
};

/** Nearest point on a box's border to `point` — where a resisted drag is held. */
function rimPoint(point: cytoscape.Position, bb: cytoscape.BoundingBox12 & cytoscape.BoundingBoxWH): cytoscape.Position {
  const gaps = [
    { d: point.x - bb.x1, p: { x: bb.x1, y: point.y } },
    { d: bb.x2 - point.x, p: { x: bb.x2, y: point.y } },
    { d: point.y - bb.y1, p: { x: point.x, y: bb.y1 } },
    { d: bb.y2 - point.y, p: { x: point.x, y: bb.y2 } },
  ];
  return gaps.reduce((best, gap) => (gap.d < best.d ? gap : best)).p;
}

/**
 * Edge ids must be built identically by the file-derived rebuild and by the
 * right-click link gesture, or the "already linked?" check silently misses and
 * a second parallel edge appears. NUL can't occur in a path, so it's a safe join.
 */
const edgeId = (source: string, target: string): string => `${source}\u0000${target}`;

/**
 * No simulation. `layoutGraph()` solves the whole arrangement itself — springs, gravity and a
 * hard non-overlap projection, per folder and then across folders — so cola's embedding was only
 * ever a starting guess that cost 2.5s of animation and made the result depend on where the
 * simulation happened to stop. "preset" means cytoscape places nothing and we place everything.
 */
const LAYOUT = { name: "preset" } as unknown as cytoscape.LayoutOptions;

/**
 * Builds compound elements: one node per note, one parent box per folder.
 *
 * `described` is the set of connection-note paths that exist on disk (see `edges.ts`); an
 * edge whose note is among them is marked so the stylesheet can draw it as documented.
 */
export function buildElements(docs: Doc[], described: ReadonlySet<string> = new Set()): ElementDefinition[] {
  const resolver = new LinkResolver(docs.map((d) => d.path));
  const elements: ElementDefinition[] = [];
  const folders = new Set<string>();

  // Edges are resolved FIRST: a note is sized by how many others point at it, so the
  // link pass has to have run before the nodes can be emitted.
  // One edge per (source, target); its label is the relation named in the file
  // (`built with:: [[Target]]`). Several links to the same note keep every distinct name.
  const byEdge = new Map<string, { source: string; target: string; labels: string[] }>();
  const incoming = new Map<string, number>();
  for (const doc of docs) {
    for (const link of parseLinks(doc.text)) {
      const resolved = resolver.resolve(link.target);
      if (!resolved || resolved === doc.path) continue;
      const id = edgeId(doc.path, resolved);
      const found = byEdge.get(id) ?? { source: doc.path, target: resolved, labels: [] };
      if (link.label && !found.labels.includes(link.label)) found.labels.push(link.label);
      // Count linking notes, not links: ten mentions in one note is still one voice.
      if (!byEdge.has(id)) incoming.set(resolved, (incoming.get(resolved) ?? 0) + 1);
      byEdge.set(id, found);
    }
  }

  for (const doc of docs) {
    for (const folder of ancestors(doc.path)) folders.add(folder);
    elements.push({
      data: {
        id: doc.path,
        label: noteName(doc.path),
        parent: dirname(doc.path) || undefined,
        kind: "file",
        size: nodeSize(incoming.get(doc.path) ?? 0),
        ...pieData(parseTags(doc.text)),
      },
    });
  }
  for (const folder of folders) {
    elements.push({
      data: { id: folder, label: basename(folder), parent: dirname(folder) || undefined, kind: "dir" },
    });
  }

  for (const [id, edge] of byEdge) {
    const label = edge.labels.join(", ");
    elements.push({
      data: {
        id,
        source: edge.source,
        target: edge.target,
        ...(label ? { label } : {}),
        ...(described.has(edgeNotePath(edge.source, edge.target)) ? { described: 1 } : {}),
      },
    });
  }
  return elements;
}

export type Client = { x: number; y: number };

export type GraphHandlers = {
  onOpen: (path: string) => void;
  /**
   * Click on a connection: open the markdown file that describes it, creating it on the
   * spot if this is the first time anybody has had something to say about that link.
   * `label` is the relation named in the note, so a new file can open with it already in.
   */
  onOpenEdge: (source: string, target: string, label: string | null) => void;
  /** Right-click on a note: offer "link" / "delete". */
  onNodeMenu: (path: string, client: Client) => void;
  /** Right-click on empty canvas, or inside a folder box: offer "new note/folder". */
  onCanvasMenu: (at: cytoscape.Position, client: Client, folder: string | null) => void;
  /** Link draft finished on another note: link `source` -> `target`. */
  onLinkExisting: (source: string, target: string) => void;
  /**
   * Link draft finished on empty canvas: create a note THERE and link to it. `folder` is the box
   * the release landed in (null at the root) — the note belongs where the user dropped it, not
   * wherever the source note happens to live.
   */
  onLinkNew: (source: string, at: cytoscape.Position, folder: string | null) => void;
  /** A note was dragged deep enough into a folder box to move it there. */
  onReparent: (path: string, folder: string) => void;
  /**
   * A rectangle was drawn around `paths`: put them in a new folder. `frame` is the
   * rectangle in model units, so the box can appear exactly as it was drawn.
   */
  onGroup: (paths: string[], frame: Frame) => void;
  /** Transient instruction for the status bar (null clears it). */
  onHint: (hint: string | null) => void;
};

/**
 * How far (model units) the pointer must push past a folder's border before the
 * drop is armed. Below this the node is pinned to the rim, so brushing a box on
 * the way past never silently refiles a note.
 */
const DROP_DEPTH = 30;

type DragState = {
  path: string;
  parent: string | null;
  target: string | null;
  armed: boolean;
};

/** A rectangle in rendered (screen) coordinates, relative to the canvas. */
type Area = { x1: number; y1: number; x2: number; y2: number };

/** Which corner of a frame a resize grip holds, as a direction from the centre. */
type Corner = { sx: 1 | -1; sy: 1 | -1; cursor: string };

const CORNERS: readonly Corner[] = [
  { sx: -1, sy: -1, cursor: "nwse-resize" },
  { sx: 1, sy: -1, cursor: "nesw-resize" },
  { sx: -1, sy: 1, cursor: "nesw-resize" },
  { sx: 1, sy: 1, cursor: "nwse-resize" },
];

export class GraphView {
  private cy: Core | null = null;
  private pending: { docs: Doc[]; active: string | null; described: ReadonlySet<string> } | null = null;
  private sizeWatcher: ResizeObserver | null = null;
  private draftSource: string | null = null;
  private drag: DragState | null = null;
  private frames: FrameStore;
  private boxesVisible = localStorage.getItem(BOXES_KEY) !== "off";
  private handles = new Map<string, HTMLElement>();
  private rename: { path: string; editor: InlineEditor } | null = null;
  /** The open "name this connection" field, if any (step two of drawing a link). */
  private connection: { source: string; target: string; editor: InlineEditor } | null = null;
  /** Positions held over across a rename/move, keyed by the node's new id. */
  private carried = new Map<string, cytoscape.Position>();
  /** Holds the resize handles and the rename field above the canvas. */
  private overlay: HTMLElement;
  /** While the group tool is armed: the sheet that takes the drag off cytoscape. */
  private lasso: HTMLElement | null = null;
  /** Sticky id -> its element in the overlay. */
  private stickyEls = new Map<string, HTMLElement>();
  /** Container size the view was last framed at, and whether the user has moved it since. */
  private fittedSize: { w: number; h: number } | null = null;
  private userMoved = false;
  private fitting = false;

  constructor(
    private container: HTMLElement,
    private handlers: GraphHandlers,
    private spatial: SpatialStore,
    private stickies: StickyStore,
  ) {
    this.frames = new FrameStore(spatial);
    this.overlay = document.createElement("div");
    this.overlay.className = "graph-overlay";
    // A sibling of the canvas: cytoscape clears its own container on destroy().
    this.container.parentElement?.appendChild(this.overlay);

    // Right-click drives the context menu, so suppress the native one.
    this.container.addEventListener("contextmenu", (event) => event.preventDefault());

    // Shift+drag draws the folder rectangle straight away, without arming the tool
    // first. Capture phase and stopPropagation, or cytoscape pans the canvas instead.
    this.container.addEventListener(
      "mousedown",
      (event) => {
        if (!event.shiftKey || event.button !== 0 || this.lasso || this.draftSource) return;
        event.stopPropagation();
        this.beginMarquee(event);
      },
      true,
    );
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (this.draftSource) this.cancelDraft();
      if (this.lasso) this.cancelGroup();
    });
  }

  /**
   * (Re)draws the graph. `active` gets a ring, as the current note does in Obsidian.
   *
   * A first draw builds the instance and solves it; later draws patch the live graph
   * (`sync`) so an edit never re-solves and moves everything the user has arranged.
   */
  render(docs: Doc[], active: string | null, described: ReadonlySet<string> = new Set()): void {
    // Every layout derives its bounding box from the container, so a build while
    // the container is unsized collapses the whole graph onto one point. Wait for
    // real dimensions instead.
    if (!this.hasSize()) {
      this.pending = { docs, active, described };
      this.watchForSize();
      return;
    }
    // The solver only runs on the first build and on explicit Re-layout —
    // re-solving on every edit would throw the whole graph around.
    if (this.cy) this.sync(docs, active, described);
    else this.build(docs, active, described);
  }

  /**
   * Brings the live graph in line with the files: drops what's gone, adds what's
   * new, leaves every existing node exactly where the user left it.
   */
  private sync(docs: Doc[], active: string | null, described: ReadonlySet<string>): void {
    const cy = this.cy;
    if (!cy) return;
    const defs = buildElements(docs, described);
    const nodeDefs = defs.filter((def) => !def.data.source);
    const edgeDefs = defs.filter((def) => def.data.source);
    const wantNodes = new Set(nodeDefs.map((def) => def.data.id as string));
    const wantEdges = new Set(edgeDefs.map((def) => def.data.id as string));

    cy.batch(() => {
      cy.nodes().forEach((node) => {
        const nodeId = node.id();
        if (isAnchor(nodeId) || nodeId === DRAFT_NODE) return;
        if (!wantNodes.has(nodeId)) node.remove();
      });
      cy.edges().forEach((edge) => {
        if (edge.id() === DRAFT_EDGE) return;
        if (!wantEdges.has(edge.id())) edge.remove();
      });
      // Folder boxes first, so a new note can attach to its parent.
      for (const pass of ["dir", "file"] as const) {
        for (const def of nodeDefs) {
          const nodeId = def.data.id as string;
          if (def.data.kind !== pass) continue;
          const live = cy.getElementById(nodeId);
          if (live.nonempty()) {
            // Editing a note's tags or its backlinks has to recolour and resize it now,
            // not wait for the next full rebuild.
            const { id, parent, ...rest } = def.data;
            void id;
            void parent;
            for (const [key, value] of Object.entries(rest)) live.data(key, value);
            continue;
          }
          const parent = def.data.parent as string | undefined;
          const carried = this.carried.get(nodeId);
          this.carried.delete(nodeId);
          // freeSpot, not insideFrame: a note moved in from the tree has no dropped
          // position to reuse, and landing exactly on top of a sibling reads as a no-op.
          cy.add({ ...def, position: carried ?? this.freeSpot(parent, this.spawnPoint(parent)) });
        }
      }
      for (const def of edgeDefs) {
        const existing = cy.getElementById(def.data.id as string);
        if (existing.empty()) {
          cy.add(def);
          continue;
        }
        // An edge that is already drawn still has to track its relation name: editing
        // `built with:: [[X]]` in the markdown must move the label on the line, not wait
        // for a full rebuild. Its note appearing (or being deleted) counts the same way.
        const label = def.data.label as string | undefined;
        if (label) existing.data("label", label);
        else existing.removeData("label");
        if (def.data.described) existing.data("described", 1);
        else existing.removeData("described");
      }
    });

    ensureFrames(cy, this.frames); // frame only folders that gained a box
    this.applyBoxVisibility();
    this.markActive(active);
    this.drawOverlay();
    this.capture(); // notes added, moved or deleted since the cache was written
  }

  /**
   * Remembers where a note's node sits so a rename or a move can reuse it —
   * the id is the path, so those operations are a remove plus an add.
   */
  carryPosition(fromPath: string, toPath: string): void {
    const node = this.cy?.getElementById(fromPath);
    if (node && node.nonempty()) this.carried.set(toPath, { ...node.position() });
  }

  /** Where a node with no remembered position should appear. */
  private spawnPoint(parent?: string): cytoscape.Position {
    const cy = this.cy;
    if (!cy) return { x: 0, y: 0 };
    if (parent) {
      const centre = frameCentre(cy, parent);
      if (centre) return centre;
    }
    const view = cy.extent();
    return { x: (view.x1 + view.x2) / 2, y: (view.y1 + view.y2) / 2 };
  }

  private hasSize(): boolean {
    return this.container.clientWidth > 0 && this.container.clientHeight > 0;
  }

  private watchForSize(): void {
    if (this.sizeWatcher) return;
    this.sizeWatcher = new ResizeObserver(() => {
      if (!this.pending || !this.hasSize()) return;
      const { docs, active, described } = this.pending;
      this.pending = null;
      this.sizeWatcher?.disconnect();
      this.sizeWatcher = null;
      this.build(docs, active, described);
    });
    this.sizeWatcher.observe(this.container);
  }

  private build(docs: Doc[], active: string | null, described: ReadonlySet<string>): void {
    this.cy?.destroy();
    this.cy = cytoscape({
      container: this.container,
      elements: buildElements(docs, described),
      style: STYLE,
      layout: LAYOUT,
      wheelSensitivity: 0.2,
      // Nothing consumes cytoscape's own selection, and its shift+drag box would
      // fight the group tool's rectangle.
      boxSelectionEnabled: false,
    });
    this.wire(this.cy);
    // A cached arrangement is restored as-is. Re-solving on every start is what made
    // the graph feel like it forgot everything the moment the app closed.
    if (this.spatial.hasLayout()) this.restore(this.cy);
    else this.settle(); // solved straight away — there is no simulation to wait for
    this.markActive(active);
  }

  /**
   * Puts every note back where it was left. Notes added since the cache was written
   * have nowhere to go back to, so they are slotted into a free spot in their folder —
   * one new note must not rearrange the ones already placed.
   */
  private restore(cy: Core): void {
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        if (isAnchor(node.id()) || node.isParent()) return;
        const at = this.spatial.node(node.id());
        if (at) node.position(at);
      });
      // Frames second: size AND centre come from the cache. Falling back to the notes'
      // own centre is only for a box the cache has never seen.
      cy.nodes(":parent").forEach((node) => {
        const box = node as NodeSingular;
        if (isAnchor(box.id())) return;
        const saved = this.spatial.frame(box.id());
        const centre =
          saved && saved.x !== undefined && saved.y !== undefined
            ? { x: saved.x, y: saved.y }
            : centreOf(box);
        setFrame(cy, box.id(), centre, this.frames.get(box.id()), false);
      });
      cy.nodes().forEach((node) => {
        if (isAnchor(node.id()) || node.isParent() || this.spatial.node(node.id())) return;
        const parent = node.parent().first();
        const folder = parent.nonempty() ? parent.id() : undefined;
        node.position(this.freeSpot(folder, this.spawnPoint(folder)));
      });
    });
    this.applyBoxVisibility();
    this.fit();
    this.drawOverlay();
  }

  /** Frames go on only once the layout has placed the notes. */
  private settle(): void {
    if (!this.cy) return;
    layoutGraph(this.cy, this.frames);
    this.applyBoxVisibility();
    this.fit();
    this.drawOverlay();
    this.capture(); // the solved arrangement is the one to remember
  }

  /** Hands the current positions to the cache; it decides whether that is a change. */
  private capture(): void {
    const cy = this.cy;
    if (!cy) return;
    const at: Array<[string, cytoscape.Position]> = [];
    cy.nodes().forEach((node) => {
      if (isAnchor(node.id()) || node.isParent()) return;
      at.push([node.id(), { ...node.position() }]);
    });
    this.spatial.takeNodes(at);
    cy.nodes(":parent").forEach((node) => {
      const box = node as NodeSingular;
      if (isAnchor(box.id())) return;
      const centre = frameCentre(cy, box.id());
      if (!centre) return;
      const size = this.frames.get(box.id());
      this.spatial.setFrame(box.id(), {
        w: size.w,
        h: size.h,
        user: this.frames.isPinned(box.id()),
        x: centre.x,
        y: centre.y,
      });
    });
  }

  /** Whether folder boxes are currently drawn. */
  boxesShown(): boolean {
    return this.boxesVisible;
  }

  /** Shows or hides the folder boxes. Grouping and positions are untouched. */
  setBoxesVisible(visible: boolean): void {
    this.boxesVisible = visible;
    localStorage.setItem(BOXES_KEY, visible ? "on" : "off");
    this.applyBoxVisibility();
    this.drawOverlay();
  }

  private applyBoxVisibility(): void {
    if (!this.cy) return;
    this.cy
      .nodes(":parent")
      .filter((node) => !isAnchor(node.id()))
      .toggleClass("box-hidden", !this.boxesVisible);
  }

  /**
   * Marks whatever the open tab is showing. That is usually a note, and so a node — but a
   * connection note belongs to an edge, and edges are keyed by their endpoints rather than
   * by the file's path, so the match is made by asking each edge what its note is called.
   */
  markActive(active: string | null): void {
    if (!this.cy) return;
    this.cy.elements(".active").removeClass("active");
    if (!active) return;
    if (isEdgeNote(active)) {
      this.edgeFor(active)?.addClass("active");
      return;
    }
    this.cy.getElementById(active).addClass("active");
  }

  /** The edge a connection note describes, if both its ends are still on the graph. */
  private edgeFor(notePath: string): EdgeSingular | null {
    const found = this.cy
      ?.edges()
      .filter((edge) => edgeNotePath(edge.source().id(), edge.target().id()) === notePath);
    return found?.nonempty() ? (found.first() as EdgeSingular) : null;
  }

  /**
   * Thickens an edge the moment its note is written, so drawing a connection and describing
   * it reads as one gesture instead of waiting for the next rebuild to catch up.
   */
  setEdgeDescribed(source: string, target: string): void {
    const edge = this.cy?.getElementById(edgeId(source, target));
    if (edge && edge.nonempty()) edge.data("described", 1);
  }

  /**
   * Cytoscape needs a nudge after the container becomes visible.
   *
   * Re-framing on every tab switch is disorienting, so this only re-fits when the container is a
   * DIFFERENT size than the one the view was framed at and the user has not moved the view since.
   * That is the case that used to leave the graph half off-screen: the instance is built (and
   * fitted) the moment the container first has size, then the surrounding layout settles to its real
   * dimensions and nothing ever re-framed — right-clicks then miss nodes that are outside the
   * viewport entirely.
   */
  resize(): void {
    if (!this.cy) return;
    this.cy.resize();
    const size = { w: this.cy.width(), h: this.cy.height() };
    const stale = !this.fittedSize || this.fittedSize.w !== size.w || this.fittedSize.h !== size.h;
    if (stale && !this.userMoved) this.fit();
    this.drawOverlay();
  }

  /** Frames the whole graph. Counts as "the view is where it should be", not as a user move. */
  fit(): void {
    const cy = this.cy;
    if (!cy || cy.elements().empty()) return;
    this.fitting = true;
    cy.fit(undefined, 40);
    this.fitting = false;
    this.fittedSize = { w: cy.width(), h: cy.height() };
    this.userMoved = false;
  }

  /** Re-solves the whole arrangement from scratch — deterministic, so it lands the same way twice. */
  relayout(): void {
    if (!this.cy) return;
    removeAnchors(this.cy); // the solver must not see the frame corners
    this.settle();
  }

  private wire(cy: Core): void {
    cy.on("tap", "node", (event) => {
      const node = event.target as NodeSingular;
      if (this.draftSource) {
        this.finishDraftOnNode(node);
        return;
      }
      if (node.data("kind") === "file") this.handlers.onOpen(node.id());
    });

    // A note says what the thing is; the line between two notes says how they are wired
    // together. Clicking it opens that file — and writes it first if there isn't one yet.
    cy.on("tap", "edge", (event) => {
      if (this.draftSource) return; // a link is being drawn; the release belongs to that
      const edge = event.target as EdgeSingular;
      const label = (edge.data("label") as string | undefined) ?? null;
      this.handlers.onOpenEdge(edge.source().id(), edge.target().id(), label);
    });

    cy.on("tap", (event) => {
      if (event.target !== cy) return; // background only
      if (this.draftSource) {
        const source = this.draftSource;
        const at = { ...event.position };
        const folder = this.enclosingFolder(cy, at);
        this.clearDraft();
        this.handlers.onLinkNew(source, at, folder);
        return;
      }
      // Nothing else: a stray click on the canvas must not litter the vault.
    });

    // One right-click gesture; the menu's contents depend on what is under it.
    cy.on("cxttap", (event) => {
      if (this.draftSource) {
        this.cancelDraft();
        return;
      }
      const client = clientPoint(event);
      const node = event.target === cy ? null : (event.target as NodeSingular);
      if (node && node.data("kind") === "file") this.handlers.onNodeMenu(node.id(), client);
      else {
        const folder =
          node && node.data("kind") === "dir" ? node.id() : this.enclosingFolder(cy, event.position);
        this.handlers.onCanvasMenu({ ...event.position }, client, folder);
      }
    });

    // Keep the arrow's tip under the cursor while a link is being drawn.
    cy.on("mousemove", (event) => {
      if (!this.draftSource) return;
      cy.getElementById(DRAFT_NODE).position(event.position);
    });

    cy.on("mouseover", "node", (event) => {
      const node = event.target as NodeSingular;
      if (this.draftSource || node.data("kind") !== "file") return;
      const neighborhood = node.closedNeighborhood();
      cy.elements().difference(neighborhood).addClass("faded");
      neighborhood.edges().addClass("highlight");
    });
    cy.on("mouseout", "node", () => {
      if (this.draftSource) return;
      cy.elements().removeClass("faded").removeClass("highlight");
    });

    // Nothing on the line itself says it can be opened, so the status bar says it.
    cy.on("mouseover", "edge", (event) => {
      if (this.draftSource || this.drag) return;
      const edge = event.target as EdgeSingular;
      const title = edgeTitle(edge.source().id(), edge.target().id());
      this.handlers.onHint(
        edge.data("described") ? `Open "${title}"` : `Click to describe the flow: ${title}`,
      );
    });
    cy.on("mouseout", "edge", () => {
      if (this.draftSource || this.drag) return;
      this.handlers.onHint(null);
    });

    /* --- dragging notes between folders, with resistance at every border --- */

    cy.on("grab", "node", (event) => {
      const node = event.target as NodeSingular;
      if (node.data("kind") !== "file") return;
      const parent = node.parent().first();
      this.drag = { path: node.id(), parent: parent.nonempty() ? parent.id() : null, target: null, armed: false };
    });

    cy.on("drag", "node", (event) => {
      if (!this.drag) return;
      const node = event.target as NodeSingular;
      if (node.id() !== this.drag.path) return;
      // The pointer is the source of truth: the node gets pinned below the
      // threshold, so reading its own position would feed back on itself.
      this.trackDrag(cy, node, event.position);
    });

    cy.on("free", "node", () => {
      const drag = this.drag;
      this.drag = null;
      this.clearDropMarks(cy);
      this.capture(); // wherever it was let go of is where it should be next time
      if (!drag) return;
      if (drag.armed && drag.target !== null && drag.target !== drag.parent) {
        this.handlers.onReparent(drag.path, drag.target);
      } else {
        this.handlers.onHint(null);
      }
      this.drawOverlay();
    });

    // Dragging a whole folder box carries its frame (and notes) along.
    cy.on("drag", "node:parent", () => this.drawOverlay());
    cy.on("pan zoom", () => {
      // A pan/zoom the app did itself (fit) must not count as the user taking over the view.
      if (!this.fitting) this.userMoved = true;
      this.drawOverlay();
      this.followRename();
      this.followConnection();
    });
  }

  /**
   * Resolves where a dragged note is heading and applies the resistance:
   * inside its own folder it is simply clamped; pushing at a border pins it to
   * the rim until `DROP_DEPTH` is exceeded, then arms the move.
   */
  private trackDrag(cy: Core, node: NodeSingular, pointer: cytoscape.Position): void {
    const drag = this.drag;
    if (!drag) return;
    this.clearDropMarks(cy);

    const entering = this.folderAt(cy, pointer, drag.parent);
    if (entering) {
      const bb = entering.boundingBox();
      const depth = Math.min(pointer.x - bb.x1, bb.x2 - pointer.x, pointer.y - bb.y1, bb.y2 - pointer.y);
      drag.target = entering.id();
      drag.armed = depth >= DROP_DEPTH;
      if (drag.armed) {
        entering.addClass("drop-armed");
        this.handlers.onHint(`Release to move ${basename(drag.path)} into ${entering.id()}`);
      } else {
        entering.addClass("drop-hover");
        node.position(rimPoint(pointer, bb));
        this.handlers.onHint(`Keep pushing to file ${basename(drag.path)} under ${entering.id()}`);
      }
      return;
    }

    if (drag.parent === null) {
      drag.target = null;
      drag.armed = false;
      this.handlers.onHint(null);
      return;
    }

    // Still inside its own folder, or pulling out of it.
    const box = cy.getElementById(drag.parent) as NodeSingular;
    const centre = frameCentre(cy, drag.parent) ?? box.position();
    // Notes are clamped to the interior, but the *threshold* is the visible
    // border — otherwise resistance would start well inside the box.
    const rect = interior(centre, this.frames.get(drag.parent), node.width() / 2);
    const bb = box.boundingBox();
    const outside = Math.max(bb.x1 - pointer.x, pointer.x - bb.x2, bb.y1 - pointer.y, pointer.y - bb.y2);

    if (outside <= 0) {
      node.position(clampInto(pointer, rect)); // free movement within the frame
      drag.target = null;
      drag.armed = false;
      this.handlers.onHint(null);
      return;
    }

    const destination = dirname(drag.parent); // "" == vault root
    drag.target = destination;
    drag.armed = outside >= DROP_DEPTH;
    box.addClass(drag.armed ? "drop-armed" : "drop-leaving");
    if (drag.armed) {
      this.handlers.onHint(`Release to move ${basename(drag.path)} out to ${destination || "the vault root"}`);
    } else {
      node.position(clampInto(pointer, rect)); // held at the frame's edge
      this.handlers.onHint(`Keep pulling to move ${basename(drag.path)} out of ${drag.parent}`);
    }
  }

  /**
   * Folder whose box encloses `point`, by geometry rather than hit-testing:
   * cytoscape only registers taps on a compound parent's thin padding band, so
   * a click in the middle of a big box otherwise reads as empty canvas.
   */
  private enclosingFolder(cy: Core, point: cytoscape.Position): string | null {
    if (!this.boxesVisible) return null;
    return this.folderAt(cy, point, null)?.id() ?? null;
  }

  /** Deepest folder box containing `point`, ignoring the node's current folder. */
  private folderAt(cy: Core, point: cytoscape.Position, exclude: string | null): NodeSingular | null {
    let best: NodeSingular | null = null;
    cy.nodes(":parent").forEach((box) => {
      if (box.id() === exclude || isAnchor(box.id())) return;
      const bb = box.boundingBox();
      if (point.x < bb.x1 || point.x > bb.x2 || point.y < bb.y1 || point.y > bb.y2) return;
      // Deeper folders win, so nested boxes are reachable.
      if (!best || box.ancestors().length > best.ancestors().length) best = box as NodeSingular;
    });
    return best;
  }

  private clearDropMarks(cy: Core): void {
    cy.nodes(".drop-hover, .drop-armed, .drop-leaving")
      .removeClass("drop-hover")
      .removeClass("drop-armed")
      .removeClass("drop-leaving");
  }

  /* ------------------------------------------------------------ group tool --- */

  /**
   * Arms the rectangle tool. A folder with nothing in it has no box on the graph —
   * boxes are derived from the notes they hold — so a folder is made by drawing a
   * rectangle round the notes that should be in it, not by making an empty one first.
   *
   * The drag has to be taken off cytoscape (it would pan), so an armed tool lays a
   * transparent sheet over the canvas and reads the gesture from there.
   */
  startGroup(): void {
    if (!this.cy || this.lasso) return;
    const sheet = document.createElement("div");
    sheet.className = "lasso-sheet";
    sheet.addEventListener("mousedown", (event) => this.beginMarquee(event));
    this.overlay.appendChild(sheet);
    this.lasso = sheet;
    this.handlers.onHint(
      "Drag a rectangle around the notes to put them in a new folder — Esc to cancel (shift+drag does this any time)",
    );
  }

  cancelGroup(): void {
    this.lasso?.remove();
    this.lasso = null;
    this.handlers.onHint(null);
  }

  grouping(): boolean {
    return this.lasso !== null;
  }

  private beginMarquee(event: MouseEvent): void {
    const cy = this.cy;
    if (!cy) return;
    event.preventDefault();
    const container = this.container.getBoundingClientRect();
    const from = { x: event.clientX - container.left, y: event.clientY - container.top };
    const rect = document.createElement("div");
    rect.className = "lasso-rect";
    this.overlay.appendChild(rect);

    const place = (to: { x: number; y: number }): Area => {
      const area = {
        x1: Math.min(from.x, to.x),
        y1: Math.min(from.y, to.y),
        x2: Math.max(from.x, to.x),
        y2: Math.max(from.y, to.y),
      };
      rect.style.left = `${area.x1}px`;
      rect.style.top = `${area.y1}px`;
      rect.style.width = `${area.x2 - area.x1}px`;
      rect.style.height = `${area.y2 - area.y1}px`;
      return area;
    };
    let area = place(from);

    const onMove = (move: MouseEvent): void => {
      area = place({ x: move.clientX - container.left, y: move.clientY - container.top });
      const count = this.notesIn(area).length;
      this.handlers.onHint(count === 1 ? "1 note — release to group it" : `${count} notes — release to group them`);
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      rect.remove();
      const paths = this.notesIn(area);
      this.cancelGroup();
      if (!paths.length) {
        this.handlers.onHint("no notes in that rectangle — nothing grouped");
        return;
      }
      const zoom = cy.zoom();
      this.handlers.onGroup(paths, {
        w: Math.max(160, (area.x2 - area.x1) / zoom),
        h: Math.max(120, (area.y2 - area.y1) / zoom),
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  /** Notes whose centre falls inside a rectangle, in rendered (screen) coordinates. */
  private notesIn(area: Area): string[] {
    const cy = this.cy;
    if (!cy) return [];
    return cy
      .nodes()
      .filter((node) => node.data("kind") === "file" && !isAnchor(node.id()))
      .filter((node) => {
        const at = (node as NodeSingular).renderedPosition();
        return at.x >= area.x1 && at.x <= area.x2 && at.y >= area.y1 && at.y <= area.y2;
      })
      .map((node) => node.id());
  }

  /** Sizes a folder's box before it first appears — used to box a group as drawn. */
  presetFrame(folder: string, frame: Frame): void {
    this.frames.set(folder, frame);
  }

  /** Frames are keyed by path, so a renamed folder has to be handed its size. */
  carryFrame(from: string, to: string): void {
    this.frames.set(to, this.frames.get(from), this.frames.isPinned(from));
  }

  /**
   * Holds every position under `from` for the same node under `to`. Renaming a folder
   * changes the id of everything in it, and without this the whole box re-scatters.
   */
  carrySubtree(from: string, to: string): void {
    this.cy?.nodes().forEach((node) => {
      const id = node.id();
      if (isAnchor(id) || !id.startsWith(from + "/")) return;
      this.carried.set(to + id.slice(from.length), { ...node.position() });
    });
  }

  /* --------------------------------------------------- frame resize handles --- */

  /** Everything the app itself paints above the canvas, in one pass. */
  private drawOverlay(): void {
    this.drawHandles();
    this.placeStickies();
  }

  /* --------------------------------------------------------------- stickies --- */

  /** Right-click → "New sticky": drop one where the click was and start typing. */
  addSticky(at: cytoscape.Position): void {
    const sticky = this.stickies.add(at);
    this.placeStickies();
    const field = this.stickyEls.get(sticky.id)?.querySelector("textarea");
    field?.focus();
  }

  /**
   * Stickies live in model space, so they pan and zoom with the graph rather than
   * floating over it. Everything — size, padding, type — is scaled by the zoom, which
   * is what makes a sticky feel pinned to the canvas instead of to the window.
   */
  private placeStickies(): void {
    const cy = this.cy;
    if (!cy) return;
    const zoom = cy.zoom();
    const pan = cy.pan();
    const alive = new Set<string>();

    for (const sticky of this.stickies.all()) {
      alive.add(sticky.id);
      let el = this.stickyEls.get(sticky.id);
      if (!el) el = this.buildSticky(sticky);
      el.style.left = `${sticky.x * zoom + pan.x}px`;
      el.style.top = `${sticky.y * zoom + pan.y}px`;
      el.style.width = `${sticky.w * zoom}px`;
      el.style.height = `${sticky.h * zoom}px`;
      el.style.fontSize = `${13 * zoom}px`;
    }
    for (const [id, el] of this.stickyEls) {
      if (alive.has(id)) continue;
      el.remove();
      this.stickyEls.delete(id);
    }
  }

  private buildSticky(sticky: Sticky): HTMLElement {
    const el = document.createElement("div");
    el.className = "sticky";
    el.innerHTML =
      `<div class="sticky-bar" title="Drag to move"></div>` +
      `<textarea class="sticky-text" spellcheck="false" placeholder="note to self…"></textarea>` +
      `<div class="sticky-grip" title="Drag to resize"></div>`;
    const field = el.querySelector<HTMLTextAreaElement>(".sticky-text")!;
    field.value = sticky.text;

    field.addEventListener("input", () => {
      this.stickies.update(sticky.id, { text: field.value });
      this.growToFit(sticky.id, field);
    });
    // An empty sticky is one you changed your mind about; it clears itself away.
    field.addEventListener("blur", () => {
      if (field.value.trim()) return;
      this.stickies.remove(sticky.id);
      this.placeStickies();
    });
    // Typing must not reach the graph's own Escape / delete handling.
    field.addEventListener("keydown", (event) => event.stopPropagation());

    // The padding around the text is the drag area; the corner is the resize grip.
    el.addEventListener("mousedown", (event) => {
      if (event.target === field) return;
      event.preventDefault();
      event.stopPropagation();
      const grip = (event.target as HTMLElement).classList.contains("sticky-grip");
      this.dragSticky(sticky.id, event, grip ? "size" : "move");
    });

    this.overlay.appendChild(el);
    this.stickyEls.set(sticky.id, el);
    return el;
  }

  /** Grows a sticky's height so typed lines are never hidden behind its own edge. */
  private growToFit(id: string, field: HTMLTextAreaElement): void {
    const cy = this.cy;
    if (!cy) return;
    const zoom = cy.zoom();
    const el = this.stickyEls.get(id);
    if (!el) return;
    // scrollHeight is screen pixels at the current zoom; the model needs it unscaled.
    const chrome = (el.clientHeight - field.clientHeight) / zoom;
    const needed = field.scrollHeight / zoom + chrome;
    const held = this.stickies.all().find((s) => s.id === id);
    if (!held || needed <= held.h) return;
    this.stickies.update(id, { h: needed });
    this.placeStickies();
  }

  private dragSticky(id: string, event: MouseEvent, mode: "move" | "size"): void {
    const cy = this.cy;
    if (!cy) return;
    const zoom = cy.zoom();
    const start = { x: event.clientX, y: event.clientY };
    const from = this.stickies.all().find((s) => s.id === id);
    if (!from) return;

    const onMove = (move: MouseEvent): void => {
      const dx = (move.clientX - start.x) / zoom;
      const dy = (move.clientY - start.y) / zoom;
      if (mode === "move") this.stickies.update(id, { x: from.x + dx, y: from.y + dy });
      else this.stickies.update(id, { w: Math.max(90, from.w + dx), h: Math.max(44, from.h + dy) });
      this.placeStickies();
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  /**
   * A grip on each of a box's four corners — invisible, so nothing is drawn on the
   * canvas; the cursor changing on approach is the whole affordance.
   */
  private drawHandles(): void {
    const cy = this.cy;
    if (!cy) return;
    const wanted = new Set<string>();
    if (this.boxesVisible) cy.nodes(":parent").forEach((node) => {
      const box = node as NodeSingular;
      if (isAnchor(box.id())) return;
      const bb = box.renderedBoundingBox();
      for (const corner of CORNERS) {
        const key = `${box.id()} ${corner.sx}${corner.sy}`;
        wanted.add(key);
        let handle = this.handles.get(key);
        if (!handle) {
          handle = document.createElement("div");
          handle.className = "frame-handle";
          handle.style.cursor = corner.cursor;
          handle.title = `Resize "${box.id()}"`;
          handle.addEventListener("mousedown", (event) => this.beginResize(event, box.id(), corner));
          this.overlay.appendChild(handle);
          this.handles.set(key, handle);
        }
        handle.style.left = `${corner.sx < 0 ? bb.x1 : bb.x2}px`;
        handle.style.top = `${corner.sy < 0 ? bb.y1 : bb.y2}px`;
      }
    });
    for (const [key, handle] of this.handles) {
      if (wanted.has(key)) continue;
      handle.remove();
      this.handles.delete(key);
    }
  }

  private beginResize(event: MouseEvent, folder: string, corner: Corner): void {
    const cy = this.cy;
    if (!cy) return;
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY };
    const from = this.frames.get(folder);
    const zoom = cy.zoom();

    const from0 = frameCentre(cy, folder);
    if (!from0) return;
    // Notes ride along with the frame: their offsets from the centre scale with
    // it, so shrinking the box packs them in rather than piling them on the rim.
    const box = cy.getElementById(folder) as NodeSingular;
    const riders = box
      .children()
      .filter((child) => !isAnchor(child.id()))
      .map((child) => {
        const kid = child as NodeSingular;
        return { id: kid.id(), dx: kid.position("x") - from0.x, dy: kid.position("y") - from0.y };
      });

    const onMove = (move: MouseEvent): void => {
      // Signed by which corner is held: dragging the left edge leftwards widens the
      // box just as dragging the right edge rightwards does.
      const dx = ((move.clientX - start.x) / zoom) * corner.sx;
      const dy = ((move.clientY - start.y) / zoom) * corner.sy;
      const next: Frame = { w: Math.max(140, from.w + dx), h: Math.max(110, from.h + dy) };
      // Shifting the centre by half the growth pins the opposite corner, so the
      // dragged corner is the only one that follows the cursor.
      const centre = {
        x: from0.x + ((next.w - from.w) / 2) * corner.sx,
        y: from0.y + ((next.h - from.h) / 2) * corner.sy,
      };
      const scaleX = next.w / from.w;
      const scaleY = next.h / from.h;
      cy.batch(() => {
        for (const rider of riders) {
          cy.getElementById(rider.id).position({
            x: centre.x + rider.dx * scaleX,
            y: centre.y + rider.dy * scaleY,
          });
        }
      });
      this.frames.set(folder, next, true); // dragging a corner pins the size
      setFrame(cy, folder, centre, next); // also clamps, as a backstop
      this.drawOverlay();
      this.handlers.onHint(`${folder}: ${Math.round(next.w)} × ${Math.round(next.h)}`);
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      this.handlers.onHint(null);
      this.capture(); // the riders moved with the frame
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  /* ---------------------------------------------------------- inline rename --- */

  /**
   * Opens a name field directly on a node, pre-selected. `onSettled` fires either way — with the
   * typed name, or `null` when the field was dismissed unchanged — because callers chain further
   * steps onto it (naming a connection next) and a cancelled rename must not strand them.
   */
  renameNode(path: string, onSettled: (name: string | null) => void): void {
    const cy = this.cy;
    if (!cy) return;
    const node = cy.getElementById(path);
    if (node.empty()) return;
    this.rename?.editor.close();
    const at = node.renderedPosition();
    let settled = false;
    const done = (name: string | null): void => {
      if (settled) return;
      settled = true;
      this.rename = null;
      onSettled(name);
    };
    const editor = inlineEdit(
      this.overlay,
      { left: at.x, top: at.y },
      noteName(path),
      (value) => done(value),
      () => {
        this.handlers.onHint(null);
        done(null);
      },
    );
    this.rename = { path, editor };
  }

  /** Keeps an open rename field on its node while the viewport moves. */
  private followRename(): void {
    if (!this.rename || !this.cy) return;
    const node = this.cy.getElementById(this.rename.path);
    if (node.empty()) return;
    const at = node.renderedPosition();
    this.rename.editor.move(at.x, at.y);
  }

  /** Public entry for the context menu's "link to another note" action. */
  startLink(path: string): void {
    const node = this.cy?.getElementById(path);
    if (node && node.nonempty()) this.startDraft(node as NodeSingular);
  }

  /* ------------------------------------------------------------ link draft --- */

  private startDraft(source: NodeSingular): void {
    if (!this.cy) return;
    this.cy.elements().removeClass("faded").removeClass("highlight");
    this.draftSource = source.id();
    source.addClass("draft-source");
    this.cy.add([
      {
        group: "nodes",
        data: { id: DRAFT_NODE, kind: "draft" },
        position: { ...source.position() },
        selectable: false,
        grabbable: false,
        classes: "draft",
      },
      {
        group: "edges",
        data: { id: DRAFT_EDGE, source: source.id(), target: DRAFT_NODE },
        classes: "draft",
      },
    ]);
    this.handlers.onHint("Click a note to link to it, or empty space to create one — Esc cancels");
  }

  private finishDraftOnNode(node: NodeSingular): void {
    const source = this.draftSource;
    this.clearDraft();
    if (!source) return;
    // Folder boxes and self-links are not valid targets.
    if (node.data("kind") !== "file" || node.id() === source) return;
    this.handlers.onLinkExisting(source, node.id());
  }

  private cancelDraft(): void {
    this.clearDraft();
    this.handlers.onHint(null);
  }

  private clearDraft(): void {
    if (!this.cy) return;
    this.cy.nodes(".draft-source").removeClass("draft-source");
    this.cy.getElementById(DRAFT_EDGE).remove();
    this.cy.getElementById(DRAFT_NODE).remove();
    this.draftSource = null;
  }

  /**
   * Second step of drawing a link: name the connection, with the field on the line itself.
   *
   * The edge is already drawn when this opens, so the user is labelling something they can see.
   * Leaving it empty (Esc, or clicking away without typing) keeps the link unnamed — a plain
   * `[[Target]]` — which is why cancelling still reports through `onDone`.
   */
  promptConnection(source: string, target: string, onDone: (label: string | null) => void): void {
    const cy = this.cy;
    if (!cy) return;
    const edge = cy.getElementById(edgeId(source, target));
    const a = cy.getElementById(source);
    const b = cy.getElementById(target);
    if (a.empty() || b.empty()) {
      onDone(null);
      return;
    }
    // Midpoint of the drawn edge when it exists (bezier control point included), else of the pair.
    const at = edge.nonempty()
      ? edge.renderedMidpoint()
      : {
          x: ((a as NodeSingular).renderedPosition().x + (b as NodeSingular).renderedPosition().x) / 2,
          y: ((a as NodeSingular).renderedPosition().y + (b as NodeSingular).renderedPosition().y) / 2,
        };
    this.rename?.editor.close();
    let settled = false;
    const done = (label: string | null): void => {
      if (settled) return;
      settled = true;
      this.connection = null;
      this.handlers.onHint(null);
      onDone(label);
    };
    const editor = inlineEdit(
      this.overlay,
      { left: at.x, top: at.y },
      "",
      (value) => done(value.trim() || null),
      () => done(null),
    );
    this.connection = { source, target, editor };
    this.handlers.onHint("Name this connection — Enter to keep it, Esc to leave the link unnamed");
  }

  /** Writes a relation name onto the live edge, so it shows without a rebuild. */
  setEdgeLabel(source: string, target: string, label: string | null): void {
    const edge = this.cy?.getElementById(edgeId(source, target));
    if (!edge || edge.empty()) return;
    if (label) edge.data("label", label);
    else edge.removeData("label");
  }

  /** Keeps an open connection field on its edge while the viewport moves. */
  private followConnection(): void {
    if (!this.connection || !this.cy) return;
    const edge = this.cy.getElementById(edgeId(this.connection.source, this.connection.target));
    if (edge.empty()) return;
    const at = edge.renderedMidpoint();
    this.connection.editor.move(at.x, at.y);
  }

  /** Adds a standalone note's node where it was spawned, without a relayout. */
  commitNode(path: string, label: string, parent: string | undefined, at: cytoscape.Position): void {
    if (!this.cy || this.cy.getElementById(path).nonempty()) return;
    this.cy.add({
      group: "nodes",
      // Nothing links to it yet; the next rebuild sizes it from its real backlinks.
      data: { id: path, label, parent, kind: "file", size: nodeSize(0) },
      position: this.freeSpot(parent, at),
    });
    this.handlers.onHint(null);
    this.drawOverlay();
  }

  /** A note dropped in a folder must land within the frame, never widen it. */
  private insideFrame(folder: string | undefined, at: cytoscape.Position): cytoscape.Position {
    if (!folder || !this.cy) return at;
    const centre = frameCentre(this.cy, folder);
    return centre ? clampInto(at, interior(centre, this.frames.get(folder))) : at;
  }

  /**
   * Nearest spot to `at` that does not sit on top of an existing note. A new node dropped exactly
   * over another one reads as "nothing happened" — and the layout is only re-solved on Re-layout,
   * so it would stay buried. Spirals outwards, then clamps back into the frame.
   */
  private freeSpot(folder: string | undefined, at: cytoscape.Position): cytoscape.Position {
    const cy = this.cy;
    if (!cy) return at;
    const others = cy
      .nodes()
      .filter((node) => !node.isParent() && !isAnchor(node.id()) && node.id() !== DRAFT_NODE);
    const clear = (point: cytoscape.Position): boolean =>
      others.every((node) => {
        const bb = (node as NodeSingular).boundingBox({ includeLabels: false });
        const pad = 12;
        return (
          point.x < bb.x1 - pad || point.x > bb.x2 + pad || point.y < bb.y1 - pad || point.y > bb.y2 + pad
        );
      });

    const start = this.insideFrame(folder, at);
    if (clear(start)) return start;
    for (let ring = 1; ring <= 8; ring++) {
      const radius = ring * 34;
      for (let step = 0; step < 8; step++) {
        const angle = (step / 8) * Math.PI * 2 + ring * 0.4;
        const candidate = this.insideFrame(folder, {
          x: start.x + Math.cos(angle) * radius,
          y: start.y + Math.sin(angle) * radius,
        });
        if (clear(candidate)) return candidate;
      }
    }
    return start;
  }

  /**
   * Adds a link (and, for a brand-new note, its node at `at`) to the live graph
   * without re-running the layout, so drawing a link doesn't reshuffle everything.
   */
  commitLink(source: string, target: string, newNode?: { label: string; parent?: string; at: cytoscape.Position }): void {
    if (!this.cy) return;
    if (newNode && this.cy.getElementById(target).empty()) {
      this.cy.add({
        group: "nodes",
        data: { id: target, label: newNode.label, parent: newNode.parent, kind: "file", size: nodeSize(1) },
        position: this.freeSpot(newNode.parent, newNode.at),
      });
    }
    const id = edgeId(source, target);
    if (this.cy.getElementById(id).empty()) {
      this.cy.add({ group: "edges", data: { id, source, target } });
    }
    this.handlers.onHint(null);
  }
}
