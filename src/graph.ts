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
import { LinkResolver, parseActive, parseField, parseGhost, parseLinks, parseTags, parseType } from "./links";
import { ancestors, basename, dirname, noteName } from "./vault";
import type { SettingsStore } from "./settings";
import type { SpatialStore } from "./spatial";
import { type Sticky, type StickyStore } from "./sticky";
import {
  TICK_ORDER,
  isIssueDir,
  isIssuePath,
  parseIssue,
  writeIssue,
  type IssueDoc,
  type TickState,
} from "./linear";

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
 * A note's circle grows with how many connections it has — links to it AND links out of
 * it — so the hubs of a vault are obvious at a glance. Counting only inbound made a note
 * that gathers a subject together (an index, a map of content) look like a leaf, which is
 * the opposite of what it is. Square-rooted: the first couple of links count for a lot,
 * and a heavily connected note still fits inside its folder.
 */
const NODE_MIN = 20;
const NODE_MAX = 68;
export const nodeSize = (incoming: number): number =>
  Math.min(NODE_MAX, Math.round(NODE_MIN + 16 * Math.sqrt(incoming)));

/**
 * The Gemini app icon, drawn inline: a white rounded tile with the four-point
 * sparkle, red at the top fading through yellow and green into blue — an image,
 * because cytoscape cannot gradient-fill a node on its own.
 */
const GEMINI_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    // The explicit size matters twice over: without one the browser falls back to
    // 300x150, which `cover` then crops off-centre and re-crops at every zoom; and
    // it is the raster resolution, so 256 keeps the icon crisp zoomed well in.
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 64 64">` +
      `<defs>` +
      `<radialGradient id="r" cx="32" cy="5" r="36" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="#ff4641"/><stop offset="1" stop-color="#ff4641" stop-opacity="0"/></radialGradient>` +
      `<radialGradient id="y" cx="5" cy="32" r="36" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="#ffc300"/><stop offset="1" stop-color="#ffc300" stop-opacity="0"/></radialGradient>` +
      `<radialGradient id="g" cx="32" cy="59" r="36" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="#00a94f"/><stop offset="1" stop-color="#00a94f" stop-opacity="0"/></radialGradient>` +
      `<clipPath id="s"><path d="M32 6 C34.6 20.5 43.5 29.4 58 32 C43.5 34.6 34.6 43.5 32 58 C29.4 43.5 20.5 34.6 6 32 C20.5 29.4 29.4 20.5 32 6 Z"/></clipPath>` +
      `</defs>` +
      `<rect width="64" height="64" rx="14" fill="#ffffff"/>` +
      `<g clip-path="url(#s)">` +
      `<rect width="64" height="64" fill="#3086ff"/>` +
      `<rect width="64" height="64" fill="url(#r)"/>` +
      `<rect width="64" height="64" fill="url(#y)"/>` +
      `<rect width="64" height="64" fill="url(#g)"/>` +
      `</g>` +
      `</svg>`,
  );

/**
 * The Linear app icon: the near-black rounded tile — same silhouette the Gemini node
 * wears, so the two typed notes read as siblings — with the silvered disc on it, three
 * diagonal slices cut out towards its lower-left.
 *
 * Rebuilt as inline SVG rather than embedded as a bitmap: cytoscape needs a URI it can
 * raster at any zoom, the cuts have to show the tile through them, and the mark's sheen
 * is a gradient. The explicit 256px keeps it crisp zoomed well in.
 */
const LINEAR_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 64 64">` +
      `<defs>` +
      `<linearGradient id="tile" x1="32" y1="0" x2="32" y2="64" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="#313237"/><stop offset="1" stop-color="#131416"/>` +
      `</linearGradient>` +
      // Brightest at the top-right, falling away towards the corner the slices are cut
      // from — which is what leaves those slivers reading as silver rather than white.
      `<linearGradient id="mark" x1="47" y1="13" x2="15" y2="51" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#a5a9b2"/></linearGradient>` +
      `<mask id="cuts">` +
      `<circle cx="32" cy="32" r="20" fill="#fff"/>` +
      // Parallel to the disc's own diagonal, marching towards the bottom-left corner:
      // the circle's edge is what makes each remaining sliver shorter than the last.
      `<g stroke="#000" stroke-width="1.5">` +
      `<line x1="-2" y1="6" x2="58" y2="66"/>` +
      `<line x1="-6" y1="10" x2="54" y2="70"/>` +
      `<line x1="-10" y1="14" x2="50" y2="74"/>` +
      `</g>` +
      `</mask>` +
      `</defs>` +
      `<rect width="64" height="64" rx="14" fill="url(#tile)"/>` +
      // A hairline of light on the tile's own edge, or a black tile on a black canvas
      // has no silhouette at all.
      `<rect x="0.5" y="0.5" width="63" height="63" rx="13.5" fill="none" ` +
      `stroke="#ffffff" stroke-opacity="0.1"/>` +
      `<circle cx="32" cy="32" r="20" fill="url(#mark)" mask="url(#cuts)"/>` +
      `</svg>`,
  );

/**
 * The Claude app icon: the coral tile with the off-white burst. Traced off the app's own
 * icon rather than approximated — twelve round-capped spokes whose UNEVEN spacing is the
 * whole character of the mark (an evenly spaced one reads as a sparkle or a compass rose,
 * which is a different logo). Angles and reaches are measured, tile and burst colours are
 * the icon's own; the spokes meet in the middle, which is what fills the centre in.
 */
const CLAUDE_SPOKES: Array<[number, number]> = [
  [14.5, 23.7],
  [42.25, 24.1],
  [59, 23.3],
  [94, 23.9],
  [123.5, 24],
  [146, 23],
  [180.25, 24.2],
  [212.75, 24.5],
  [243, 26.1],
  [279, 23.1],
  [310.5, 23.8],
  [350.75, 23.2],
];

const CLAUDE_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    // Sized explicitly for the same two reasons the others are: no 300x150 fallback for
    // `cover` to crop, and 256px of raster to stay crisp zoomed in.
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 64 64">` +
      `<rect width="64" height="64" rx="14" fill="#da704d"/>` +
      `<g transform="translate(32 32)" stroke="#fefcfb" stroke-width="4" stroke-linecap="round">` +
      CLAUDE_SPOKES.map(([angle, reach]) => {
        const radians = (angle * Math.PI) / 180;
        const x = (Math.cos(radians) * reach).toFixed(2);
        const y = (Math.sin(radians) * reach).toFixed(2);
        return `<line x1="0" y1="0" x2="${x}" y2="${y}"/>`;
      }).join("") +
      `</g>` +
      `</svg>`,
  );

/*
 * A file or folder on this machine wears the sidebar's own icons — the same yellow
 * folder with its darker tab, the same blue page with the folded corner, path for
 * path — so the node and the tree row read as the same thing. No tile behind them,
 * unlike the app icons above: an app node is a tile because the icon IS a tile;
 * these are the shapes themselves. 256px of raster for the usual two reasons.
 */
const FOLDER_NODE_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 20 20">` +
      `<path d="M2 5.2C2 4.26 2.76 3.5 3.7 3.5h3.9c.45 0 .88.18 1.2.5l1.5 1.5H2z" fill="#c78e10"/>` +
      `<rect x="2" y="5.6" width="16" height="10.9" rx="1.7" fill="url(#fold-shine)"/>` +
      `<defs><linearGradient id="fold-shine" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#ffdd75"/><stop offset="1" stop-color="#f6b81f"/>` +
      `</linearGradient></defs></svg>`,
  );

const FILE_NODE_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 20 20">` +
      `<path d="M4.5 4a2 2 0 0 1 2-2h5.4L16 6.1v9.9a2 2 0 0 1-2 2H6.5a2 2 0 0 1-2-2z" fill="#55d0f7"/>` +
      `<path d="M11.9 2 16 6.1h-3.1a1 1 0 0 1-1-1z" fill="#2f7fd6"/>` +
      `</svg>`,
  );

/**
 * The ghost a parked note wears: the classic sheet — rounded head, two eye slots, three
 * drips of uneven length trailing off the bottom — floating over its own little shadow.
 * Darker grey on the grey the node turns, so a ghosted note reads as a shape with the
 * light off rather than a different kind of note. Inline SVG like the app icons above,
 * and 256px of raster for the same reason they are.
 */
const GHOST_GREY = "#565b63";
const GHOST_DARK = "#2b2e33";

const GHOST_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 64 64">` +
      // Head and shoulders: a semicircle carried straight down a little, so the drips
      // below hang off a body rather than straight off the dome.
      `<path fill="${GHOST_DARK}" d="M12 26 a20 20 0 0 1 40 0 v6 h-40 z"/>` +
      // The drips: round-capped strokes of uneven length, the middle one longest —
      // even lengths read as a paw print, not a ghost.
      `<g stroke="${GHOST_DARK}" stroke-width="11" stroke-linecap="round">` +
      `<line x1="17.5" y1="30" x2="17.5" y2="41"/>` +
      `<line x1="32" y1="30" x2="32" y2="46"/>` +
      `<line x1="46.5" y1="30" x2="46.5" y2="36"/>` +
      `</g>` +
      // Eyes cut in the node's own grey, so they read as holes rather than dots.
      `<rect x="24" y="16" width="5.5" height="10" rx="2.75" fill="${GHOST_GREY}"/>` +
      `<rect x="34.5" y="16" width="5.5" height="10" rx="2.75" fill="${GHOST_GREY}"/>` +
      `<ellipse cx="32" cy="58" rx="10" ry="2.8" fill="${GHOST_DARK}" opacity="0.5"/>` +
      `</svg>`,
  );

/**
 * Styles by note TYPE — the `type:: …` line a file ends with. Untyped notes are
 * tag-pie circles; a typed one wears its type on its sleeve — a Gemini
 * conversation IS the Gemini app icon. New types slot in here and get their
 * selector generated below.
 */
const TYPE_STYLES: Record<string, Record<string, unknown>> = {
  gemini: {
    shape: "round-rectangle",
    "background-image": GEMINI_ICON,
    "background-fit": "cover",
    "background-opacity": 0,
    "pie-size": "0%",
  },
  // An issue wears the Linear mark and nothing else: what is IN it opens on a click.
  // The same rounded tile the Gemini node wears — typed notes are siblings, and both
  // are the app's own icon rather than anything the vault drew.
  linear: {
    shape: "round-rectangle",
    "background-image": LINEAR_ICON,
    "background-fit": "cover",
    "background-opacity": 0,
    "pie-size": "0%",
  },
  // A coding session, the third of the same siblings: the app's own tile, and clicking it
  // goes to the session rather than to the file.
  claude: {
    shape: "round-rectangle",
    "background-image": CLAUDE_ICON,
    "background-fit": "cover",
    "background-opacity": 0,
    "pie-size": "0%",
  },
  // Something on the disk itself: the sidebar's blue page, and clicking it opens the
  // file in whatever the OS opens that kind of file with.
  file: {
    shape: "round-rectangle",
    "background-image": FILE_NODE_ICON,
    "background-fit": "cover",
    "background-opacity": 0,
    "pie-size": "0%",
  },
  // Its sibling: the sidebar's yellow folder, and a click opens Finder/Explorer there.
  folder: {
    shape: "round-rectangle",
    "background-image": FOLDER_NODE_ICON,
    "background-fit": "cover",
    "background-opacity": 0,
    "pie-size": "0%",
  },
};

/*
 * An issue's progress used to be a coloured ring round its icon, and it made the icon
 * look like something was wrong with it. A finished issue gets a badge on the corner of
 * its tile instead (see `drawIssueBadges`) — everything else says nothing, which is the
 * right amount to say about work that is simply under way.
 */

const typeShapeStyles = (): cytoscape.StylesheetJson =>
  Object.entries(TYPE_STYLES).map(([type, style]) => ({
    selector: `node[ntype = "${type}"]`,
    style,
  })) as unknown as cytoscape.StylesheetJson;

/** First web link in a conversation note — what a click on its node opens. */
const URL_RE = /https?:\/\/[^\s)\]>]+/;

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
  // Typed notes wear their type — a Gemini conversation is the Gemini icon.
  ...typeShapeStyles(),
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
  /*
   * The marks a right-click can put on things (see `applyMarks`). A ghost is parked, not
   * gone: the node turns grey and wears the ghost itself, ringed by long dashes — long
   * on purpose, a dash you can read from across the canvas where a dot is just fuzz.
   * The edge version is the same statement drawn along a line. A radiating edge is the
   * line counterpart of a radiating note — the same green, with `syncEdgeBeat` walking
   * the dashes along it so the flow reads as flowing.
   */
  {
    selector: "node.ghost",
    style: {
      "pie-size": "0%",
      "background-color": GHOST_GREY,
      "background-opacity": 1,
      "background-image": GHOST_ICON,
      "background-image-opacity": 1,
      "background-fit": "none",
      "background-width": "74%",
      "background-height": "74%",
      "border-width": 2,
      "border-color": "#8b949e",
      "border-style": "dashed",
      "border-dash-pattern": [9, 6],
      color: "#8b949e",
    },
  },
  {
    selector: "edge.ghost",
    style: {
      "line-style": "dashed",
      "line-dash-pattern": [12, 8],
      "line-color": "#6e7681",
      "target-arrow-color": "#6e7681",
    },
  },
  {
    selector: "edge.radiate",
    style: {
      "line-style": "dashed",
      "line-dash-pattern": [7, 5],
      "line-color": "#3fb950",
      "target-arrow-color": "#3fb950",
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

/* ------------------------------------------------------------------- marks --- */

/**
 * The statuses a right-click can set: radiating (the live end of the vault) or ghost
 * (parked). A node's mark lives in its own markdown — `active:: true` / `ghost:: true` —
 * so it travels with the folder. An edge has no file of its own unless it has been
 * described, so edge marks live beside the boxes toggle instead, keyed by edge id.
 */
export type Mark = "radiate" | "ghost";

const MARKS_KEY = "obsidian-lite:edge-marks";

function readEdgeMarks(): Record<string, Mark> {
  try {
    const kept = JSON.parse(localStorage.getItem(MARKS_KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, Mark> = {};
    for (const [id, mark] of Object.entries(kept)) {
      if (mark === "radiate" || mark === "ghost") out[id] = mark;
    }
    return out;
  } catch {
    return {};
  }
}

const DRAFT_NODE = "__draft_target__";
const DRAFT_EDGE = "__draft_edge__";

/* ------------------------------------------------------------------ issues --- */

/** The card an issue node opens into, in model units — it scales with the graph. */
const CARD_W = 230;

/**
 * An issue's own state, read off its checklist: started as soon as anything on it has
 * moved, done when everything has. Empty rows do not count — a line somebody is still
 * thinking about must not hold a finished issue open.
 */
export const rollUp = (rows: ReadonlyArray<{ state: TickState; title: string }>): TickState => {
  const live = rows.filter((row) => row.title.trim());
  if (!live.length) return "unstarted";
  if (live.every((row) => row.state === "done")) return "done";
  return live.some((row) => row.state !== "unstarted") ? "started" : "unstarted";
};

/**
 * What a card edit asks the app to announce. An empty object is "nothing to say to
 * Linear" — the note changed and that is all, which is what typing does.
 */
export type IssueChange = {
  /** A row whose tick moved: push that sub-issue's state. */
  ticked?: number;
  /** A row that has just earned a sub-issue of its own. */
  created?: number;
  /** The issue's own state, when this edit changed it. */
  issueState?: TickState;
};

/* ------------------------------------------------------------------ active --- */

/**
 * How long one pulse takes, start to start. A note that radiates is saying "this is
 * live", not asking to be looked at, so the beat is slow on purpose — the ring is gone
 * for most of the cycle, and a canvas with a dozen active notes still reads as a canvas.
 */
const PULSE_MS = 3000;

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

/** Clear space between two notes' rims, below which they read as stacked. */
const NODE_GAP = 10;

/**
 * Nearest point to `at` that keeps a note clear of every other one.
 *
 * Only the note being moved gives way. Shoving the others aside to make room would be the
 * app rearranging an arrangement behind its author's back, which is the one thing the
 * canvas promises never to do — so a note that cannot fit is held at the rim of whatever
 * is in its way instead.
 *
 * Several passes, because stepping out of one neighbour can step into the next.
 */
function unstacked(
  cy: Core,
  moving: string,
  at: cytoscape.Position,
  radius: number,
): cytoscape.Position {
  let point = at;
  for (let pass = 0; pass < 4; pass++) {
    let hit = false;
    cy.nodes().forEach((node) => {
      const other = node as NodeSingular;
      const id = other.id();
      if (id === moving || id === DRAFT_NODE || other.isParent() || isAnchor(id)) return;
      const centre = other.position();
      const need = radius + other.width() / 2 + NODE_GAP;
      let dx = point.x - centre.x;
      let dy = point.y - centre.y;
      let gap = Math.hypot(dx, dy);
      if (gap >= need) return;
      // Exactly on top of one another: there is no direction to push along, so pick one.
      if (gap < 0.001) {
        dx = 1;
        dy = 0;
        gap = 1;
      }
      point = { x: centre.x + (dx / gap) * need, y: centre.y + (dy / gap) * need };
      hit = true;
    });
    if (!hit) break;
  }
  return point;
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

  // Issues are read FIRST: a solved issue leaves the canvas altogether, and a solved row
  // takes its arrow down with it — so the link pass below has to know what is finished
  // before it counts anything. The notes themselves keep every line and every link;
  // reopen a row (or the issue) and it all comes back.
  const types = new Map<string, string | null>();
  const issues = new Map<string, IssueDoc>();
  const solved = new Set<string>();
  for (const doc of docs) {
    // A note in `linear/` (or the `todos/` folder that came before it) is an issue by
    // where it lives — no `type::` line to write, nothing to migrate. An explicit
    // `type:: linear` works too, for an issue note filed anywhere else.
    const type = parseType(doc.text) ?? (isIssuePath(doc.path) ? "linear" : null);
    types.set(doc.path, type);
    if (type !== "linear") continue;
    const issue = parseIssue(doc.text, noteName(doc.path));
    issues.set(doc.path, issue);
    if (issue.state === "done" || rollUp(issue.rows) === "done") solved.add(doc.path);
  }

  // Edges are resolved next: a note is sized by how many others point at it, so the
  // link pass has to have run before the nodes can be emitted.
  // One edge per (source, target); its label is the relation named in the file
  // (`built with:: [[Target]]`). Several links to the same note keep every distinct name.
  const byEdge = new Map<string, { source: string; target: string; labels: string[] }>();
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const doc of docs) {
    if (solved.has(doc.path)) continue;
    const settled = issues
      .get(doc.path)
      ?.rows.filter((row) => row.state === "done" && row.target)
      .map((row) => resolver.resolve(row.target as string));
    const settledRows = settled ? new Set(settled) : null;
    for (const link of parseLinks(doc.text)) {
      const resolved = resolver.resolve(link.target);
      if (!resolved || resolved === doc.path || solved.has(resolved)) continue;
      if (settledRows?.has(resolved)) continue;
      const id = edgeId(doc.path, resolved);
      const found = byEdge.get(id) ?? { source: doc.path, target: resolved, labels: [] };
      if (link.label && !found.labels.includes(link.label)) found.labels.push(link.label);
      // Count linking notes, not links: ten mentions in one note is still one voice.
      if (!byEdge.has(id)) {
        incoming.set(resolved, (incoming.get(resolved) ?? 0) + 1);
        outgoing.set(doc.path, (outgoing.get(doc.path) ?? 0) + 1);
      }
      byEdge.set(id, found);
    }
  }

  for (const doc of docs) {
    if (solved.has(doc.path)) continue; // a finished issue is not on the canvas at all
    // Every folder gets a box on the graph except the ones the app keeps issues in:
    // `linear/` is not somewhere anybody filed anything, and a rectangle drawn round
    // every issue you own says nothing while hiding whatever is under it.
    for (const folder of ancestors(doc.path)) if (!isIssueDir(folder)) folders.add(folder);
    const home = dirname(doc.path);
    const boxed = home && !isIssueDir(home) ? home : undefined;
    const type = types.get(doc.path) ?? null;
    const issue = issues.get(doc.path) ?? null;
    elements.push({
      data: {
        id: doc.path,
        label: noteName(doc.path),
        parent: boxed,
        kind: "file",
        size: nodeSize((incoming.get(doc.path) ?? 0) + (outgoing.get(doc.path) ?? 0)),
        // Always present (empty for untyped), so a removed type line clears on sync.
        ntype: type ?? "",
        // An issue node carries its own markdown, so the card it opens into can be
        // built (and rewritten) without a read going back to the vault first.
        ...(issue ? { raw: doc.text, istate: issue.state } : {}),
        // Likewise always present: `sync` patches the keys a definition carries, so a
        // 0 is what stops a note that has just been quietened from pulsing forever.
        radiating: parseActive(doc.text) ? 1 : 0,
        // Its grey twin, same bargain: `ghost:: true` in the note, 0 when the line goes.
        ghost: parseGhost(doc.text) ? 1 : 0,
        // A conversation node opens its link directly, so the URL rides on the node —
        // a click must not wait on a file read (popup blockers honour only the click).
        ...(type === "gemini" ? { gurl: URL_RE.exec(doc.text)?.[0] ?? "" } : {}),
        // A file/folder node opens what its `path::` points at, riding along the same way.
        ...(type === "file" || type === "folder" ? { fspath: parseField(doc.text, "path") ?? "" } : {}),
        // Same bargain for a session note: its id rides the node, so a click can go
        // straight to `claude://resume` without a read first. Empty until the Claude app
        // has minted one — that is a note that has never been run.
        ...(type === "claude"
          ? {
              csession: parseField(doc.text, "session") ?? "",
              // How much of the session has been looked at (`seen::`), so a turn that
              // finished while the graph was closed still reads as unseen when it opens.
              // What the session is DOING is deliberately NOT here: `sync` patches the
              // keys a definition carries, and a rebuild must not blank a live badge
              // back to nothing until the next poll comes round.
              cseen: Date.parse(parseField(doc.text, "seen") ?? "") || 0,
              // Where it runs, and when it was last sent to Claude with no id to show for
              // it: between them a note can find its own session on disk afterwards, which
              // is what makes catching the id survive a second click or a restart.
              cfolder: parseField(doc.text, "folder") ?? "",
              cstarted: parseField(doc.text, "started") ?? "",
            }
          : {}),
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

/**
 * What a link draft is aimed at making when it lands on empty space: an ordinary note, or
 * one of the typed notes that stand for something outside the vault.
 */
export type DraftKind = "note" | "gemini" | "claude" | "file" | "folder";

/**
 * What a Claude session is doing, as the corner of its node reports it. `unseen` is the
 * renderer's own reading of a finished turn: the shell says a turn ended, the note says how
 * much of the session has been read, and only together do they mean "go and look".
 */
export type SessionState = "running" | "waiting" | "unseen" | "idle";

const SESSION_TITLES: Record<SessionState, string> = {
  running: "Claude is working",
  waiting: "waiting on you",
  unseen: "finished — not looked at yet",
  idle: "nothing running",
};

/** What each kind is called in the hints a draft puts on the status bar. */
const DRAFT_NAMES: Record<DraftKind, string> = {
  note: "note",
  gemini: "Gemini conversation",
  claude: "Claude session",
  file: "file link",
  folder: "folder link",
};

export type GraphHandlers = {
  onOpen: (path: string) => void;
  /**
   * Click on a Gemini conversation node: it is a link, not a page — hand over the
   * chat URL stored on the node (null when the note carries none yet).
   */
  onOpenGemini: (path: string, url: string | null) => void;
  /**
   * Click on a Claude Code session node: hand over the session id stored on the node, or
   * null for a note that has never been run — which is the difference between resuming a
   * session and starting one.
   */
  onOpenClaude: (path: string, session: string | null) => void;
  /**
   * Click on a file/folder node: hand over the disk path stored on the node (null when
   * the note carries none), and which of the two it is — a file opens in its default
   * app, a folder opens in Finder/Explorer.
   */
  onOpenPath: (path: string, target: string | null, kind: "file" | "folder") => void;
  /**
   * An edit made in an issue card: the note's new markdown, and what (if anything) of
   * it Linear should be told about. The graph has already redrawn — this is the write.
   */
  onIssueEdit: (path: string, text: string, change: IssueChange) => void;
  /** The identifier chip on a card was clicked: open the issue in Linear. */
  onOpenIssue: (url: string) => void;
  /**
   * Click on a connection: open the markdown file that describes it, creating it on the
   * spot if this is the first time anybody has had something to say about that link.
   * `label` is the relation named in the note, so a new file can open with it already in.
   */
  onOpenEdge: (source: string, target: string, label: string | null) => void;
  /** Right-click on a note: offer "link" / "delete". */
  onNodeMenu: (path: string, client: Client) => void;
  /** Right-click on a connection: offer its marks, and the note that describes it. */
  onEdgeMenu: (source: string, target: string, label: string | null, client: Client) => void;
  /** Right-click on empty canvas, or inside a folder box: offer "new note/folder". */
  onCanvasMenu: (at: cytoscape.Position, client: Client, folder: string | null) => void;
  /** Link draft finished on another note: link `source` -> `target`. */
  onLinkExisting: (source: string, target: string) => void;
  /**
   * Link draft finished on empty canvas: create a note THERE and link to it. `folder` is the box
   * the release landed in (null at the root) — the note belongs where the user dropped it, not
   * wherever the source note happens to live. `kind` is what the draft was aimed at making.
   */
  onLinkNew: (source: string, at: cytoscape.Position, folder: string | null, kind: DraftKind) => void;
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
  /** What the open draft will create if it lands on empty space. */
  private draftKind: DraftKind = "note";
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
  /** Note path -> the ring that pulses over it, for the notes marked active. */
  private pulseEls = new Map<string, HTMLElement>();
  /** Edge id -> its mark. Nodes keep theirs in their own markdown; edges keep them here. */
  private edgeMarks: Record<string, Mark> = readEdgeMarks();
  /** The timer walking the dashes along radiating edges, while there are any to walk. */
  private edgeBeat: number | undefined;
  /** Note path -> the "done" badge on its icon, for the issues that are finished. */
  private badgeEls = new Map<string, HTMLElement>();
  /** Note path -> the dot on its corner saying what its Claude session is doing. */
  private sessionEls = new Map<string, HTMLElement>();
  /** The open issue card, if any — one at a time, like a popover. */
  private issue: { path: string; el: HTMLElement } | null = null;
  /** Which row of it is waiting for an arrow, while one is being aimed. */
  private draftRow: number | null = null;
  /**
   * True once this vault's arrangement has been restored (or solved for the first time).
   * Nothing is written back before then — a capture from a half-built graph would
   * overwrite a perfectly good cache with whatever happened to be on screen.
   */
  private ready = false;
  /** The vault generation this canvas was built for; -1 until it has been built. */
  private builtFor = -1;
  /** Container size the view was last framed at, and whether the user has moved it since. */
  private fittedSize: { w: number; h: number } | null = null;
  private userMoved = false;
  private fitting = false;

  constructor(
    private container: HTMLElement,
    private handlers: GraphHandlers,
    private spatial: SpatialStore,
    private stickies: StickyStore,
    private settings: SettingsStore,
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
      // An aimed arrow is the innermost thing open: it goes first, and alone.
      if (this.draftRow !== null) {
        this.cancelRowLink();
        return;
      }
      if (this.draftSource) this.cancelDraft();
      if (this.lasso) this.cancelGroup();
      if (this.issue) this.closeIssue();
    });
  }

  /**
   * Throws the whole graph away so the next render builds a fresh one. Call this when the
   * vault changes: without it `render` sees a live instance and takes the `sync` path,
   * which treats every note of the new vault as newly added and scatters them — and then
   * saves that over the arrangement the vault already had.
   */
  reset(): void {
    this.ready = false;
    this.builtFor = -1;
    if (this.edgeBeat !== undefined) {
      clearInterval(this.edgeBeat);
      this.edgeBeat = undefined;
    }
    this.cy?.destroy();
    this.cy = null;
    this.pending = null;
    this.carried.clear();
    this.cancelGroup();
    for (const el of this.handles.values()) el.remove();
    this.handles.clear();
    for (const el of this.stickyEls.values()) el.remove();
    this.stickyEls.clear();
    for (const el of this.pulseEls.values()) el.remove();
    this.pulseEls.clear();
    for (const el of this.badgeEls.values()) el.remove();
    this.badgeEls.clear();
    this.issue?.el.remove();
    this.issue = null;
    this.fittedSize = null;
    this.userMoved = false;
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
    // A live canvas from a DIFFERENT vault must never be patched into this one: `sync`
    // would treat every note here as newly added, scatter them, and then save that over
    // this vault's arrangement. The graph checks for itself rather than trusting every
    // caller to remember — the one time a caller did not, a whole vault was lost.
    if (this.cy && this.spatial.generation() !== this.builtFor) this.reset();
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
    // The open card's note may have just left the canvas — a finished issue folds away.
    if (this.issue && cy.getElementById(this.issue.path).empty()) this.closeIssue();
    this.markActive(active);
    this.applyMarks();
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
    this.builtFor = this.spatial.generation(); // this canvas belongs to this vault
    // A cached arrangement is restored as-is. Re-solving on every start is what made
    // the graph feel like it forgot everything the moment the app closed.
    if (this.spatial.hasLayout()) this.restore(this.cy);
    else this.settle(); // solved straight away — there is no simulation to wait for
    this.markActive(active);
    this.applyMarks();
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
    this.ready = true; // restored — from here on, changes are worth saving
  }

  /** Frames go on only once the layout has placed the notes. */
  private settle(): void {
    if (!this.cy) return;
    layoutGraph(this.cy, this.frames);
    this.applyBoxVisibility();
    this.fit();
    this.drawOverlay();
    this.ready = true;
    this.capture(); // the solved arrangement is the one to remember
  }

  /** Hands the current positions to the cache; it decides whether that is a change. */
  private capture(): void {
    const cy = this.cy;
    if (!cy || !this.ready) return;
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

  /**
   * Nudges apart every note that is sitting on top of another and leaves everything else
   * exactly where it is. Dragging cannot stack notes any more, but a layout cached before
   * that was true can still hold a pile, and a full re-solve to fix one would throw away
   * the whole arrangement. Returns how many notes had to move.
   */
  unstackAll(): number {
    const cy = this.cy;
    if (!cy) return 0;
    let moved = 0;
    cy.batch(() => {
      // Rounds, not one pass: making room for one note can crowd the next.
      for (let round = 0; round < 6; round++) {
        let shifted = 0;
        cy.nodes().forEach((node) => {
          const note = node as NodeSingular;
          if (note.data("kind") !== "file" || isAnchor(note.id())) return;
          const at = note.position();
          let next = unstacked(cy, note.id(), at, note.width() / 2);
          const parent = note.parent().first();
          if (parent.nonempty()) {
            const centre = frameCentre(cy, parent.id());
            if (centre) {
              next = clampInto(next, interior(centre, this.frames.get(parent.id()), note.width() / 2));
            }
          }
          if (Math.hypot(next.x - at.x, next.y - at.y) < 0.5) return;
          note.position(next);
          shifted++;
        });
        if (!shifted) break;
        moved = Math.max(moved, shifted);
      }
    });
    if (moved) {
      this.capture();
      this.drawOverlay();
    }
    return moved;
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
      // A checklist line is waiting for its arrow: this click is the other end of it.
      if (this.draftRow !== null) {
        this.finishRowLink(node);
        return;
      }
      if (this.draftSource) {
        // A release over a folder box is a release on the space INSIDE it: the tap
        // lands on the compound node, but what the user meant is "put it here".
        if (node.data("kind") === "dir") {
          const source = this.draftSource;
          const kind = this.draftKind;
          const at = { ...event.position };
          const folder = this.folderAt(cy, at, null)?.id() ?? node.id();
          this.clearDraft();
          this.handlers.onLinkNew(source, at, folder, kind);
          return;
        }
        this.finishDraftOnNode(node);
        return;
      }
      if (node.data("kind") !== "file") return;
      // A conversation node is a link wearing a rectangle: clicking it goes to the
      // chat. With the integration off it opens like any note, from here too.
      if (node.data("ntype") === "gemini" && this.settings.enabled("gemini")) {
        this.handlers.onOpenGemini(node.id(), (node.data("gurl") as string) || null);
        return;
      }
      // A session node is where the work is happening, not a page about it: clicking it
      // opens the session in the Claude app.
      if (node.data("ntype") === "claude" && this.settings.enabled("claude")) {
        this.handlers.onOpenClaude(node.id(), (node.data("csession") as string) || null);
        return;
      }
      // A file/folder node stands for something on the disk: clicking it opens THAT —
      // the note behind it is only the pointer, and stays reachable from the tree.
      const ntype = node.data("ntype") as string;
      if ((ntype === "file" || ntype === "folder") && this.settings.enabled("files")) {
        this.handlers.onOpenPath(node.id(), (node.data("fspath") as string) || null, ntype);
        return;
      }
      // An issue node is a folded checklist: clicking unfolds it over the canvas
      // rather than opening the file, which is where the ticks live anyway.
      if (node.data("ntype") === "linear" && this.settings.enabled("linear")) {
        this.toggleIssue(node.id());
        return;
      }
      this.handlers.onOpen(node.id());
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
      // An aimed arrow released on nothing is a change of mind, not a new note.
      if (this.draftRow !== null) {
        this.cancelRowLink();
        return;
      }
      if (this.issue) this.closeIssue(); // clicked away — the card folds back up
      if (this.draftSource) {
        const source = this.draftSource;
        const kind = this.draftKind;
        const at = { ...event.position };
        const folder = this.enclosingFolder(cy, at);
        this.clearDraft();
        this.handlers.onLinkNew(source, at, folder, kind);
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
      const hit = event.target === cy ? null : (event.target as NodeSingular | EdgeSingular);
      if (hit && hit.isEdge()) {
        const edge = hit as EdgeSingular;
        this.handlers.onEdgeMenu(
          edge.source().id(),
          edge.target().id(),
          ((edge.data("label") as string | undefined) ?? null),
          client,
        );
        return;
      }
      const node = hit as NodeSingular | null;
      if (node && node.data("kind") === "file") this.handlers.onNodeMenu(node.id(), client);
      else {
        const folder =
          node && node.data("kind") === "dir" ? node.id() : this.enclosingFolder(cy, event.position);
        this.handlers.onCanvasMenu({ ...event.position }, client, folder);
      }
    });

    // Keep the arrow's tip under the cursor while a link is being drawn.
    cy.on("mousemove", (event) => {
      if (this.draftSource) cy.getElementById(DRAFT_NODE).position(event.position);
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
      this.drawPulses(); // a note's own ring stays under the cursor with it
      this.placeIssueCard(); // as does an open card, if this is its node
      this.drawIssueBadges(); // and the badge on an issue's corner
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
      if (drag) {
        // Before the capture, and before any refile: a reparent carries the node's current
        // position over to its new id, and that has to be the settled one.
        const node = cy.getElementById(drag.path) as NodeSingular;
        if (node.nonempty()) this.settleAfterDrop(cy, node, drag);
      }
      this.capture(); // wherever it came to rest is where it should be next time
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
   * Where a note ends up once it is let go of.
   *
   * A drag itself is completely free — the note goes wherever the cursor does, straight
   * over anything in its way — so the arrangement is only judged at the moment of release:
   * a note resting on top of another slides to the nearest spot that clears it. Nothing
   * else on the canvas moves, and a note that merely passed over its neighbours on the way
   * is left exactly where it was dropped.
   */
  private settleAfterDrop(cy: Core, node: NodeSingular, drag: DragState): void {
    const at = node.position();
    let next = unstacked(cy, node.id(), at, node.width() / 2);
    if (next.x === at.x && next.y === at.y) return;
    // Whichever box it has landed in: the one it is being filed into when the drop is
    // armed, the one it was already in otherwise. `""` is the vault root, which has none.
    const folder = drag.armed && drag.target !== null ? drag.target : drag.parent;
    if (folder) {
      const centre = frameCentre(cy, folder);
      if (centre) next = clampInto(next, interior(centre, this.frames.get(folder), node.width() / 2));
    }
    node.position(next);
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
    this.drawPulses();
    this.placeIssueCard();
    this.drawIssueBadges();
    this.drawSessionBadges();
  }

  /** Re-applies the feature toggles to everything drawn above the canvas. */
  refreshOverlay(): void {
    this.applyMarks(); // the marks follow the same toggle as the pulses
    this.drawOverlay();
  }

  /* ------------------------------------------------------------------ active --- */

  /**
   * The notes marked `active:: true` radiate: one green ring out of a note's rim every
   * PULSE_MS. Cytoscape has no notion of a repeating animation, so the ring is a DOM
   * element in the overlay and CSS runs it — which keeps the beat going while the canvas
   * sits idle, and costs nothing at all on a vault with no active notes.
   */
  private drawPulses(): void {
    const cy = this.cy;
    if (!cy) return;
    const alive = new Set<string>();
    // A switched-off integration leaves nothing on the canvas; the marks stay in the
    // notes, so switching it back on brings every ring back.
    if (this.settings.enabled("active")) {
      cy.nodes().forEach((node) => {
        const dot = node as NodeSingular;
        if (dot.data("kind") !== "file" || !dot.data("radiating")) return;
        alive.add(dot.id());
        let el = this.pulseEls.get(dot.id());
        if (!el) {
          el = document.createElement("div");
          el.className = "node-pulse";
          // Every ring on the canvas beats together: a negative delay starts a new one
          // part-way through the cycle, so a note marked active now falls in with the
          // ones already going instead of pulsing on its own offbeat. The document
          // timeline, not performance.now(): an animation starts at the frame's time,
          // and reading the wall clock instead puts each ring a frame out of step.
          const clock = Number(document.timeline.currentTime ?? performance.now());
          el.style.animationDelay = `${-(clock % PULSE_MS) / 1000}s`;
          this.overlay.appendChild(el);
          this.pulseEls.set(dot.id(), el);
        }
        // Model units and a transform: the ring rides the zoom with the note it belongs
        // to, and so do its rim and its glow — a size in rendered pixels would shrink the
        // circle while leaving a 1.5px border to thicken around it.
        const at = dot.renderedPosition();
        const size = dot.width() + 4;
        el.style.left = `${at.x}px`;
        el.style.top = `${at.y}px`;
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;
        el.style.transform = `translate(-50%, -50%) scale(${cy.zoom()})`;
      });
    }
    for (const [id, el] of this.pulseEls) {
      if (alive.has(id)) continue;
      el.remove();
      this.pulseEls.delete(id);
    }
  }

  /** The mark a note wears, as the live graph has it — what the menu offers to change. */
  nodeMark(path: string): Mark | null {
    const node = this.cy?.getElementById(path);
    if (!node || node.empty()) return null;
    if (node.data("radiating")) return "radiate";
    return node.data("ghost") ? "ghost" : null;
  }

  /**
   * Sets (or clears) a note's mark on the live graph, so the look answers the
   * right-click that asked for it rather than waiting for the next rebuild. Marks are
   * exclusive — a note cannot be the live end of the vault and on ice at once. The mark
   * itself is a line in the note's markdown — `setActive` / `setGhost` in `links.ts`.
   */
  setNodeMark(path: string, mark: Mark | null): void {
    const node = this.cy?.getElementById(path);
    if (!node || node.empty()) return;
    node.data("radiating", mark === "radiate" ? 1 : 0);
    node.data("ghost", mark === "ghost" ? 1 : 0);
    this.drawPulses();
    this.applyMarks();
  }

  /** The mark a connection wears. */
  edgeMark(source: string, target: string): Mark | null {
    return this.edgeMarks[edgeId(source, target)] ?? null;
  }

  /** Sets (or clears) a connection's mark, and keeps it for the next session. */
  setEdgeMark(source: string, target: string, mark: Mark | null): void {
    const id = edgeId(source, target);
    if (mark) this.edgeMarks[id] = mark;
    else delete this.edgeMarks[id];
    localStorage.setItem(MARKS_KEY, JSON.stringify(this.edgeMarks));
    this.applyMarks();
  }

  /**
   * Dresses every node and edge to its mark. Classes rather than data selectors, so the
   * whole wardrobe comes off at once when the integration is toggled away — the marks
   * themselves stay put, in the notes and in the store, for when it comes back.
   */
  private applyMarks(): void {
    const cy = this.cy;
    if (!cy) return;
    const on = this.settings.enabled("active");
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        // Radiating wins a contradiction typed by hand; `nodeMark` reads it the same way.
        node.toggleClass("ghost", on && !!node.data("ghost") && !node.data("radiating"));
      });
      cy.edges().forEach((edge) => {
        const mark = on ? this.edgeMarks[edge.id()] : undefined;
        edge.toggleClass("ghost", mark === "ghost");
        edge.toggleClass("radiate", mark === "radiate");
      });
    });
    this.syncEdgeBeat();
  }

  /**
   * Cytoscape has no notion of a repeating animation on an edge either, and there is no
   * DOM element to hand this one to: the dashes are walked by hand instead — one timer
   * for every radiating edge on the canvas, running only while there is one to move.
   */
  private syncEdgeBeat(): void {
    const cy = this.cy;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wanted = !!cy && !still && cy.edges(".radiate").length > 0;
    if (wanted && this.edgeBeat === undefined) {
      this.edgeBeat = window.setInterval(() => {
        // The dash pattern is 12 long, so an offset cycling through 12 loops seamlessly;
        // the shared clock keeps every radiating edge flowing in step, like the rings.
        const clock = Number(document.timeline.currentTime ?? performance.now());
        this.cy?.edges(".radiate").style("line-dash-offset", -((clock / 40) % 12));
      }, 50);
    } else if (!wanted && this.edgeBeat !== undefined) {
      clearInterval(this.edgeBeat);
      this.edgeBeat = undefined;
    }
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
   * Cards are PART of the graph: corner, size and type all live in model space and
   * ride the zoom 1:1 with the nodes — a card keeps its proportions to the picture
   * around it at every zoom level, exactly like everything else on the canvas.
   */
  private placeStickies(): void {
    const cy = this.cy;
    if (!cy) return;
    const zoom = cy.zoom();
    const pan = cy.pan();
    const alive = new Set<string>();

    for (const sticky of this.stickies.all()) {
      // A switched-off integration leaves nothing on the canvas; the text is still
      // in the store, so switching it back on brings everything back.
      if (!this.settings.enabled("stickies")) continue;
      alive.add(sticky.id);
      const el = this.stickyEls.get(sticky.id) ?? this.buildSticky(sticky);
      el.style.left = `${sticky.x * zoom + pan.x}px`;
      el.style.top = `${sticky.y * zoom + pan.y}px`;
      el.style.width = `${sticky.w * zoom}px`;
      el.style.height = `${sticky.h * zoom}px`;
      // Everything inside is sized in em, so one font-size scales the whole card —
      // checkboxes, rows, grips — in lockstep with the graph.
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
      `<button class="sticky-x" title="Delete this sticky">✕</button>` +
      `<textarea class="sticky-text" spellcheck="false" placeholder="note to self…"></textarea>` +
      `<div class="sticky-grip" title="Drag to resize"></div>`;
    const field = el.querySelector<HTMLTextAreaElement>(".sticky-text")!;
    field.value = sticky.text;
    el.querySelector<HTMLButtonElement>(".sticky-x")?.addEventListener("click", () =>
      this.deleteSticky(sticky.id),
    );

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
      const target = event.target as HTMLElement;
      if (event.target === field || target.closest(".sticky-x")) return;
      event.preventDefault();
      event.stopPropagation();
      const grip = target.classList.contains("sticky-grip");
      this.dragSticky(sticky.id, event, grip ? "size" : "move");
    });

    this.overlay.appendChild(el);
    this.stickyEls.set(sticky.id, el);
    return el;
  }

  /** Grows a sticky's height so typed lines are never hidden behind its own edge. */
  private growToFit(id: string, field: HTMLTextAreaElement): void {
    const el = this.stickyEls.get(id);
    if (!el) return;
    // scrollHeight is screen pixels at the current zoom; the model needs it unscaled.
    const zoom = this.cy?.zoom() ?? 1;
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
      // Corner and size both live in model units, so every delta divides by the zoom.
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

  /** The ✕ in a card's corner: the card goes, and with it its file. */
  private deleteSticky(id: string): void {
    this.stickies.remove(id);
    this.placeStickies();
  }

  /* ------------------------------------------------------------------ issues --- */

  /**
   * An issue node's click gesture. Folded, the node is only the Linear mark — which is
   * all a canvas full of issues should have to say. Open, it is its checklist, floating
   * beside the node it belongs to. One at a time: a second click, Esc, the ✕, or a click
   * on the background folds it back up.
   */
  toggleIssue(path: string, aimFirstRow = false): void {
    if (this.issue?.path === path) {
      this.closeIssue();
      return;
    }
    this.closeIssue();
    const el = document.createElement("div");
    el.className = "issue-card";
    // Ticking and typing must never reach cytoscape, which would read the press as a
    // grab on the node underneath and pan the canvas out from under the card.
    el.addEventListener("mousedown", (event) => event.stopPropagation());
    this.overlay.appendChild(el);
    this.issue = { path, el };
    this.renderIssue();
    this.placeIssueCard();
    this.drawIssueBadges(); // this one is unfolded now; its badge steps aside
    this.focusRow(0);
    // A brand-new issue opens already offering the first line's arrow; opening one that
    // already exists does not, or every glance at an issue would arm a gesture.
    if (aimFirstRow) this.proposeRowLink(0);
  }

  closeIssue(): void {
    this.issue?.el.remove();
    this.issue = null;
    this.drawIssueBadges(); // folded again — a finished issue gets its badge back
  }

  /** Which issue is open, if any. */
  openIssue(): string | null {
    return this.issue?.path ?? null;
  }

  /**
   * A finished issue wears Linear's done mark on the top-right corner of its tile.
   *
   * Only while it is FOLDED: with the card open the head tick says the same thing three
   * times over, and the badge would sit under the card's own edge. Sized off the node, so
   * it rides the zoom with the icon it belongs to.
   */
  private drawIssueBadges(): void {
    const cy = this.cy;
    if (!cy) return;
    const alive = new Set<string>();
    if (this.settings.enabled("linear")) {
      cy.nodes().forEach((node) => {
        const dot = node as NodeSingular;
        if (dot.data("ntype") !== "linear" || dot.data("istate") !== "done") return;
        if (this.issue?.path === dot.id()) return; // unfolded: its own head tick says it
        alive.add(dot.id());
        let el = this.badgeEls.get(dot.id());
        if (!el) {
          el = document.createElement("div");
          el.className = "issue-badge";
          el.title = "Done";
          this.overlay.appendChild(el);
          this.badgeEls.set(dot.id(), el);
        }
        const at = dot.renderedPosition();
        const half = dot.renderedWidth() / 2;
        // Model units and a transform, never a size in rendered pixels: scaling the whole
        // element takes the ring around it and the check inside it along, and nothing is
        // floored — a badge that stopped shrinking would end up swallowing its own tile.
        const size = (dot.width() / 2) * 0.85;
        // Sat on the corner, overlapping the tile a little, the way an app badge does.
        el.style.left = `${at.x + half * 0.82}px`;
        el.style.top = `${at.y - half * 0.82}px`;
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;
        el.style.fontSize = `${size * 0.72}px`;
        el.style.transform = `translate(-50%, -50%) scale(${cy.zoom()})`;
      });
    }
    for (const [id, el] of this.badgeEls) {
      if (alive.has(id)) continue;
      el.remove();
      this.badgeEls.delete(id);
    }
  }

  /**
   * Hands the graph a note's current markdown, so the node's ring and any open card
   * follow a write that happened somewhere else — the editor, or a push that has just
   * stamped an identifier onto a row.
   */
  setIssueRaw(path: string, text: string): void {
    const node = this.cy?.getElementById(path);
    if (!node || node.empty()) return;
    node.data("raw", text);
    node.data("istate", parseIssue(text, noteName(path)).state);
    this.drawIssueBadges();
    // Never rebuild the card out from under someone who is typing in it.
    if (this.issue?.path === path && !this.issue.el.contains(document.activeElement)) {
      this.renderIssue();
    }
  }

  /** The note behind the card, as the graph last heard it. */
  private issueDoc(path: string): IssueDoc | null {
    const node = this.cy?.getElementById(path);
    if (!node || node.empty()) return null;
    return parseIssue(String(node.data("raw") ?? ""), noteName(path));
  }

  /**
   * Rebuilds the card's rows from the note. Structural changes only — a row added or
   * cut, a tick moved — never per keystroke, which would take the caret with it.
   */
  private renderIssue(): void {
    const open = this.issue;
    const doc = open ? this.issueDoc(open.path) : null;
    if (!open || !doc) return;

    const stamp = doc.identifier
      ? `<button class="issue-id" title="Open ${escapeAttr(doc.identifier)} in Linear">` +
        `${escapeAttr(doc.identifier)}</button>`
      : `<span class="issue-id local" title="Not announced to Linear yet">local</span>`;

    open.el.innerHTML =
      `<div class="issue-head">` +
      `<button class="tick ${doc.state}" data-tick="-1" title="This issue's own state"></button>` +
      stamp +
      `<button class="issue-x" title="Fold it back up">✕</button>` +
      `</div>` +
      `<div class="issue-name">${escapeAttr(doc.title)}</div>` +
      `<div class="issue-rows">` +
      doc.rows
        .map(
          (row, index) =>
            `<div class="issue-row">` +
            `<button class="tick ${row.state}" data-tick="${index}" title="Click to move it on"></button>` +
            `<input class="issue-text" type="text" spellcheck="false" data-row="${index}" ` +
            `value="${escapeAttr(row.title)}" placeholder="what needs doing…" />` +
            `<button class="row-aim${row.target ? " on" : ""}" data-aim="${index}" title="${
              row.target ? `Points at ${escapeAttr(row.target)} — click to aim it elsewhere` : "Point this line at a note"
            }">↗</button>` +
            (row.identifier ? `<span class="row-id">${escapeAttr(row.identifier)}</span>` : "") +
            `</div>`,
        )
        .join("") +
      `</div>`;

    open.el.querySelector<HTMLButtonElement>(".issue-x")?.addEventListener("click", () =>
      this.closeIssue(),
    );
    open.el.querySelector<HTMLButtonElement>(".issue-id")?.addEventListener("click", () => {
      if (doc.url) this.handlers.onOpenIssue(doc.url);
    });

    open.el.querySelectorAll<HTMLButtonElement>(".tick").forEach((button) => {
      button.addEventListener("click", () => this.advanceTick(Number(button.dataset.tick)));
    });
    open.el.querySelectorAll<HTMLButtonElement>(".row-aim").forEach((button) => {
      button.addEventListener("click", () => this.proposeRowLink(Number(button.dataset.aim)));
    });

    open.el.querySelectorAll<HTMLInputElement>(".issue-text").forEach((field) => {
      const index = Number(field.dataset.row);

      field.addEventListener("input", () => {
        // They typed instead of picking a note: that was the "no arrow" answer.
        this.cancelRowLink();
        this.editIssue((next) => {
          if (next.rows[index]) next.rows[index].title = field.value;
        }, {});
      });

      // Leaving a row with something written in it is what announces it to Linear:
      // an empty row is a line somebody is still thinking about, not an issue.
      field.addEventListener("blur", () => this.commitRow(index));

      field.addEventListener("keydown", (event) => {
        event.stopPropagation(); // never reach the graph's own Escape / delete handling
        if (event.key === "Enter") {
          event.preventDefault();
          this.commitRow(index);
          this.addRow(index);
        } else if (event.key === "Backspace" && field.value === "") {
          const held = this.issue ? this.issueDoc(this.issue.path) : null;
          if (!held || held.rows.length <= 1) return; // the last line stays
          event.preventDefault();
          // The line goes from the note. A sub-issue already in Linear is left alone
          // there — backspace in a text field must not delete somebody's issue.
          this.editIssue((next) => next.rows.splice(index, 1), {});
          this.renderIssue();
          this.focusRow(Math.max(0, index - 1));
        } else if (event.key === "Escape") {
          // The arrow being offered is the innermost thing open, so it goes first;
          // a second Escape then folds the card away.
          if (this.draftRow !== null) this.cancelRowLink();
          else this.closeIssue();
        }
      });
    });
  }

  private focusRow(index: number): void {
    const field = this.issue?.el.querySelectorAll<HTMLInputElement>(".issue-text")[index];
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }

  /**
   * Applies a change to the open issue's markdown and hands it on: the app owns the
   * vault and the push to Linear, the graph owns what is drawn. The node's own copy of
   * the text is updated first, so the card can be rebuilt from it immediately rather
   * than waiting for the write to come back.
   */
  private editIssue(change: (doc: IssueDoc) => void, what: IssueChange): void {
    const open = this.issue;
    const node = open ? this.cy?.getElementById(open.path) : null;
    if (!open || !node || node.empty()) return;
    const raw = String(node.data("raw") ?? "");
    const doc = parseIssue(raw, noteName(open.path));
    change(doc);
    const text = writeIssue(raw, doc);
    node.data("raw", text);
    node.data("istate", doc.state);
    this.drawIssueBadges(); // a tick may have just finished (or reopened) the issue
    this.handlers.onIssueEdit(open.path, text, what);
  }

  /**
   * A tick moves on: not started → started → done, then round again. Three states
   * because that is what a checklist is for; Linear's own five are what these MAP to,
   * so a team's "In review" column is still where a started row lands.
   */
  private advanceTick(index: number): void {
    const open = this.issue;
    const doc = open ? this.issueDoc(open.path) : null;
    if (!open || !doc) return;
    const from = index < 0 ? doc.state : doc.rows[index]?.state;
    if (from === undefined) return;
    const to = TICK_ORDER[(TICK_ORDER.indexOf(from) + 1) % TICK_ORDER.length];

    if (index < 0) {
      this.editIssue((next) => {
        next.state = to;
      }, { issueState: to });
    } else {
      // Ticking the last row off finishes the issue, and the first one starts it —
      // so the node's ring answers a tick without anybody setting it by hand.
      const rolled = rollUp(doc.rows.map((row, at) => (at === index ? { ...row, state: to } : row)));
      this.editIssue(
        (next) => {
          if (next.rows[index]) next.rows[index].state = to;
          next.state = rolled;
        },
        { ticked: index, ...(rolled === doc.state ? {} : { issueState: rolled }) },
      );
    }
    this.renderIssue();
  }

  /** A row with words in it and no identifier yet: ask for its sub-issue. */
  private commitRow(index: number): void {
    const open = this.issue;
    const doc = open ? this.issueDoc(open.path) : null;
    const row = doc?.rows[index];
    if (!row || !row.title.trim() || row.identifier) return;
    this.editIssue(() => {}, { created: index });
  }

  private addRow(after: number): void {
    const at = after + 1;
    this.editIssue((doc) => {
      doc.rows.splice(at, 0, { state: "unstarted", title: "", identifier: null, target: null });
    }, {});
    this.renderIssue();
    this.focusRow(at);
    // Every new line re-opens the offer: click a note to point THIS one at it, keep
    // typing to skip — the same bargain the todo rows made.
    this.proposeRowLink(at);
  }

  /**
   * The card sits beside its node and rides the viewport with it.
   *
   * It is PART of the graph, so it scales with the zoom 1:1 — width, text, ticks, the
   * gap to its node, all of it — exactly as the sticky cards do. Zoom out and it shrinks
   * away with the notes around it; nothing here is clamped, because a card that kept its
   * own size while the graph got smaller would swell to cover half the picture.
   */
  private placeIssueCard(): void {
    const open = this.issue;
    const cy = this.cy;
    if (!open || !cy) return;
    const node = cy.getElementById(open.path);
    if (node.empty()) {
      this.closeIssue(); // the note went away from under it
      return;
    }
    const dot = node as NodeSingular;
    const zoom = cy.zoom();
    const at = dot.renderedPosition();
    const half = dot.renderedWidth() / 2;
    const width = CARD_W * zoom;
    const gap = 8 * zoom;
    // To the right of its node, or to the left when there is no room for it there.
    const room = this.container.clientWidth - (at.x + half + gap);
    const left = room > width ? at.x + half + gap : at.x - half - gap - width;
    open.el.style.left = `${Math.max(4, left)}px`;
    open.el.style.top = `${at.y - 16 * zoom}px`;
    open.el.style.width = `${width}px`;
    // Everything inside is sized in em, so this one number scales the whole card —
    // rows, circles, the identifier chip — in lockstep with the graph.
    open.el.style.fontSize = `${13 * zoom}px`;
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

  /** Public entry for the context menu's link actions — to a note, or to a typed one. */
  startLink(path: string, kind: DraftKind = "note"): void {
    const node = this.cy?.getElementById(path);
    if (node && node.nonempty()) this.startDraft(node as NodeSingular, kind);
  }

  /* ------------------------------------------------------------ link draft --- */

  private startDraft(source: NodeSingular, kind: DraftKind = "note", row: number | null = null): void {
    if (!this.cy) return;
    this.cy.elements().removeClass("faded").removeClass("highlight");
    this.draftSource = source.id();
    this.draftKind = kind;
    this.draftRow = row;
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
    this.handlers.onHint(
      row !== null
        ? "Click a note to point this line at it — typing (or Esc) leaves it without an arrow"
        : kind !== "note"
          ? `Click empty space to put the ${DRAFT_NAMES[kind]} there — Esc cancels`
          : "Click a note to link to it, or empty space to create one — Esc cancels",
    );
  }

  /**
   * A checklist line offers to point at a note, the way a todo row used to. The arrow
   * comes out of the issue's own icon — which is sitting just to the left of the open
   * card — and follows the cursor until a note is clicked. Typing instead keeps the line
   * arrowless, which is the same bargain as before: the offer costs nothing to refuse.
   */
  private proposeRowLink(row: number): void {
    const open = this.issue;
    const node = open ? this.cy?.getElementById(open.path) : null;
    if (!open || !node || node.empty()) return;
    this.clearDraft();
    this.startDraft(node as NodeSingular, "note", row);
  }

  /**
   * The aimed arrow landed on a note. The link is written into that line of the
   * markdown, so from then on it is an ordinary link in an ordinary note — and the
   * arrow on the canvas is the graph's own, counted in the note's backlinks like
   * every other. It is drawn at once rather than at the next rebuild.
   */
  private finishRowLink(node: NodeSingular): void {
    const row = this.draftRow;
    const open = this.issue;
    if (row === null || !open) return;
    // A folder box or the issue itself: not a target. The arrow stays armed.
    if (node.data("kind") !== "file" || node.id() === open.path) return;
    const target = noteName(node.id());
    this.clearDraft();
    this.handlers.onHint(null);
    this.editIssue((doc) => {
      if (doc.rows[row]) doc.rows[row].target = target;
    }, {});
    this.commitLink(open.path, node.id());
    this.renderIssue();
    this.focusRow(row);
  }

  /** Drops the offer without touching the line. */
  private cancelRowLink(): void {
    if (this.draftRow === null) return;
    this.clearDraft();
    this.handlers.onHint(null);
  }

  private finishDraftOnNode(node: NodeSingular): void {
    // A typed draft has no business landing on a note: silently turning it into a
    // note-to-note link is exactly where phantom connections came from. The draft
    // stays armed — empty space is the only thing that finishes it. The hint waits
    // a tick, or the click's own grab/free cycle wipes it before it is ever seen.
    if (this.draftKind !== "note") {
      const what = DRAFT_NAMES[this.draftKind];
      window.setTimeout(
        () => this.handlers.onHint(`A ${what} wants empty space — click beside the notes (Esc cancels)`),
        0,
      );
      return;
    }
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
    this.draftKind = "note";
    this.draftRow = null;
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

  /** Writes a freshly caught conversation URL onto the live node — no rebuild needed. */
  setGeminiUrl(path: string, url: string): void {
    const node = this.cy?.getElementById(path);
    if (node && node.nonempty()) node.data("gurl", url);
  }

  /** Likewise for a re-picked disk path — the node opens the new location at once. */
  setFsPath(path: string, target: string): void {
    const node = this.cy?.getElementById(path);
    if (node && node.nonempty()) node.data("fspath", target);
  }

  /** Likewise for the session id the Claude app has just minted — it is no longer pending. */
  setClaudeSession(path: string, session: string, folder?: string): void {
    const node = this.cy?.getElementById(path);
    if (!node || node.empty()) return;
    node.data("csession", session);
    node.data("cstarted", "");
    if (folder) node.data("cfolder", folder);
  }

  /** A note that has just been sent to Claude and has no id to show for it yet. */
  setClaudePending(path: string, folder: string, started: string): void {
    const node = this.cy?.getElementById(path);
    if (!node || node.empty()) return;
    node.data("cfolder", folder);
    node.data("cstarted", started);
  }

  /* --------------------------------------------------- what a session is doing --- */

  /** The session note at `path`, or null when that node is not one. */
  sessionNote(path: string): ReturnType<GraphView["sessionNodes"]>[number] | null {
    const node = this.cy?.getElementById(path);
    if (!node || node.empty() || node.data("ntype") !== "claude") return null;
    return {
      path,
      session: (node.data("csession") as string) || "",
      seen: Number(node.data("cseen")) || 0,
      folder: (node.data("cfolder") as string) || "",
      started: (node.data("cstarted") as string) || "",
    };
  }

  /** Every session note on the canvas, with what the graph knows about each. */
  sessionNodes(): Array<{
    path: string;
    session: string;
    seen: number;
    folder: string;
    started: string;
  }> {
    const cy = this.cy;
    if (!cy) return [];
    const out: ReturnType<GraphView["sessionNodes"]> = [];
    cy.nodes().forEach((node) => {
      if (node.data("ntype") !== "claude") return;
      out.push({
        path: node.id(),
        session: (node.data("csession") as string) || "",
        seen: Number(node.data("cseen")) || 0,
        folder: (node.data("cfolder") as string) || "",
        started: (node.data("cstarted") as string) || "",
      });
    });
    return out;
  }

  /** A polled state, onto the live node and its badge. `at` is the session's last turn. */
  setSessionState(path: string, state: SessionState, at: number): void {
    const node = this.cy?.getElementById(path);
    if (!node || node.empty()) return;
    if (node.data("cstate") === state && node.data("cat") === at) return;
    node.data("cstate", state);
    node.data("cat", at);
    this.drawSessionBadges();
  }

  /** The session's last turn as the last poll had it — what "seen up to here" means. */
  sessionActivity(path: string): number {
    const node = this.cy?.getElementById(path);
    return node && node.nonempty() ? Number(node.data("cat")) || 0 : 0;
  }

  /** Opening a session is reading it: the blue dot goes out at once, not at the next poll. */
  setSessionSeen(path: string, at: number): void {
    const node = this.cy?.getElementById(path);
    if (!node || node.empty()) return;
    node.data("cseen", at);
    if (node.data("cstate") === "unseen") node.data("cstate", "idle");
    this.drawSessionBadges();
  }

  /**
   * What each session is doing, on the top-left corner of its tile: a blinking grey dot
   * while Claude is working, amber when it is waiting on an answer, blue when a turn has
   * finished that nobody has looked at, and an empty ring the rest of the time — including
   * for a note that has never been run, which is a session that could be there and isn't.
   *
   * Left corner, not right: the node's label hangs off its right side, and a dot under the
   * first letters of the name is a dot nobody can read. Drawn in the overlay and sized off
   * the node, like the issue badge, so it rides the zoom; the blink is CSS, so it keeps
   * time while the canvas sits idle.
   */
  private drawSessionBadges(): void {
    const cy = this.cy;
    if (!cy) return;
    const alive = new Set<string>();
    if (this.settings.enabled("claude")) {
      cy.nodes().forEach((node) => {
        const dot = node as NodeSingular;
        if (dot.data("ntype") !== "claude") return;
        alive.add(dot.id());
        let el = this.sessionEls.get(dot.id());
        if (!el) {
          el = document.createElement("div");
          this.overlay.appendChild(el);
          this.sessionEls.set(dot.id(), el);
        }
        const state = ((dot.data("cstate") as SessionState) || "idle") as SessionState;
        el.className = `session-badge ${state}`;
        el.title = SESSION_TITLES[state];
        const at = dot.renderedPosition();
        const half = dot.renderedWidth() / 2;
        const size = (dot.width() / 2) * 0.5;
        el.style.left = `${at.x - half * 0.82}px`;
        el.style.top = `${at.y - half * 0.82}px`;
        el.style.width = `${size}px`;
        el.style.height = `${size}px`;
        el.style.transform = `translate(-50%, -50%) scale(${cy.zoom()})`;
      });
    }
    for (const [id, el] of this.sessionEls) {
      if (alive.has(id)) continue;
      el.remove();
      this.sessionEls.delete(id);
    }
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
  commitNode(
    path: string,
    label: string,
    parent: string | undefined,
    at: cytoscape.Position,
    type?: string,
    url?: string,
    fspath?: string,
  ): void {
    if (!this.cy || this.cy.getElementById(path).nonempty()) return;
    this.cy.add({
      group: "nodes",
      // Nothing links to it yet; the next rebuild sizes it from its real backlinks.
      data: {
        id: path,
        label,
        parent,
        kind: "file",
        size: nodeSize(0),
        ntype: type ?? "",
        ...(url ? { gurl: url } : {}),
        ...(fspath ? { fspath } : {}),
      },
      position: this.freeSpot(parent, at),
    });
    // Nothing links to it yet, but say so from the live graph rather than by assumption:
    // this is the one place a size is set without an edge having been drawn.
    this.resizeNode(path);
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
  commitLink(
    source: string,
    target: string,
    newNode?: {
      label: string;
      parent?: string;
      at: cytoscape.Position;
      type?: string;
      url?: string;
      fspath?: string;
    },
  ): void {
    if (!this.cy) return;
    if (newNode && this.cy.getElementById(target).empty()) {
      this.cy.add({
        group: "nodes",
        data: {
          id: target,
          label: newNode.label,
          parent: newNode.parent,
          kind: "file",
          size: nodeSize(0), // resized off the live graph the moment its edge is in
          ntype: newNode.type ?? "",
          ...(newNode.url ? { gurl: newNode.url } : {}),
          ...(newNode.fspath ? { fspath: newNode.fspath } : {}),
        },
        position: this.freeSpot(newNode.parent, newNode.at),
      });
    }
    const id = edgeId(source, target);
    if (this.cy.getElementById(id).empty()) {
      this.cy.add({ group: "edges", data: { id, source, target } });
    }
    // Both ends have one more connection than they did a moment ago, and both have to
    // say so now — see `resizeNode`.
    this.resizeNode(source);
    this.resizeNode(target);
    this.handlers.onHint(null);
  }

  /**
   * Brings a node's size back in line with the links it actually has.
   *
   * The LIVE graph is the authority, never a guess made when the node was added. A
   * provisional size only caught up at the next rebuild, and rebuilds are lazy — which
   * is how two issues with one arrow apiece ended up drawn at two different sizes,
   * depending on whether the graph had happened to be rebuilt since each was made.
   */
  private resizeNode(id: string): void {
    const node = this.cy?.getElementById(id);
    if (!node || node.empty() || node.data("kind") !== "file") return;
    // Links either way, which is what `buildElements` counts too. The half-drawn draft
    // edge is not one of them.
    const links = node.connectedEdges().filter((edge) => edge.id() !== DRAFT_EDGE).length;
    node.data("size", nodeSize(links));
  }
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
