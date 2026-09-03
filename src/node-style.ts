// A note's LOOK on the canvas: a sign engraved on its node, the colour of the node
// itself, an animation around it, and that animation's colour. Four independent
// choices — this file holds what there is to choose from, and the little panel that
// does the choosing. What a choice MEANS to the canvas lives in `graph.ts`; where it
// is kept (`sign:: star` and friends, in the note's own markdown) lives in `links.ts`.

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

/** The cog's teeth: eight stubs standing out of its rim, generated like the sun's rays. */
const COG_TEETH = [0, 45, 90, 135, 180, 225, 270, 315]
  .map((angle) => {
    const radians = (angle * Math.PI) / 180;
    const point = (reach: number): string =>
      `${(32 + Math.cos(radians) * reach).toFixed(1)} ${(32 + Math.sin(radians) * reach).toFixed(1)}`;
    return line(`M${point(16)} L${point(29)}`, 9);
  })
  .join("");

/**
 * The signs a note can wear. Two kinds, in the order they are offered: first what a note
 * IS about the vault — this one matters, this one is hot, this one is done, this one is a
 * question — and then what it is ABOUT: a book, an experiment, an idea, a person.
 *
 * Simple shapes on purpose: a node is twenty pixels across at the zoom a whole vault is
 * read at, and anything with detail in it turns to fuzz there. Each one has to be
 * recognisable as a silhouette, because at that size a silhouette is all it is.
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
    // The core is cut out rather than drawn: a flame is a shape with something brighter
    // inside it, and on a coloured node "brighter" is the node's own colour showing through.
    body:
      `<path fill-rule="evenodd" fill="INK" d="M32 5c9 13 18 18 18 31.5a18 18 0 0 1-36 0C14 27 20 24 24 17c1.5 5 4 8 8 9-1-8-1-15 0-21Z` +
      `M32 33c4.5 4.5 7.5 8 7.5 12a7.5 7.5 0 0 1-15 0c0-4 3-7.5 7.5-12Z"/>`,
  },
  {
    key: "leaf",
    name: "Leaf",
    body:
      `<path fill-rule="evenodd" fill="INK" d="M54 10c0 28-16 45-42 44C10 28 26 10 54 10Z` +
      `M48 16C34 24 22 37 15 50l3.5 2.2C25.5 40 37 27.5 50.5 18.6Z"/>`,
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
  /*
   * What a note is ABOUT, rather than how it stands: reading, an experiment, an idea, the
   * machinery of something. These are the ones you reach for to say "this note is a book"
   * or "this one is a trial" — a subject rather than a status, and the same engraving.
   */
  {
    key: "book",
    name: "Book",
    // Two leaves meeting at a spine, with the spine left as a gap the node's own colour
    // shows through — a single filled shape reads as a brick at twenty pixels.
    body:
      `<path fill="INK" d="M31 20C25 14.5 17 11.5 8 11v34c9 .5 17 3.5 23 9Z"/>` +
      `<path fill="INK" d="M33 20C39 14.5 47 11.5 56 11v34c-9 .5-17 3.5-23 9Z"/>`,
  },
  {
    key: "flask",
    name: "Experiment",
    // The conical flask, which is what a trial looks like everywhere: a lipped neck and
    // a body that flares to a flat base.
    body:
      `<rect x="23" y="4" width="18" height="5.5" rx="2.75" fill="INK"/>` +
      `<path fill="INK" d="M26 9h12v13l15 26.5a5.5 5.5 0 0 1-4.8 8.5H15.8A5.5 5.5 0 0 1 11 48.5L26 22Z"/>`,
  },
  {
    key: "bulb",
    name: "Idea",
    body:
      `<path fill="INK" d="M32 5a18.5 18.5 0 0 0-10.5 33.7V44h21v-5.3A18.5 18.5 0 0 0 32 5Z"/>` +
      `<rect x="21.5" y="46.5" width="21" height="5.5" rx="2.75" fill="INK"/>` +
      `<rect x="25" y="54.5" width="14" height="5.5" rx="2.75" fill="INK"/>`,
  },
  {
    key: "cog",
    name: "Machinery",
    // Teeth are strokes round a ring with a hole cut in it, the same trick the eye uses.
    body:
      COG_TEETH +
      `<path fill-rule="evenodd" fill="INK" d="M32 13a19 19 0 1 0 0 38 19 19 0 0 0 0-38Z` +
      `M32 25a7 7 0 1 1 0 14 7 7 0 0 1 0-14Z"/>`,
  },
  {
    key: "clock",
    name: "Time",
    body:
      `<path fill-rule="evenodd" fill="INK" d="M32 5a27 27 0 1 0 0 54 27 27 0 0 0 0-54Z` +
      `M32 12.5a19.5 19.5 0 1 1 0 39 19.5 19.5 0 0 1 0-39Z"/>` +
      line("M32 20v13h10", 6),
  },
  {
    key: "lock",
    name: "Private",
    body:
      `<path d="M22 30v-7a10 10 0 0 1 20 0v7" fill="none" stroke="INK" stroke-width="6.5" stroke-linecap="round"/>` +
      `<rect x="13" y="29" width="38" height="28" rx="6" fill="INK"/>`,
  },
  {
    key: "key",
    name: "Key",
    body:
      `<path fill-rule="evenodd" fill="INK" d="M32 4a13.5 13.5 0 1 0 0 27 13.5 13.5 0 0 0 0-27Z` +
      `M32 12.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z"/>` +
      line("M32 31v27", 7) +
      line("M32 40h10", 6) +
      line("M32 49h8", 6),
  },
  {
    key: "code",
    name: "Code",
    body: line("M23 17 9 32 23 47", 8) + line("M41 17 55 32 41 47", 8),
  },
  {
    key: "chat",
    name: "Conversation",
    body: `<rect x="6" y="11" width="52" height="33" rx="7" fill="INK"/><path d="M18 42h15L18 59z" fill="INK"/>`,
  },
  {
    key: "target",
    name: "Target",
    // Outer ring, then a hole, then the bullseye: three subpaths and `evenodd` do it in
    // one path, so the rings are gaps rather than a lighter ink.
    body:
      `<path fill-rule="evenodd" fill="INK" d="M32 4a28 28 0 1 0 0 56 28 28 0 0 0 0-56Z` +
      `M32 12a20 20 0 1 1 0 40 20 20 0 0 1 0-40Z` +
      `M32 19a13 13 0 1 0 0 26 13 13 0 0 0 0-26Z"/>`,
  },
  {
    key: "chart",
    name: "Numbers",
    body:
      `<rect x="9" y="34" width="12" height="22" rx="2.5" fill="INK"/>` +
      `<rect x="26" y="21" width="12" height="35" rx="2.5" fill="INK"/>` +
      `<rect x="43" y="8" width="12" height="48" rx="2.5" fill="INK"/>`,
  },
  {
    key: "trend",
    name: "Trend",
    body: line("M8 46 24 30 34 40 56 18", 7) + `<path d="M56 32V16H40z" fill="INK"/>`,
  },
  {
    key: "person",
    name: "Person",
    body: `<circle cx="32" cy="20" r="11.5" fill="INK"/><path d="M11 59c0-11.6 9.4-21 21-21s21 9.4 21 21z" fill="INK"/>`,
  },
  {
    key: "rocket",
    name: "Launch",
    body:
      `<path fill="INK" d="M32 4c8 8 12 18 12 29H20c0-11 4-21 12-29Z"/>` +
      `<path fill="INK" d="M20 36c-5 3-8 8-8 14l8-3zM44 36c5 3 8 8 8 14l-8-3z"/>` +
      `<path fill="INK" d="M26 39h12l-6 19z"/>`,
  },
  {
    key: "cube",
    name: "Thing",
    // An isometric box: the top face, then the two sides, drawn as separate shapes so the
    // edges between them read as edges.
    body:
      `<path fill="INK" d="M32 4 57 17 32 30 7 17Z"/>` +
      `<path fill="INK" d="M6 21 30 33.5V60L6 47Z"/>` +
      `<path fill="INK" d="M58 21 34 33.5V60l24-13Z"/>`,
  },
  {
    key: "calendar",
    name: "Date",
    body:
      line("M19 5v11", 6) +
      line("M45 5v11", 6) +
      `<path fill-rule="evenodd" fill="INK" d="M13 12h38a6 6 0 0 1 6 6v33a6 6 0 0 1-6 6H13a6 6 0 0 1-6-6V18a6 6 0 0 1 6-6Z` +
      `M7 25h50v4.5H7Z"/>`,
  },
  {
    key: "mail",
    name: "Message",
    body:
      `<path fill-rule="evenodd" fill="INK" d="M11 14h42a6 6 0 0 1 6 6v24a6 6 0 0 1-6 6H11a6 6 0 0 1-6-6V20a6 6 0 0 1 6-6Z` +
      `M9 19l23 16 23-16 3.5 4.7L32 41.5 5.5 23.7Z"/>`,
  },
  {
    key: "tag",
    name: "Label",
    body:
      `<path fill-rule="evenodd" fill="INK" d="M6 8h24l28 28-22 22L8 30Z` +
      `M20 15a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"/>`,
  },
  {
    key: "drop",
    name: "Drop",
    body: `<path fill="INK" d="M32 4c11 14 18 22 18 31a18 18 0 0 1-36 0c0-9 7-17 18-31Z"/>`,
  },
  {
    key: "shield",
    name: "Guarded",
    body: `<path fill="INK" d="M32 4 55 12v18c0 14-9.5 24-23 30C18.5 54 9 44 9 30V12Z"/>`,
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
 * A row of swatches, each of which writes `data-<field>` when clicked. The first is what
 * the thing looks like when it has been given no colour of its own; `off`, where there is
 * one, is the swatch that takes the thing away entirely rather than colouring it.
 *
 * `options` is the palette to offer — the notes' ten by default, but the settings window
 * asks the same question about a canvas background, which wants grounds rather than hues.
 */
export const swatchRow = (
  field: string,
  chosen: string,
  none: { title: string; fill?: string },
  extra: {
    options?: Array<{ key: string; name: string; hex: string }>;
    off?: { value: string; title: string };
  } = {},
): string => {
  const { options = COLOURS, off } = extra;
  return (
    `<div class="style-grid">` +
    `<button ${swatch(!chosen, ` data-${field}="" title="${none.title}"`)}` +
    (none.fill ? ` style="background:${none.fill}"></button>` : `>∅</button>`) +
    (off
      ? `<button ${swatch(chosen === off.value, ` data-${field}="${off.value}" title="${off.title}"`)}>∅</button>`
      : "") +
    options
      .map(
        (colour) =>
          `<button ${swatch(chosen === colour.key, ` data-${field}="${colour.key}" title="${colour.name}"`)}` +
          ` style="background:${colour.hex}"></button>`,
      )
      .join("") +
    `</div>`
  );
};

/** The notes' own palette, which is what every picker in this file asks about. */
const colours = (
  field: string,
  chosen: string,
  none: { title: string; fill?: string },
  off?: { value: string; title: string },
): string => swatchRow(field, chosen, none, { off });

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
      // `anim-colour`, hyphenated: an HTML attribute is lower-cased on its way into the
      // DOM, so `data-animColour` would arrive as `dataset.animcolour` and the click that
      // set it would be read as no choice at all — which is how every pulse came out green.
      colours("anim-colour", style.animColour, { title: "Green", fill: PULSE_DEFAULT }) +
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
