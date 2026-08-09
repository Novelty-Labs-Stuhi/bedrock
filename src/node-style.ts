// A note's LOOK on the canvas: a sign engraved on its node, the colour of the node
// itself, an animation around it, and that animation's colour. Four independent
// choices — this file holds what there is to choose from, and the little panel that
// does the choosing. What a choice MEANS to the canvas lives in `graph.ts`; where it
// is kept (`sign:: star` and friends, in the note's own markdown) lives in `links.ts`.

import type { FolderStyle } from "./frames";
import type { NodeStyle } from "./links";

/* -------------------------------------------------------------------- signs --- */

/**
 * A sign is drawn twice: once in white, nudged down a pixel and a half, then again in
 * black over the top. The white peeking out below the black reads as light catching the
 * lower lip of a cut — the mark looks pressed INTO the node rather than stuck onto it,
 * and it does so on a node of any colour, which a single-colour glyph cannot.
 *
 * `INK` is the placeholder each body paints with; 256px of raster so a sign stays crisp
 * zoomed well past the size a node is normally drawn at.
 */
const engraved = (body: string): string => {
  const ink = (colour: string): string => body.replace(/INK/g, colour);
  return (
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 64 64">` +
        `<g opacity="0.45" transform="translate(0 1.7)">${ink("#ffffff")}</g>` +
        `<g opacity="0.62">${ink("#000000")}</g>` +
        `</svg>`,
    )
  );
};

/** A stroked glyph — a check, a ray — written the same way as a filled one. */
const line = (d: string, width = 7): string =>
  `<path d="${d}" fill="none" stroke="INK" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;

const SUN_RAYS = [0, 45, 90, 135, 180, 225, 270, 315]
  .map((angle) => {
    const radians = (angle * Math.PI) / 180;
    const point = (reach: number): string =>
      `${(32 + Math.cos(radians) * reach).toFixed(1)} ${(32 + Math.sin(radians) * reach).toFixed(1)}`;
    return line(`M${point(19)} L${point(27)}`, 5);
  })
  .join("");

/**
 * The dozen signs a note can wear. Simple shapes on purpose: a node is twenty pixels
 * across at the zoom a whole vault is read at, and anything with detail in it turns to
 * fuzz there. Each is a statement somebody might want to make about a note at a glance —
 * this one matters, this one is hot, this one is done, this one is a question.
 */
export const SIGNS: Array<{ key: string; name: string; body: string }> = [
  {
    key: "star",
    name: "Star",
    body: `<path d="M32 7 39.6 24.6 58.6 26.4 44.3 39 48.5 57.6 32 47.8 15.5 57.6 19.7 39 5.4 26.4 24.4 24.6Z" fill="INK"/>`,
  },
  {
    key: "heart",
    name: "Heart",
    body: `<path d="M32 56C8 40 6 24 17.5 18c7.1-3.7 12.5.6 14.5 4.4 2-3.8 7.4-8.1 14.5-4.4C58 24 56 40 32 56Z" fill="INK"/>`,
  },
  { key: "bolt", name: "Bolt", body: `<path d="M37 4 15 35h12.5L26 60 49 27H35Z" fill="INK"/>` },
  {
    key: "flame",
    name: "Flame",
    body: `<path d="M32 5c9 13 18 18 18 31.5a18 18 0 0 1-36 0C14 27 20 24 24 17c1.5 5 4 8 8 9-1-8-1-15 0-21Z" fill="INK"/>`,
  },
  {
    key: "leaf",
    name: "Leaf",
    body: `<path d="M54 10c0 28-16 45-42 44C10 28 26 10 54 10Z" fill="INK"/>`,
  },
  {
    key: "moon",
    name: "Moon",
    body: `<path d="M42 6a26 26 0 1 0 12 36A21 21 0 0 1 42 6Z" fill="INK"/>`,
  },
  {
    key: "sun",
    name: "Sun",
    body: `<circle cx="32" cy="32" r="13" fill="INK"/>${SUN_RAYS}`,
  },
  {
    key: "eye",
    name: "Eye",
    // One path, two subpaths: the pupil is a hole cut in the almond rather than a
    // black dot on it, so the node's own colour shows through the middle.
    body:
      `<path fill-rule="evenodd" fill="INK" d="M4 32C16 15 48 15 60 32 48 49 16 49 4 32Z` +
      `M40 32a8 8 0 1 0-16 0 8 8 0 0 0 16 0Z"/>`,
  },
  {
    key: "pin",
    name: "Pin",
    body:
      `<path fill-rule="evenodd" fill="INK" d="M32 6a15 15 0 0 1 15 15c0 11.5-15 31-15 31S17 32.5 17 21A15 15 0 0 1 32 6Z` +
      `M32 27a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z"/>`,
  },
  {
    key: "flag",
    name: "Flag",
    body: `<path d="M16 6h5v52h-5z" fill="INK"/><path d="M22 10h28l-7 10 7 10H22z" fill="INK"/>`,
  },
  { key: "check", name: "Check", body: line("M13 33 26 46 51 17", 9) },
  {
    key: "bang",
    name: "Bang",
    body: `<path d="M27.5 8h9l-1.7 30h-5.6z" fill="INK"/><circle cx="32" cy="50" r="5" fill="INK"/>`,
  },
];

const SIGN_URIS = new Map(SIGNS.map((sign) => [sign.key, engraved(sign.body)]));

/** The picture for a sign key — empty for "no sign", and for a key nobody drew. */
export const signIcon = (key: string): string => SIGN_URIS.get(key) ?? "";

/* ------------------------------------------------------------------ colours --- */

/**
 * The palette, for the node and for what pulses around it. Ten hues far enough apart to
 * be told apart at twenty pixels, all of them light enough to carry a black-and-white
 * engraving. A note with no colour of its own keeps its tags' pie, which is the default
 * and the reason "None" is a swatch rather than a missing one.
 *
 * A note keeps the NAME — `color:: blue`, not `color:: #4c8dff`. Partly because a name is
 * what somebody editing the file by hand can write without looking anything up, and partly
 * because a hex IS a tag: `#4c8dff` in a note reads as `#4c8dff` to the tag parser, and the
 * note would have quietly coloured its own pie on the way past.
 */
export const COLOURS: Array<{ key: string; name: string; hex: string }> = [
  { key: "red", name: "Red", hex: "#f85149" },
  { key: "orange", name: "Orange", hex: "#f0883e" },
  { key: "amber", name: "Amber", hex: "#e3b341" },
  { key: "green", name: "Green", hex: "#3fb950" },
  { key: "teal", name: "Teal", hex: "#2dd4bf" },
  { key: "blue", name: "Blue", hex: "#4c8dff" },
  { key: "indigo", name: "Indigo", hex: "#8b7cff" },
  { key: "violet", name: "Violet", hex: "#c56cf0" },
  { key: "pink", name: "Pink", hex: "#ff6ac1" },
  { key: "slate", name: "Slate", hex: "#8b949e" },
];

const COLOUR_HEX = new Map(COLOURS.map((colour) => [colour.key, colour.hex]));

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * The colour a note asked for, as something to paint with: one of the palette's names, or
 * a hex somebody typed in themselves — the field is theirs, and a name it does not know is
 * no colour at all rather than a guess.
 */
export const paint = (token: string): string =>
  COLOUR_HEX.get(token) ?? (HEX_RE.test(token) ? token : "");

/** What a pulse is, when the note asked for one without saying in what colour. */
export const PULSE_DEFAULT = "#3fb950";

/** And what a folder box is, until somebody colours it — `BOX` over in `graph.ts`. */
export const FOLDER_BLUE = "#4c8dff";

/**
 * A fence can also be taken away altogether: `fence:: none` is not a colour but the
 * absence of one, and a folder wearing it is a patch of coloured ground with a name on
 * it and no line round the outside. Its own word rather than an empty string, because
 * empty already means "whatever a folder normally looks like".
 */
export const NO_FENCE = "none";

/* --------------------------------------------------------------- animations --- */

/** For now the pulsar and nothing else — the ring `graph.ts` beats out of a node's rim. */
export const ANIMS: Array<{ key: string; name: string }> = [{ key: "pulse", name: "Pulsar" }];

/* ------------------------------------------------------------------- picker --- */

let host: HTMLElement | null = null;
let dismiss: (() => void) | null = null;

export function closeStylePicker(): void {
  dismiss?.();
}

const swatch = (selected: boolean, extra = ""): string =>
  `class="style-swatch${selected ? " on" : ""}"${extra}`;

/**
 * A row of the palette. The first swatch is what the thing looks like when it has been
 * given no colour of its own; `off`, where there is one, is the swatch that takes the
 * thing away entirely rather than colouring it.
 */
const colours = (
  field: string,
  chosen: string,
  none: { title: string; fill?: string },
  off?: { value: string; title: string },
): string =>
  `<div class="style-grid">` +
  `<button ${swatch(!chosen, ` data-${field}="" title="${none.title}"`)}` +
  (none.fill ? ` style="background:${none.fill}"></button>` : `>∅</button>`) +
  (off ? `<button ${swatch(chosen === off.value, ` data-${field}="${off.value}" title="${off.title}"`)}>∅</button>` : "") +
  COLOURS.map(
    (colour) =>
      `<button ${swatch(chosen === colour.key, ` data-${field}="${colour.key}" title="${colour.name}"`)}` +
      ` style="background:${colour.hex}"></button>`,
  ).join("") +
  `</div>`;

/**
 * Opens the panel at the cursor and keeps it there until Esc or a click outside. `build`
 * draws its contents and `pick` reads a clicked button's `data-` attributes; returning
 * false from `pick` means the click was not a choice and the panel stays as it was.
 */
function popover(
  at: { x: number; y: number },
  build: () => string,
  pick: (data: DOMStringMap) => boolean,
): void {
  closeStylePicker();
  if (!host) {
    host = document.createElement("div");
    host.id = "style-pop";
    document.body.appendChild(host);
  }
  const box = host;

  const draw = (): void => {
    box.innerHTML = build();
  };

  box.onclick = (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("button");
    if (!button || !pick(button.dataset)) return;
    draw();
  };

  draw();
  box.classList.add("open");

  // Placed at the cursor, nudged back inside the window when near an edge — the same
  // manners as the menu it was opened from.
  box.style.left = "0px";
  box.style.top = "0px";
  const { width, height } = box.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - width - 8))}px`;
  box.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - height - 8))}px`;

  const onPointerDown = (event: MouseEvent) => {
    if (!box.contains(event.target as Node)) closeStylePicker();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation(); // don't also cancel a graph draft
    closeStylePicker();
  };

  dismiss = () => {
    document.removeEventListener("mousedown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    box.classList.remove("open");
    box.innerHTML = "";
    box.onclick = null;
    dismiss = null;
  };
  document.addEventListener("mousedown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
}

/**
 * The panel a node opens for its own look: a sign, a colour, an animation, and the
 * animation's colour. Nothing is confirmed — every click is the change, reported at once
 * through `onChange`, so the canvas answers the pick while the panel is still open and
 * picking again is how a choice is taken back.
 */
export function showStylePicker(
  at: { x: number; y: number },
  current: NodeStyle,
  onChange: (style: NodeStyle) => void,
): void {
  const style: NodeStyle = { ...current };
  popover(
    at,
    () =>
      `<div class="style-row"><h5>Sign</h5><div class="style-grid">` +
      `<button ${swatch(!style.icon, ` data-sign="" title="No sign"`)}>∅</button>` +
      SIGNS.map(
        (sign) =>
          `<button ${swatch(style.icon === sign.key, ` data-sign="${sign.key}" title="${sign.name}"`)}` +
          ` style="background-image:url(&quot;${signIcon(sign.key)}&quot;)"></button>`,
      ).join("") +
      `</div></div>` +
      `<div class="style-row"><h5>Colour</h5>` +
      colours("colour", style.colour, { title: "Its tags' colours" }) +
      `</div>` +
      `<div class="style-row"><h5>Animation</h5><div class="style-grid">` +
      `<button class="style-pick${style.anim ? "" : " on"}" data-anim="">None</button>` +
      ANIMS.map(
        (anim) =>
          `<button class="style-pick${style.anim === anim.key ? " on" : ""}" data-anim="${anim.key}">${anim.name}</button>`,
      ).join("") +
      `</div></div>` +
      // Dimmed rather than gone while there is nothing to colour: a row that comes and
      // goes would move everything under it each time the animation is switched.
      `<div class="style-row${style.anim ? "" : " off"}"><h5>Animation colour</h5>` +
      colours("animColour", style.animColour, { title: "Green", fill: PULSE_DEFAULT }) +
      `</div>`,
    (data) => {
      const { sign, colour, anim, animColour } = data;
      if (sign !== undefined) style.icon = sign;
      else if (colour !== undefined) style.colour = colour;
      else if (anim !== undefined) style.anim = anim;
      else if (animColour !== undefined) style.animColour = animColour;
      else return false;
      onChange({ ...style });
      return true;
    },
  );
}

/**
 * The same panel for a folder box, which has two colours and no notion of the other two:
 * a folder is a boundary drawn round notes, so what it can say for itself is what colour
 * the ground inside it is and what colour the fence is. It has no file to keep that in —
 * see `FrameStore.setStyle`, which puts it with the box's size.
 */
export function showFolderStylePicker(
  at: { x: number; y: number },
  current: FolderStyle,
  onChange: (style: FolderStyle) => void,
): void {
  const style: FolderStyle = { ...current };
  popover(
    at,
    () =>
      `<div class="style-row"><h5>Background</h5>` +
      colours("bg", style.bg, { title: "The usual blue", fill: FOLDER_BLUE }) +
      `</div>` +
      `<div class="style-row"><h5>Fence</h5>` +
      colours(
        "fence",
        style.fence,
        { title: "The usual blue", fill: FOLDER_BLUE },
        { value: NO_FENCE, title: "No fence at all" },
      ) +
      `</div>`,
    (data) => {
      const { bg, fence } = data;
      if (bg !== undefined) style.bg = bg;
      else if (fence !== undefined) style.fence = fence;
      else return false;
      onChange({ ...style });
      return true;
    },
  );
}
