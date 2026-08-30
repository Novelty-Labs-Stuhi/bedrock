// Graph view: notes are nodes, folders are compound boxes, [[wikilinks]] are edges.
// Styling follows cytoscape.js-cola's demo-compound.html; the layout is our own solver
// (`layout.ts` + `apply-layout.ts`) — no force simulation runs at any point.

import cytoscape from "cytoscape";
import type { Core, EdgeSingular, ElementDefinition, NodeSingular } from "cytoscape";
import {
  FrameStore,
  type FolderStyle,
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
import {
  LinkResolver,
  parseField,
  parseLinks,
  parseStyle,
  parseTags,
  parseType,
  type NodeStyle,
} from "./links";
import { NO_FENCE, PULSE_DEFAULT, paint, signIcon } from "./node-style";
import { ancestors, basename, dirname, noteName } from "./vault";
import { canvasHex, inkOn, type Look, type SettingsStore } from "./settings";
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
 * A note's chosen look, as the node carries it: the sign as the picture to engrave (a key
 * means nothing to cytoscape), the colours as they will be painted, and `radiating` as the
 * one thing the overlay asks about — whether there is a ring to beat.
 */
function styleData(style: NodeStyle): Record<string, string | number> {
  return {
    sign: signIcon(style.icon),
    scolour: paint(style.colour),
    anim: style.anim,
    acolour: paint(style.animColour) || PULSE_DEFAULT,
    radiating: style.anim === "pulse" ? 1 : 0,
  };
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
 * What a webpage node wears until the site's own icon has been fetched — and what it
 * keeps if the site offers none at all. A globe: equator, axis, one meridian and two
 * latitudes, which is the least drawing that still reads as "somewhere on the web" at
 * twenty pixels. 256px of raster for the reason the icons above are.
 */
const GLOBE_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 64 64">` +
      `<circle cx="32" cy="32" r="26" fill="#4c8dff"/>` +
      `<g fill="none" stroke="#eaf1ff" stroke-width="2.6" stroke-linecap="round">` +
      `<line x1="6" y1="32" x2="58" y2="32"/>` +
      `<line x1="32" y1="6" x2="32" y2="58"/>` +
      `<ellipse cx="32" cy="32" rx="12.5" ry="26"/>` +
      `<path d="M12.5 19c11 5.6 28 5.6 39 0"/>` +
      `<path d="M12.5 45c11-5.6 28-5.6 39 0"/>` +
      `</g></svg>`,
  );

/**
 * What a Freeform board node wears: Freeform's own icon, lifted from the app bundle
 * (AppIcon.icns, scaled to 128px and inlined) rather than redrawn — a board node should
 * read as THAT app at a glance, and the app already drew itself better than we would.
 */
const FREEFORM_ICON =
  "data:image/png;base64,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";

/**
 * What a Notion page node and an Apple note node wear: each app's own icon, lifted
 * the same way Freeform's was (the app bundle's AppIcon, scaled to 128px and inlined)
 * — a pointer node should read as THAT app at a glance.
 */
const NOTION_ICON =
  "data:image/png;base64,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";

const APPLE_NOTES_ICON =
  "data:image/png;base64,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";

/** And a Word document node: Word's own icon, lifted the same way. */
const WORD_ICON =
  "data:image/png;base64,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";

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
  // Somewhere on the web. Unlike every type above, the picture is not one this app
  // drew: it is the site's own icon, scraped once and carried on the node (`wicon`,
  // a globe until it arrives). It sits on a pale tile because half the favicons in
  // the world are a dark glyph on nothing, and nothing is what this canvas is.
  web: {
    shape: "round-rectangle",
    "background-image": "data(wicon)",
    "background-fit": "contain",
    "background-color": "#eef1f5",
    "background-opacity": 1,
    "pie-size": "0%",
  },
  // A Freeform board: the whiteboard tile, and a click opens the board in Freeform
  // itself — the note behind it holds only the pointer.
  freeform: {
    shape: "round-rectangle",
    "background-image": FREEFORM_ICON,
    "background-fit": "cover",
    "background-opacity": 0,
    "pie-size": "0%",
  },
  // A Notion page: the same bargain as a board — the note holds only the pointer, and
  // a click opens the page where it lives.
  notion: {
    shape: "round-rectangle",
    "background-image": NOTION_ICON,
    "background-fit": "cover",
    "background-opacity": 0,
    "pie-size": "0%",
  },
  // And an Apple note, the last of the siblings: a click opens it in Notes itself.
  applenote: {
    shape: "round-rectangle",
    "background-image": APPLE_NOTES_ICON,
    "background-fit": "cover",
    "background-opacity": 0,
    "pie-size": "0%",
  },
  // A Word document: a file of the user's own wearing Word's tile, and a click opens
  // it in Word — whatever app happens to own the double-click.
  word: {
    shape: "round-rectangle",
    "background-image": WORD_ICON,
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

/**
 * The same tiles, for anything outside the canvas that wants to speak the graph's
 * vocabulary — the context menus draw these beside each integration's name, so "Apple
 * note" in a menu looks like an Apple note on the graph.
 */
export const TYPE_ICONS: Record<string, string> = {
  gemini: GEMINI_ICON,
  linear: LINEAR_ICON,
  claude: CLAUDE_ICON,
  file: FILE_NODE_ICON,
  folder: FOLDER_NODE_ICON,
  web: GLOBE_ICON,
  freeform: FREEFORM_ICON,
  notion: NOTION_ICON,
  applenote: APPLE_NOTES_ICON,
  word: WORD_ICON,
};

const typeShapeStyles = (): cytoscape.StylesheetJson =>
  Object.entries(TYPE_STYLES).map(([type, style]) => ({
    selector: `node[ntype = "${type}"]`,
    style,
  })) as unknown as cytoscape.StylesheetJson;

/** First web link in a conversation note — what a click on its node opens. */
const URL_RE = /https?:\/\/[^\s)\]>]+/;

/**
 * demo-compound.html's style, plus labels (a note graph is unusable without them).
 *
 * A function rather than a constant, because four of its colours are the vault's to choose
 * (Settings → General): the ground, and what a note, a link and a folder look like before
 * anything says otherwise. Everything a note or folder chose FOR ITSELF still overrules
 * this, further down the sheet — a default is where you start, not what you get.
 *
 * The ink follows the ground rather than being picked: labels have to stay readable on a
 * pale canvas, and nobody should have to choose a text colour to get that.
 *
 * Names can also be taken off altogether (`look.captions`), which leaves the graph as
 * shapes and makes a name something you ask for by pointing at it: the hover handlers put
 * `.named` on whatever should speak, and the two rules at the foot of the sheet are what
 * lets it. Folder names are exempt — a box does not answer the mouse at all.
 */
function styleSheet(look: Look): cytoscape.StylesheetJson {
  const ground = canvasHex(look.bg);
  const ink = inkOn(ground);
  /** What a node or edge is labelled with when nothing is hovering it. */
  const name = look.captions ? "data(label)" : "";
  /**
   * A label the pointer asked for lands wherever the graph already is — over edges, over
   * other notes — so it is backed by the ground it sits on, the way edge labels always are.
   */
  const plate = {
    "text-background-color": ground,
    "text-background-opacity": 0.85,
    "text-background-padding": "2px",
    // `as const`: cytoscape's types take the shape from a fixed set, and a widened
    // `string` no longer fits the block this is spread into.
    "text-background-shape": "roundrectangle" as const,
  };
  const nodeHex = paint(look.node) || UNTAGGED;
  const edgeHex = paint(look.edge) || UNTAGGED;
  const folderHex = paint(look.folder) || BOX;
  return [
    {
      selector: "node",
      style: {
        "background-color": nodeHex,
        label: name,
        color: ink,
        "font-size": 10,
        "text-valign": "center",
        "text-halign": "right",
        "text-margin-x": 4,
        // A note named after a webpage carries whatever that page calls itself, and a post
        // calls itself by its first paragraph. Left to run, the name is a line of text laid
        // across the canvas over everything behind it; the tree and the tab still say it in
        // full, so the node says as much of it as a node has room for.
        "text-wrap": "ellipsis",
        "text-max-width": "150px",
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
    /*
     * A note's own look, chosen on the canvas (right-click → "Style…") and kept in its
     * markdown. After the type styles, so a chosen colour or sign beats the one a type
     * would have given it — the note was styled by hand, and by hand wins.
     *
     * `[?key]` — has a truthy value — and never `[key != ""]`, which also matches every
     * node that has no such key at all, and paints the whole graph with an undefined.
     *
     * A colour of its own replaces the tag pie: a note cannot be two colours at once, and
     * whoever painted it meant that colour rather than the ones its tags worked out to.
     */
    {
      selector: "node[?scolour]",
      style: { "background-color": "data(scolour)", "background-opacity": 1, "pie-size": "0%" },
    },
    // The sign is engraved on the node, not fitted to it: a fraction of the circle, centred,
    // with the node's colour left showing all round it.
    {
      selector: "node[?sign]",
      style: {
        "background-image": "data(sign)",
        "background-fit": "none",
        "background-width": "58%",
        "background-height": "58%",
        "background-position-x": "50%",
        "background-position-y": "50%",
        "background-image-opacity": 1,
        "background-opacity": 1,
      },
    },
    {
      selector: "node:parent",
      style: {
        "background-color": folderHex,
        // Said again rather than inherited: with names off, a box is the one thing that
        // keeps its own, because nothing can point at it to ask (`events: no`, below).
        label: "data(label)",
        // Almost see-through: the box is a boundary, and whatever it sits on top of
        // (another box, an edge passing under) has to stay readable through it.
        "background-opacity": 0.07,
        // The fence can be off for the whole vault, which leaves the fill and the name —
        // a grouping felt rather than drawn. A folder that chose a fence colour still gets
        // its line, below: choosing one is asking for one.
        "border-width": look.fence ? 1.5 : 0,
        "border-color": folderHex,
        "border-opacity": 0.9,
        "text-valign": "top",
        "text-halign": "center",
        "text-margin-x": 0,
        "text-margin-y": -4,
        "font-size": 12,
        color: folderHex,
        // No padding: the drawn border then sits exactly on the frame's corner anchors,
        // so where the box looks like it ends is where a note actually stops.
        padding: "0px",
        // A note's label hangs off its right side. Counted towards the parent's size it
        // would shove the border outwards as soon as a note was dragged near the edge —
        // the frame is the anchors, and only the anchors.
        "compound-sizing-wrt-labels": "exclude",
        /*
         * A box is not something the mouse can land on at all: it is a boundary drawn
         * round notes, and the ground inside it belongs to the canvas. So a drag started
         * in the middle of a folder pans the view exactly as it would out in the open, and
         * a rectangle can be drawn from inside one — navigation is never fenced in by a
         * folder that happens to be under the cursor.
         *
         * What the box still answers to is all elsewhere: the fence strips and corner
         * grips are in the overlay above the canvas (`drawHandles`), and every question of
         * the form "which folder is this point in?" is answered from the frames themselves
         * (`folderAt`) rather than by asking cytoscape what was hit.
         */
        events: "no",
      },
    },
    /*
     * A folder's own two colours, when it has been given them (right-click a box → "Style
     * folder…"). After the rule above, because they overrule it — a coloured box is still
     * a box in every other respect. The fill is lifted a little off the 7% every box gets:
     * a hue chosen on purpose should read as chosen, while still letting what is under the
     * box show through it. The fence can also be taken off altogether, leaving a patch of
     * coloured ground with a name on it — a grouping that is felt rather than drawn.
     *
     * The label is painted last and on its own key (`flabel`), because which colour it
     * should take depends: normally the fence's, so a box does not read as two things at
     * once, but the fill's when there is no fence to follow.
     */
    {
      selector: "node[?fbg]",
      style: { "background-color": "data(fbg)", "background-opacity": 0.13 },
    },
    { selector: "node[?ffence]", style: { "border-color": "data(ffence)", "border-width": 1.5 } },
    { selector: "node[?fenceoff]", style: { "border-width": 0 } },
    { selector: "node[?flabel]", style: { color: "data(flabel)" } },
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
        "line-color": edgeHex,
        width: 1.4,
        "curve-style": "bezier",
        "target-arrow-shape": "triangle",
        "target-arrow-color": edgeHex,
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
        label: name,
        "font-size": 9,
        // The same bargain the node labels strike: unreadable is not worth drawing.
        "min-zoomed-font-size": 7,
        color: ink,
        "text-rotation": "autorotate",
        ...plate,
      },
    },
    /*
     * The mark a right-click can put on a connection (see `applyMarks`): a radiating edge
     * is the line counterpart of a radiating note — the same green, with `syncEdgeBeat`
     * walking the dashes along it so the flow reads as flowing.
     */
    {
      selector: "edge.radiate",
      style: {
        "line-style": "dashed",
        "line-dash-pattern": [7, 5],
        "line-color": "#3fb950",
        "target-arrow-color": "#3fb950",
      },
    },
    { selector: ".faded", style: { opacity: 0.25 } },
    /*
     * A folder box's own way of standing back, for the same moment. It cannot use `.faded`
     * — `opacity` on a box is inherited by everything inside it, which is precisely the
     * problem this exists to avoid — so it dims each of its own three parts instead: the
     * fill, the fence and the name. Nothing there is a property of the notes inside.
     */
    {
      selector: "node.faded-box",
      style: { "background-opacity": 0.03, "border-opacity": 0.25, "text-opacity": 0.3 },
    },
    /*
     * The spotlight the pointer carries: what a hovered note is joined to, and what it is
     * joined by. Everything outside it is dimmed (`.faded`), which on its own only says
     * where NOT to look — so the lit group is lit rather than merely left behind.
     *
     * An edge takes the ink and thickens. The arrow is recoloured with the line, or a lit
     * edge keeps a red head that reads as a different edge crossing it.
     */
    {
      selector: "edge.highlight",
      style: { "line-color": ink, "target-arrow-color": ink, width: 2, "arrow-scale": 1.3 },
    },
    /*
     * A note takes a ring in the same ink and says its name in bold. The ring, not a
     * colour: a note's fill is its tags' answer (or its own chosen one), and a spotlight
     * that repainted it would be overwriting what the note is with where the pointer is.
     */
    {
      selector: "node.highlight",
      style: { "border-width": 2, "border-color": ink, "border-opacity": 1, "font-weight": "bold" },
    },
    // The note whose file is the open tab, and the connection whose note is. After the
    // spotlight, so a pointer passing over the thing you are editing does not thin its ring.
    { selector: "node.active", style: { "border-width": 3, "border-color": ink } },
    {
      selector: "edge.active",
      style: { "line-color": ink, "target-arrow-color": ink, width: 3, "arrow-scale": 1.1 },
    },
    // The link being drawn: an invisible cursor-following node plus an arrow to it.
    {
      selector: "node.draft",
      style: { width: 1, height: 1, "background-opacity": 0, label: "", events: "no" },
    },
    {
      selector: "edge.draft",
      style: {
        "line-color": ink,
        "line-style": "dashed",
        width: 2,
        "target-arrow-shape": "triangle",
        "target-arrow-color": ink,
        "curve-style": "straight",
        events: "no",
      },
    },
    { selector: "node.draft-source", style: { "border-width": 3, "border-color": ink } },
    // Folder box under a dragged note: dashed while resisting, solid once armed.
    {
      selector: "node.drop-hover",
      style: { "border-width": 2, "border-color": ink, "border-style": "dashed" },
    },
    {
      selector: "node.drop-armed",
      style: { "border-width": 3, "border-color": ink, "background-opacity": 0.22 },
    },
    // Leaving a folder reads differently from entering one.
    {
      selector: "node.drop-leaving",
      style: { "border-width": 3, "border-color": "#ffd166", "border-style": "dashed" },
    },
    // The invisible corner children that hold a folder box at a constant size.
    {
      selector: "node.frame-anchor",
      style: { width: 1, height: 1, "background-opacity": 0, label: "", events: "no" },
    },
    /*
     * With names off, this is how one is asked for: `.named` is put on whatever the pointer
     * is on and on everything that says what it is — its neighbours, and the links between
     * them (see the hover handlers in `wire`). Last in the sheet, so it beats the blank the
     * rules above left; and only present at all while names are off, since with them on every
     * node is already saying its own and the class would mean nothing.
     */
    ...(look.captions
      ? []
      : [
          { selector: "node.named", style: { label: "data(label)", ...plate } },
          { selector: "edge.named[label]", style: { label: "data(label)" } },
        ]),
  ];
}

/* ------------------------------------------------------------------- marks --- */

/**
 * The one status a right-click can set on a connection: radiating, the line counterpart of
 * a radiating note. A note keeps what it looks like in its own markdown (`sign::`,
 * `anim::` and the rest — see `parseStyle`), but an edge has no file of its own unless it
 * has been described, so edge marks live in this window's own storage, keyed by edge id.
 */
export type Mark = "radiate";

const MARKS_KEY = "obsidian-lite:edge-marks";

function readEdgeMarks(): Record<string, Mark> {
  try {
    const kept = JSON.parse(localStorage.getItem(MARKS_KEY) ?? "{}") as Record<string, unknown>;
    const out: Record<string, Mark> = {};
    for (const [id, mark] of Object.entries(kept)) {
      if (mark === "radiate") out[id] = mark;
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
function rimPoint(point: cytoscape.Position, bb: cytoscape.BoundingBox12): cytoscape.Position {
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
        // Likewise always present: `sync` patches the keys a definition carries, so an
        // empty string is what takes a sign back off a note that has just lost one.
        ...styleData(parseStyle(doc.text)),
        // A conversation node opens its link directly, so the URL rides on the node —
        // a click must not wait on a file read (popup blockers honour only the click).
        ...(type === "gemini" ? { gurl: URL_RE.exec(doc.text)?.[0] ?? "" } : {}),
        // A file/folder node opens what its `path::` points at, riding along the same way.
        ...(type === "file" || type === "folder" ? { fspath: parseField(doc.text, "path") ?? "" } : {}),
        // A webpage node opens its address the same way. The ICON is not in the file and
        // never will be: a scraped logo is cache, and what a vault of plain files keeps
        // is facts. It comes back on the node afterwards — see `paintWebIcons`.
        ...(type === "web"
          ? {
              wurl: parseField(doc.text, "url") ?? URL_RE.exec(doc.text)?.[0] ?? "",
              wicon: GLOBE_ICON,
            }
          : {}),
        // A board node opens its board the same way: the uuid rides the node. Empty is
        // a note whose board has not been made yet — a click makes it (see main.ts).
        ...(type === "freeform" ? { fboard: parseField(doc.text, "board") ?? "" } : {}),
        // A page node opens its page the same way: the address rides the node. Empty is
        // a note whose page has not been made yet — a click makes it (see main.ts).
        ...(type === "notion" ? { nurl: parseField(doc.text, "page") ?? "" } : {}),
        // And an Apple note node its note, over the id Apple minted for it.
        ...(type === "applenote" ? { anote: parseField(doc.text, "note") ?? "" } : {}),
        // A Word node opens its document off the path riding here; empty means the
        // document has not been made yet — a click makes it (see main.ts).
        ...(type === "word" ? { wdoc: parseField(doc.text, "doc") ?? "" } : {}),
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
export type DraftKind =
  | "note"
  | "gemini"
  | "claude"
  | "file"
  | "folder"
  | "web"
  | "freeform"
  | "notion"
  | "applenote"
  | "word";

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
  web: "webpage",
  file: "file link",
  folder: "folder link",
  freeform: "Freeform board",
  notion: "Notion page",
  applenote: "Apple note",
  word: "Word document",
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
   * Click on a webpage node: hand over the address stored on the node (null when the
   * note carries none) — it opens in the real browser, like every other web link here.
   */
  onOpenWeb: (path: string, url: string | null) => void;
  /**
   * Click on a Freeform board node: hand over the board uuid stored on the node — null
   * for a note whose board was never made, which is an invitation to make it.
   */
  onOpenFreeform: (path: string, board: string | null) => void;
  /**
   * Click on a Notion page node: hand over the page's address stored on the node — null
   * for a note whose page was never made, which is an invitation to make it.
   */
  onOpenNotion: (path: string, url: string | null) => void;
  /**
   * Click on an Apple note node: hand over the note id stored on the node — null, again,
   * for one that has not been made yet.
   */
  onOpenAppleNote: (path: string, note: string | null) => void;
  /**
   * Click on a Word document node: hand over the document's path stored on the node —
   * null for a note whose document was never made, which is an invitation to make it.
   */
  onOpenWord: (path: string, doc: string | null) => void;
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
   * A whole folder box was dragged by its fence into another one — or out of the one it
   * was in, in which case `folder` is where it lands ("" for the vault root). Folders
   * nest exactly as notes do; this is the same gesture on a bigger thing.
   */
  onRefolder: (path: string, folder: string) => void;
  /**
   * A rectangle was drawn around `picked`: put them in a new folder. Notes and whole
   * folder boxes alike — a rectangle round a box takes the box, not the notes out of it.
   * `frame` is the rectangle in model units, so the box appears exactly as it was drawn.
   */
  onGroup: (picked: Array<{ path: string; kind: "file" | "dir" }>, frame: Frame) => void;
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

/**
 * A folder is held by its fence, never by its inside. The inside of a box is where its
 * notes live and where the canvas is read; grabbing there used to pick the whole folder
 * up, so a drag meant to pan the view — or to draw a rectangle — moved a folder instead.
 * Now the border is the box's handle: these four strips lie along it, and everything
 * inside belongs to whatever is drawn there.
 */
const SIDES = ["top", "right", "bottom", "left"] as const;

/** How thick the grabbable border is, in screen pixels either side of the line. */
const FENCE = 11;

export class GraphView {
  private cy: Core | null = null;
  private pending: { docs: Doc[]; active: string | null; described: ReadonlySet<string> } | null = null;
  private sizeWatcher: ResizeObserver | null = null;
  private draftSource: string | null = null;
  /** What the open draft will create if it lands on empty space. */
  private draftKind: DraftKind = "note";
  private drag: DragState | null = null;
  private frames: FrameStore;
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
  /**
   * Address -> the site's icon, for as long as the app is open. Keyed by the address
   * rather than by the note, because that is what the icon belongs to: two notes about
   * the same page wear the same face, and a rebuild — which reverts every node's data
   * to what the FILES say, and the files do not say this — repaints from here.
   */
  private webIcons = new Map<string, string>();
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
    this.paintFolders();
    // The open card's note may have just left the canvas — a finished issue folds away.
    if (this.issue && cy.getElementById(this.issue.path).empty()) this.closeIssue();
    this.paintWebIcons(); // the definitions above carry a globe; the sites' own faces live here
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
    this.container.style.background = canvasHex(this.settings.look().bg);
    this.cy = cytoscape({
      container: this.container,
      elements: buildElements(docs, described),
      style: styleSheet(this.settings.look()),
      layout: LAYOUT,
      wheelSensitivity: 0.2,
      /*
       * Draw at twice the screen's own resolution, whatever it says that is.
       *
       * Cytoscape otherwise takes `devicePixelRatio` at its word, and a display reporting
       * 1 — a plain monitor, or a Mac in a scaled mode, where the window is rendered at
       * one size and resampled to another — gets one canvas pixel per CSS pixel. Native
       * text stays crisp through that because the OS re-renders it; a canvas cannot, so
       * the graph alone goes soft. Supersampling puts the detail back: circles, 10px
       * labels and the engraved signs are rasterised at 2× and scaled down.
       *
       * A retina display already gets 2 and is left alone. The cost is four times the
       * fill area per frame, which this graph can afford — there is no simulation running
       * behind it, and a repaint only happens when something actually moves.
       */
      pixelRatio: Math.max(2, window.devicePixelRatio || 1),
      /*
       * Off at rest, and flipped per gesture (see the wheel listener in `wire`): while
       * ZOOMING IN the canvas is drawn once to a texture and the texture is scaled,
       * instead of re-rendering a few hundred icon tiles, bezier arrows and labels at
       * 2× supersampling on every wheel tick — and zooming in is the one gesture where
       * a photograph of the screen is always the truth, because magnifying can never
       * reveal anything that was not already on it. Panning and zooming out DO reveal,
       * so they render live: the newly uncovered ground fills with real notes, and both
       * are the cheap direction anyway — what comes into view is drawn small.
       */
      textureOnViewport: false,
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
    this.paintFolders();
    this.paintWebIcons(); // a rebuild within one session keeps the faces already fetched
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
    this.fit();
    this.drawOverlay();
    this.ready = true; // restored — from here on, changes are worth saving
  }

  /** Frames go on only once the layout has placed the notes. */
  private settle(): void {
    if (!this.cy) return;
    layoutGraph(this.cy, this.frames);
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

  /**
   * Paints each folder box in the colours it has been given. Like the web icons, this is
   * not in any file the vault holds — a folder has no note of its own — so it is put back
   * on the nodes after every build and every sync, from the layout cache.
   */
  private paintFolders(): void {
    const cy = this.cy;
    if (!cy) return;
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        if (node.data("kind") !== "dir") return;
        const style = this.frames.style(node.id());
        const off = style.fence === NO_FENCE;
        const bg = paint(style.bg);
        const fence = off ? "" : paint(style.fence);
        node.data("fbg", bg);
        node.data("ffence", fence);
        node.data("fenceoff", off ? 1 : 0);
        // With a fence, the name goes with it; without one, with the ground it sits on.
        node.data("flabel", off ? bg : fence);
      });
    });
  }

  /** A folder's colours, as the layout cache has them — what the panel opens showing. */
  folderStyle(folder: string): FolderStyle {
    return this.frames.style(folder);
  }

  /** Colours a folder box, and remembers it beside the box's size. */
  setFolderStyle(folder: string, style: FolderStyle): void {
    this.frames.setStyle(folder, style);
    this.paintFolders();
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
          const folder = this.folderAt(cy, at)?.id() ?? node.id();
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
      // A webpage node is a bookmark wearing the site's face: clicking it goes to the
      // page. Whatever you have to say about the page goes in the note behind it, which
      // stays reachable from the tree.
      if (ntype === "web" && this.settings.enabled("web")) {
        this.handlers.onOpenWeb(node.id(), (node.data("wurl") as string) || null);
        return;
      }
      // A board node is a whiteboard's doorway: clicking it opens the board in Freeform.
      // The note behind it is only the pointer, and stays reachable from the tree.
      if (ntype === "freeform" && this.settings.enabled("freeform")) {
        this.handlers.onOpenFreeform(node.id(), (node.data("fboard") as string) || null);
        return;
      }
      // A page node is a Notion page's doorway, on exactly the same bargain.
      if (ntype === "notion" && this.settings.enabled("notion")) {
        this.handlers.onOpenNotion(node.id(), (node.data("nurl") as string) || null);
        return;
      }
      // And an Apple note node its note's, in Notes itself.
      if (ntype === "applenote" && this.settings.enabled("applenotes")) {
        this.handlers.onOpenAppleNote(node.id(), (node.data("anote") as string) || null);
        return;
      }
      // A Word node is a document's doorway: clicking it opens the file in Word.
      if (ntype === "word" && this.settings.enabled("word")) {
        this.handlers.onOpenWord(node.id(), (node.data("wdoc") as string) || null);
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
      // The boxes the lit notes are in stand with them: a spotlight on a note should say
      // where the note lives, not cut it out of its folder.
      const lit = neighborhood.union(neighborhood.nodes().ancestors());
      /*
       * The folder boxes are dimmed by their own class, and never by `.faded`: cytoscape
       * multiplies a node's opacity by every ancestor's, so fading the box a note sits in
       * fades the note inside it. A box is nobody's neighbour, so every box was in the
       * dimmed set — which is why hovering a note inside one dimmed the note being pointed
       * at, its name, and any neighbour sharing its folder, instead of lighting them up.
       */
      cy.elements().difference(lit).difference(":parent").addClass("faded");
      cy.nodes(":parent").difference(lit).addClass("faded-box");
      // Both halves of the spotlight: the notes themselves as well as the links between
      // them. Not the ancestors — a box is the room, not one of the things lit in it.
      neighborhood.addClass("highlight");
      // A vault with names off asks for them by pointing: the note's own, its neighbours',
      // and what the links between them are called. That is the same neighbourhood the
      // highlight already works out, so it is the same one that speaks.
      if (this.namesOnDemand()) neighborhood.addClass("named");
    });
    cy.on("mouseout", "node", () => {
      if (this.draftSource) return;
      this.clearSpotlight();
    });

    // Nothing on the line itself says it can be opened, so the status bar says it.
    cy.on("mouseover", "edge", (event) => {
      if (this.draftSource || this.drag) return;
      const edge = event.target as EdgeSingular;
      const title = edgeTitle(edge.source().id(), edge.target().id());
      this.handlers.onHint(
        edge.data("described") ? `Open "${title}"` : `Click to describe the flow: ${title}`,
      );
      // The line's own name, and the two notes it joins — a relation read off a bare line
      // ("built with") says nothing without both ends of it.
      if (this.namesOnDemand()) {
        edge.addClass("named");
        edge.connectedNodes().addClass("named");
      }
    });
    cy.on("mouseout", "edge", () => {
      if (this.draftSource || this.drag) return;
      this.handlers.onHint(null);
      this.clearSpotlight();
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

    cy.on("pan zoom", () => {
      // A pan/zoom the app did itself (fit) must not count as the user taking over the view.
      if (!this.fitting) this.userMoved = true;
      this.drawOverlay();
      this.followRename();
      this.followConnection();
    });

    /*
     * The per-gesture texture switch. Cytoscape owns one flag for every viewport
     * gesture, but its renderer reads it afresh on every pass — so flipping it between
     * events splits the gestures. A wheel tick that zooms IN draws from the photograph
     * (magnifying can never reveal anything, and it is the expensive direction); a tick
     * that zooms OUT renders live, so the ground it uncovers fills with real notes; and
     * a drag-pan starts by switching live for the same reason. Reaching into the
     * renderer is off the public API, so not finding the flag just means everything
     * renders live — correct, only slower.
     */
    try {
      const renderer = (cy as unknown as { renderer(): { textureOnViewport?: boolean } }).renderer();
      if (renderer && "textureOnViewport" in renderer) {
        this.container.addEventListener(
          "wheel",
          (event) => {
            renderer.textureOnViewport = event.deltaY < 0;
          },
          { capture: true, passive: true },
        );
        this.container.addEventListener(
          "pointerdown",
          () => {
            renderer.textureOnViewport = false;
          },
          { capture: true, passive: true },
        );
      }
    } catch {
      /* a future cytoscape hid its renderer — live everywhere is still right */
    }
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

    // A box the note is ALREADY in is not a box it is entering. Its own folder, and — for a
    // folder inside a folder — every box that folder sits in: the pointer is inside all of
    // them at once, so skipping only the innermost one left the note "entering" its own
    // grandparent from the first pixel of every drag, and a nudge refiled it one level up.
    const enclosing = (id: string): boolean =>
      drag.parent !== null && (id === drag.parent || drag.parent.startsWith(id + "/"));
    const entering = this.folderAt(cy, pointer, enclosing);
    if (entering) {
      const bb = this.frameRect(cy, entering.id());
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
    // The frame, not `box.boundingBox()`: a parent's measured box takes in its children
    // and their labels, so the border a note is being pulled through would sit some way
    // outside the one that is drawn — and further out on the side the labels hang off.
    const bb = this.frameRect(cy, drag.parent);
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
    return this.folderAt(cy, point)?.id() ?? null;
  }

  /** Deepest folder box containing `point`, ignoring the node's current folder. */
  /**
   * A folder's rectangle as it is DRAWN — its frame — rather than as cytoscape measures
   * it. The two part company exactly when it matters: a compound parent's bounding box is
   * the union of everything inside it, so a note (or a nested box) being dragged towards
   * the border stretches the box it is leaving, and the border it is being measured
   * against runs away ahead of it. The frame does not move until it is moved.
   */
  private frameRect(cy: Core, folder: string): cytoscape.BoundingBox12 {
    const box = cy.getElementById(folder) as NodeSingular;
    const centre = frameCentre(cy, folder);
    if (!centre) return box.boundingBox();
    const frame = this.frames.get(folder);
    return {
      x1: centre.x - frame.w / 2,
      x2: centre.x + frame.w / 2,
      y1: centre.y - frame.h / 2,
      y2: centre.y + frame.h / 2,
    };
  }

  private folderAt(
    cy: Core,
    point: cytoscape.Position,
    skip: (folder: string) => boolean = () => false,
  ): NodeSingular | null {
    let best: NodeSingular | null = null;
    cy.nodes(":parent").forEach((box) => {
      if (isAnchor(box.id()) || skip(box.id())) return;
      const bb = this.frameRect(cy, box.id());
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
      "Drag a rectangle around the notes (or whole folders) to put them in a new folder — Esc to cancel (shift+drag does this any time)",
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
      this.handlers.onHint(count === 1 ? "1 thing — release to group it" : `${count} things — release to group them`);
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      rect.remove();
      const picked = this.notesIn(area);
      this.cancelGroup();
      if (!picked.length) {
        this.handlers.onHint("nothing in that rectangle — nothing grouped");
        return;
      }
      const zoom = cy.zoom();
      this.handlers.onGroup(picked, {
        w: Math.max(160, (area.x2 - area.x1) / zoom),
        h: Math.max(120, (area.y2 - area.y1) / zoom),
      });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  /**
   * What a rectangle drawn in rendered (screen) coordinates has caught.
   *
   * A note counts when its centre is inside; a folder box only when the WHOLE box is,
   * because half a box inside a rectangle means the rectangle was drawn around some of
   * its notes, not around it. A box that is caught takes its notes with it as its own
   * children, so they drop out of the list — grouping `ideas` must produce a folder
   * holding `ideas`, not one holding `ideas` and a loose copy of everything in it.
   */
  private notesIn(area: Area): Array<{ path: string; kind: "file" | "dir" }> {
    const cy = this.cy;
    if (!cy) return [];
    const boxes: string[] = [];
    cy.nodes(":parent").forEach((node) => {
      if (isAnchor(node.id())) return;
      const bb = (node as NodeSingular).renderedBoundingBox();
      if (bb.x1 >= area.x1 && bb.x2 <= area.x2 && bb.y1 >= area.y1 && bb.y2 <= area.y2) boxes.push(node.id());
    });
    const inside = (path: string): boolean => boxes.some((box) => path.startsWith(box + "/"));
    const picked: Array<{ path: string; kind: "file" | "dir" }> = boxes
      .filter((box) => !inside(box))
      .map((path) => ({ path, kind: "dir" as const }));
    cy.nodes().forEach((node) => {
      if (node.data("kind") !== "file" || isAnchor(node.id()) || inside(node.id())) return;
      const at = (node as NodeSingular).renderedPosition();
      if (at.x >= area.x1 && at.x <= area.x2 && at.y >= area.y1 && at.y <= area.y2) {
        picked.push({ path: node.id(), kind: "file" });
      }
    });
    return picked;
  }

  /** Sizes a folder's box before it first appears — used to box a group as drawn. */
  presetFrame(folder: string, frame: Frame): void {
    this.frames.set(folder, frame);
  }

  /**
   * Frames are keyed by path, so a folder that is renamed — or filed inside another one —
   * has to be handed its size and its colours under the new name. Every box nested under
   * it too: their paths change with their parent's, and a frame left behind under the old
   * name is a box that comes back the default size in the default blue.
   */
  carryFrame(from: string, to: string): void {
    const carry = (was: string, now: string): void => {
      this.frames.set(now, this.frames.get(was), this.frames.isPinned(was));
      this.frames.setStyle(now, this.frames.style(was));
    };
    carry(from, to);
    this.cy?.nodes(":parent").forEach((node) => {
      const id = node.id();
      if (isAnchor(id) || !id.startsWith(from + "/")) return;
      carry(id, to + id.slice(from.length));
    });
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

  /** One overlay pass per painted frame, however many things asked for one. */
  private overlayQueued = false;

  /**
   * Everything the app itself paints above the canvas, in one pass — coalesced onto
   * the next animation frame. A wheel zoom fires dozens of events per second, and each
   * used to reposition every badge, sticky, pulse and frame handle synchronously; now
   * however many asks arrive between two frames, the work happens once, when the frame
   * is actually drawn.
   */
  private drawOverlay(): void {
    if (this.overlayQueued) return;
    this.overlayQueued = true;
    requestAnimationFrame(() => {
      this.overlayQueued = false;
      this.drawHandles();
      this.placeStickies();
      this.drawPulses();
      this.placeIssueCard();
      this.drawIssueBadges();
      this.drawSessionBadges();
    });
  }

  /** Re-applies the feature toggles to everything drawn above the canvas. */
  refreshOverlay(): void {
    this.applyMarks(); // the marks follow the same toggle as the pulses
    this.drawOverlay();
  }

  /**
   * Whether this vault has taken the names off the canvas, so a name is something the
   * pointer asks for. Read from the settings each time rather than cached: the switch is
   * in the same window as the colours, and the answer has to change with it.
   */
  private namesOnDemand(): boolean {
    return !this.settings.look().captions;
  }

  /**
   * Back to the resting canvas: nothing dimmed, nothing lit, nothing speaking that was
   * only speaking because the pointer was on it. Every way out of a hover ends here —
   * the pointer leaving, a link draft starting under it, the settings window opening
   * over it — because a spotlight left behind is one nothing will ever come and clear.
   */
  private clearSpotlight(): void {
    this.cy
      ?.elements()
      .removeClass("faded")
      .removeClass("faded-box")
      .removeClass("highlight")
      .removeClass("named");
  }

  /**
   * Re-paints the canvas in the vault's chosen colours (Settings → General). A restyle
   * rather than a rebuild: nothing about WHICH notes are on screen or where they sit has
   * changed, and a rebuild would throw away the arrangement to put it straight back.
   */
  applyLook(): void {
    const look = this.settings.look();
    this.container.style.background = canvasHex(look.bg);
    this.cy?.style(styleSheet(look));
    // A hover interrupted by the settings window never got its mouseout, so whatever it
    // left lit or speaking is cleared here — otherwise it would still be lit, unpointed-at.
    this.clearSpotlight();
    // The folders' own colours are painted onto node data, which the new sheet reads —
    // and the badges sit on top of the canvas rather than in it.
    this.paintFolders();
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
        // The ring's colour is the note's own choice, handed to CSS as a variable so the
        // animation stays one rule rather than one per colour anybody might pick.
        el.style.setProperty("--pulse", String(dot.data("acolour") || PULSE_DEFAULT));
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

  /**
   * Dresses a note on the live graph, so the canvas answers the pick in the panel rather
   * than waiting for the write to the vault behind it to come back round.
   */
  setNodeStyle(path: string, style: NodeStyle): void {
    const node = this.cy?.getElementById(path);
    if (!node || node.empty()) return;
    for (const [key, value] of Object.entries(styleData(style))) node.data(key, value);
    this.drawPulses();
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
   * Dresses every connection to its mark. A class rather than a data selector, so the
   * whole wardrobe comes off at once when the integration is toggled away — the marks
   * themselves stay put in the store, for when it comes back.
   */
  private applyMarks(): void {
    const cy = this.cy;
    if (!cy) return;
    const on = this.settings.enabled("active");
    cy.batch(() => {
      cy.edges().forEach((edge) => {
        edge.toggleClass("radiate", on && this.edgeMarks[edge.id()] === "radiate");
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
   * A box's handles: a grip on each of its four corners to resize it, and a strip along
   * each of its four sides to move it by. All invisible, so nothing is drawn on the
   * canvas; the box's own border is the thing being aimed at, and the cursor changing on
   * approach is the whole affordance.
   */
  private drawHandles(): void {
    const cy = this.cy;
    if (!cy) return;
    const wanted = new Set<string>();
    cy.nodes(":parent").forEach((node) => {
      const box = node as NodeSingular;
      if (isAnchor(box.id())) return;
      const bb = box.renderedBoundingBox();
      // The fence first, the corners after: they overlap at the four ends, and a corner
      // has to win there, or a box could never be resized from anywhere but its sides.
      for (const side of SIDES) {
        const key = `${box.id()} !${side}`;
        wanted.add(key);
        let strip = this.handles.get(key);
        if (!strip) {
          strip = document.createElement("div");
          strip.className = "frame-fence";
          strip.title = `Drag to move "${box.id()}"`;
          strip.addEventListener("mousedown", (event) => this.beginMove(event, box.id()));
          this.overlay.appendChild(strip);
          this.handles.set(key, strip);
        }
        const across = side === "top" || side === "bottom";
        strip.style.left = `${across || side === "left" ? bb.x1 : bb.x2}px`;
        strip.style.top = `${!across || side === "top" ? bb.y1 : bb.y2}px`;
        strip.style.width = `${across ? Math.max(0, bb.x2 - bb.x1) : FENCE}px`;
        strip.style.height = `${across ? FENCE : Math.max(0, bb.y2 - bb.y1)}px`;
      }
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

  /**
   * Drags a whole folder by its fence: the box, the notes in it, and any folder nested
   * inside it, all as one thing. Everything with a position of its own moves by the same
   * delta — the anchors that ARE the frame included — so nothing inside shifts relative
   * to anything else and the arrangement travels intact.
   *
   * Where it is let go decides where it belongs. Dropped well inside another box, the
   * folder is filed under it; pulled well clear of the one it was in, it moves out to
   * that folder's own parent. "Well" is `DROP_DEPTH`, measured from the moving box's
   * centre — brushing past a box on the way somewhere else must never refile anything.
   */
  private beginMove(event: MouseEvent, folder: string): void {
    const cy = this.cy;
    if (!cy) return;
    event.preventDefault();
    event.stopPropagation();
    const box = cy.getElementById(folder) as NodeSingular;
    const home = frameCentre(cy, folder);
    if (box.empty() || !home) return;

    const start = { x: event.clientX, y: event.clientY };
    const zoom = cy.zoom();
    const parent = box.parent().first();
    const from = parent.nonempty() ? parent.id() : null;
    // Anchors included: they are the frame, so they have to travel with what they frame.
    const riders = box
      .descendants()
      .filter((node) => !node.isParent())
      .map((node) => ({ node: node as NodeSingular, from: { ...(node as NodeSingular).position() } }));

    let target: string | null = null;
    let armed = false;

    const onMove = (move: MouseEvent): void => {
      const dx = (move.clientX - start.x) / zoom;
      const dy = (move.clientY - start.y) / zoom;
      cy.batch(() => {
        for (const rider of riders) rider.node.position({ x: rider.from.x + dx, y: rider.from.y + dy });
      });
      this.clearDropMarks(cy);
      const centre = { x: home.x + dx, y: home.y + dy };
      // Ids are paths, so a folder's own subtree is skipped: nothing may be filed inside
      // something it already contains.
      const into = this.folderAt(cy, centre, (id) => id === folder || id.startsWith(folder + "/"));
      target = null;
      armed = false;
      if (into && into.id() !== from) {
        const bb = this.frameRect(cy, into.id());
        const depth = Math.min(centre.x - bb.x1, bb.x2 - centre.x, centre.y - bb.y1, bb.y2 - centre.y);
        target = into.id();
        armed = depth >= DROP_DEPTH;
        into.addClass(armed ? "drop-armed" : "drop-hover");
        this.handlers.onHint(
          armed
            ? `Release to file ${basename(folder)} under ${into.id()}`
            : `Push further in to file ${basename(folder)} under ${into.id()}`,
        );
      } else if (from !== null) {
        // Either out in the open, or still over the box it belongs to: both are the same
        // question — has it been pulled far enough clear of that box to leave it?
        const out = cy.getElementById(from) as NodeSingular;
        const bb = this.frameRect(cy, from);
        const outside = Math.max(bb.x1 - centre.x, centre.x - bb.x2, bb.y1 - centre.y, centre.y - bb.y2);
        target = dirname(from); // "" == the vault root
        armed = outside >= DROP_DEPTH;
        if (outside > 0) out.addClass(armed ? "drop-armed" : "drop-leaving");
        this.handlers.onHint(
          armed
            ? `Release to move ${basename(folder)} out to ${target || "the vault root"}`
            : outside > 0
              ? `Keep pulling to move ${basename(folder)} out of ${from}`
              : null,
        );
      } else {
        this.handlers.onHint(null);
      }
      this.drawOverlay();
    };

    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      this.clearDropMarks(cy);
      this.capture(); // wherever the box came to rest is where it should be next time
      if (armed && target !== null && target !== from) this.handlers.onRefolder(folder, target);
      else this.handlers.onHint(null);
      this.drawOverlay();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
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
    /*
     * What is inside stays exactly where it is. Notes used to be scaled with the frame,
     * which meant enlarging a box spread its notes across the new width — and enlarging a
     * box is what somebody does when they want ROOM: space to put the next note in, or
     * space around the ones already there. So the box grows away from the corner opposite
     * the one being dragged, and the notes hold their ground. Shrinking is the one case
     * where they move, and only the ones that would end up outside — `setFrame` clamps
     * them back inside the border rather than letting them push it open.
     */

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
      this.frames.set(folder, next, true); // dragging a corner pins the size
      setFrame(cy, folder, centre, next); // moves the anchors, and clamps what falls out
      this.drawOverlay();
      this.handlers.onHint(`${folder}: ${Math.round(next.w)} × ${Math.round(next.h)}`);
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      this.handlers.onHint(null);
      this.capture(); // the frame changed, and anything it clamped moved with it
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
    this.clearSpotlight();
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

  /** Likewise for a board made after its note — the node opens it at once. */
  setFreeformBoard(path: string, board: string): void {
    const node = this.cy?.getElementById(path);
    if (node && node.nonempty()) node.data("fboard", board);
  }

  /** Likewise for a page made after its note. */
  setNotionPage(path: string, url: string): void {
    const node = this.cy?.getElementById(path);
    if (node && node.nonempty()) node.data("nurl", url);
  }

  /** And for an Apple note made after its note here. */
  setAppleNote(path: string, note: string): void {
    const node = this.cy?.getElementById(path);
    if (node && node.nonempty()) node.data("anote", note);
  }

  /** And for a document made after its note. */
  setWordDoc(path: string, doc: string): void {
    const node = this.cy?.getElementById(path);
    if (node && node.nonempty()) node.data("wdoc", doc);
  }

  /** Likewise for a re-typed address, when the note was left without one. */
  setWebUrl(path: string, url: string): void {
    const node = this.cy?.getElementById(path);
    if (!node || node.empty()) return;
    node.data("wurl", url);
    node.data("wicon", this.webIcons.get(url) ?? GLOBE_ICON);
  }

  /**
   * The site's icon has come back. Kept against the address, so every node pointing at
   * that page puts it on at once — and so does any node built later.
   */
  setWebIcon(url: string, icon: string): void {
    if (!url || !icon) return;
    this.webIcons.set(url, icon);
    this.paintWebIcons();
  }

  /** Every webpage node on the canvas, and whether it is still wearing the globe. */
  webNodes(): Array<{ path: string; url: string; fetched: boolean }> {
    const cy = this.cy;
    if (!cy) return [];
    const out: ReturnType<GraphView["webNodes"]> = [];
    cy.nodes().forEach((node) => {
      if (node.data("ntype") !== "web") return;
      const url = (node.data("wurl") as string) || "";
      out.push({ path: node.id(), url, fetched: this.webIcons.has(url) });
    });
    return out;
  }

  /**
   * Puts the remembered icons back on. Runs after every build and every sync, because
   * both take a node's data from the note's own markdown — where the icon deliberately
   * is not — and would otherwise blank a fetched face back to a globe on every edit.
   */
  private paintWebIcons(): void {
    const cy = this.cy;
    if (!cy || !this.webIcons.size) return;
    cy.nodes().forEach((node) => {
      if (node.data("ntype") !== "web") return;
      const icon = this.webIcons.get((node.data("wurl") as string) || "");
      if (icon && node.data("wicon") !== icon) node.data("wicon", icon);
    });
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
        // `url` is whatever the node opens; which key it rides on is the type's business.
        ...(url
          ? type === "web"
            ? { wurl: url, wicon: this.webIcons.get(url) ?? GLOBE_ICON }
            : type === "freeform"
              ? { fboard: url }
              : type === "notion"
                ? { nurl: url }
                : type === "applenote"
                  ? { anote: url }
                  : type === "word"
                    ? { wdoc: url }
                    : { gurl: url }
          : {}),
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
          ...(newNode.url
            ? newNode.type === "web"
              ? { wurl: newNode.url, wicon: this.webIcons.get(newNode.url) ?? GLOBE_ICON }
              : newNode.type === "freeform"
                ? { fboard: newNode.url }
                : newNode.type === "notion"
                  ? { nurl: newNode.url }
                  : newNode.type === "applenote"
                    ? { anote: newNode.url }
                    : newNode.type === "word"
                      ? { wdoc: newNode.url }
                      : { gurl: newNode.url }
            : {}),
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
