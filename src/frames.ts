// Folder boxes are fixed-size frames, not shrink-wrap around their notes.
//
// Cytoscape always sizes a compound parent to its children's bounding box, so a
// constant-size box is built by parking two invisible "anchor" children at the
// frame's opposite corners. The union of the children is then the frame itself,
// wherever the real notes happen to sit inside it. Notes are clamped to the
// interior so they can never push the frame open.

import type { BoundingBox12, BoundingBoxWH, Core, NodeSingular, Position } from "cytoscape";
import type { SpatialStore } from "./spatial";

export type Frame = { w: number; h: number };

/**
 * A folder's own colours: the fill inside the box, and the fence around it. Empty strings
 * are "whatever a folder normally looks like" — the blue the canvas gives every box — so
 * that a folder styled back to nothing is stored as nothing rather than as the default
 * spelled out, and follows the theme if the theme ever changes.
 */
export type FolderStyle = { bg: string; fence: string };

export const DEFAULT_FRAME: Frame = { w: 260, h: 170 };
/** Breathing room between a note's circle and the frame's border. */
const EDGE_GAP = 5;
export const ANCHOR_PREFIX = "__frame__";

const anchorId = (folder: string, corner: 0 | 1): string => `${ANCHOR_PREFIX}${corner}${folder}`;
export const isAnchor = (id: string): boolean => id.startsWith(ANCHOR_PREFIX);

/**
 * Sizes are per folder path and outlive restarts, cached in the vault alongside the
 * node positions (see `spatial.ts`). The `user` flag matters: a hand-set size is a
 * floor the layout must respect, while an auto size is free to be recomputed —
 * otherwise frames could only ever grow and repeated solves would inflate the graph
 * without bound.
 */
export class FrameStore {
  constructor(private store: SpatialStore) {}

  get(folder: string): Frame {
    const found = this.store.frame(folder);
    return found ? { w: found.w, h: found.h } : DEFAULT_FRAME;
  }

  /** True once the corner has been dragged: the layout may then only grow it. */
  isPinned(folder: string): boolean {
    return this.store.frame(folder)?.user === true;
  }

  set(folder: string, frame: Frame, user = false): void {
    this.store.setFrame(folder, { w: frame.w, h: frame.h, user: user || this.isPinned(folder) });
  }

  style(folder: string): FolderStyle {
    const held = this.store.frame(folder);
    return { bg: held?.bg ?? "", fence: held?.fence ?? "" };
  }

  /** Colours a folder, leaving its size and where it sits exactly as they were. */
  setStyle(folder: string, style: FolderStyle): void {
    const frame = this.get(folder);
    this.store.setFrame(folder, {
      w: frame.w,
      h: frame.h,
      user: this.isPinned(folder),
      bg: style.bg,
      fence: style.fence,
    });
  }
}

export const realChildren = (box: NodeSingular) => box.children().filter((child) => !isAnchor(child.id()));

/** Centre a frame should sit at: where its notes ended up after the layout. */
export function centreOf(box: NodeSingular): Position {
  const kids = realChildren(box);
  if (kids.empty()) return { ...box.position() };
  const bb = kids.boundingBox();
  return { x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 };
}

/**
 * Where a note's CENTRE may sit inside a frame. The inset is the note's own radius,
 * not a fixed margin: with the border drawn on the frame itself (parents have no
 * padding), the circle then comes to rest exactly against the visible edge. A fixed
 * inset is what made the box feel like it had an invisible wall inside it — and it
 * got worse once notes started varying in size.
 */
export function interior(centre: Position, frame: Frame, radius = 10): BoundingBox12 & BoundingBoxWH {
  const pad = radius + EDGE_GAP;
  const w = Math.max(frame.w - pad * 2, 20);
  const h = Math.max(frame.h - pad * 2, 20);
  return { x1: centre.x - w / 2, x2: centre.x + w / 2, y1: centre.y - h / 2, y2: centre.y + h / 2, w, h };
}

export const clampInto = (point: Position, rect: BoundingBox12): Position => ({
  x: Math.min(Math.max(point.x, rect.x1), rect.x2),
  y: Math.min(Math.max(point.y, rect.y1), rect.y2),
});

/**
 * Installs (or refreshes) every folder's frame: anchors at the corners and all
 * notes clamped inside. Call after the solver has run, never before — it would
 * otherwise scatter the anchors and the frame would mean nothing.
 */
/** Frames folders that don't have one yet, leaving existing frames untouched. */
export function ensureFrames(cy: Core, store: FrameStore): void {
  cy.batch(() => {
    cy.nodes(":parent").forEach((node) => {
      const box = node as NodeSingular;
      if (isAnchor(box.id()) || frameCentre(cy, box.id())) return;
      setFrame(cy, box.id(), centreOf(box), store.get(box.id()));
    });
  });
}

/** Positions a folder's anchors for `frame` centred on `centre`, clamping notes. */
export function setFrame(
  cy: Core,
  folder: string,
  centre: Position,
  frame: Frame,
  clampChildren = true,
): void {
  const corners: Array<[0 | 1, Position]> = [
    [0, { x: centre.x - frame.w / 2, y: centre.y - frame.h / 2 }],
    [1, { x: centre.x + frame.w / 2, y: centre.y + frame.h / 2 }],
  ];
  for (const [corner, at] of corners) {
    const id = anchorId(folder, corner);
    const existing = cy.getElementById(id);
    if (existing.nonempty()) existing.position(at);
    else {
      cy.add({
        group: "nodes",
        data: { id, parent: folder, kind: "anchor" },
        position: at,
        selectable: false,
        grabbable: false,
        classes: "frame-anchor",
      });
    }
  }
  if (!clampChildren) return;
  realChildren(cy.getElementById(folder) as NodeSingular).forEach((child) => {
    const rect = interior(centre, frame, child.width() / 2);
    child.position(clampInto(child.position(), rect));
  });
}

/** Frames must come off before a layout run, and go back on after it settles. */
export function removeAnchors(cy: Core): void {
  cy.nodes().filter((node) => isAnchor(node.id())).remove();
}

/** Current centre of a folder's frame, derived from its anchors. */
export function frameCentre(cy: Core, folder: string): Position | null {
  const a = cy.getElementById(anchorId(folder, 0));
  const b = cy.getElementById(anchorId(folder, 1));
  if (a.empty() || b.empty()) return null;
  return { x: (a.position("x") + b.position("x")) / 2, y: (a.position("y") + b.position("y")) / 2 };
}
