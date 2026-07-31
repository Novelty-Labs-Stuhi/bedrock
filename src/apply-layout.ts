// Drives the constrained solver over the compound graph.
//
// Sizes are measured from the live nodes rather than assumed: labels sit beside
// the circle and vary hugely in width, and a guessed constant lets long titles
// overlap their neighbours and spill out of their folder frame.

import type { Core, NodeSingular } from "cytoscape";
import { type Frame, type FrameStore, frameCentre, isAnchor, realChildren, setFrame } from "./frames";
import {
  arrangeRects,
  countOverlaps,
  requiredSize,
  separateRects,
  seedGrid,
  type ArrangeOptions,
  type Link,
  type Rect,
} from "./layout";

/** A node's real footprint plus the offset from its position to that box's centre. */
type Box = { w: number; h: number; ox: number; oy: number };

const measured = (node: NodeSingular): Box => {
  const bb = node.boundingBox({ includeLabels: true, includeOverlays: false });
  const at = node.position();
  return { w: bb.w, h: bb.h, ox: (bb.x1 + bb.x2) / 2 - at.x, oy: (bb.y1 + bb.y2) / 2 - at.y };
};

/**
 * How much a rendered folder box exceeds its frame: the compound padding plus
 * the label strip above it. Taken from the live box so it tracks the stylesheet.
 */
function boxChrome(box: NodeSingular): Box {
  const outer = box.boundingBox({ includeLabels: true, includeOverlays: false });
  const inner = box.children().boundingBox({ includeLabels: false, includeOverlays: false });
  if (!inner.w || !inner.h) return { w: 30, h: 48, ox: 0, oy: -12 };
  return {
    w: outer.w - inner.w,
    h: outer.h - inner.h,
    ox: (outer.x1 + outer.x2) / 2 - (inner.x1 + inner.x2) / 2,
    oy: (outer.y1 + outer.y2) / 2 - (inner.y1 + inner.y2) / 2,
  };
}

// Attraction can be aggressive: the projection step enforces non-overlap no
// matter how hard the springs pull, so these only control how tightly the
// arrangement packs.
const MIN_FRAME: Frame = { w: 190, h: 130 };

const OUTER: ArrangeOptions = { edgeLength: 24, margin: 18, iterations: 420, gravity: 0.035 };
const INNER: ArrangeOptions = { edgeLength: 24, margin: 10, iterations: 300, gravity: 0.06 };

type Placed = { frame: Frame; centres: Map<string, { x: number; y: number }> };

/**
 * Lays the whole graph out: each folder is solved in its own local coordinates
 * (deepest first, growing its frame only if the contents cannot physically fit),
 * then folders and root-level notes are arranged as fixed rectangles. Nothing
 * overlaps when this returns.
 */
export function layoutGraph(cy: Core, store: FrameStore): void {
  const folderOf = new Map<string, string | null>();
  cy.nodes().forEach((node) => {
    const parent = (node as NodeSingular).parent().first();
    folderOf.set(node.id(), parent.nonempty() ? parent.id() : null);
  });

  /** Which direct child of `folder` a node lives under, for aggregating links. */
  const branchUnder = (nodeId: string, folder: string | null): string | null => {
    let current: string | null = nodeId;
    while (current !== null) {
      const parent: string | null = folderOf.get(current) ?? null;
      if (parent === folder) return current;
      current = parent;
    }
    return null;
  };

  const linksAmong = (folder: string | null): Link[] => {
    const counts = new Map<string, Link>();
    cy.edges().forEach((edge) => {
      const a = branchUnder(edge.source().id(), folder);
      const b = branchUnder(edge.target().id(), folder);
      if (!a || !b || a === b) return;
      const key = a < b ? `${a} ${b}` : `${b} ${a}`;
      const found = counts.get(key);
      if (found) found.weight++;
      else counts.set(key, { a, b, weight: 1 });
    });
    return [...counts.values()];
  };

  const childrenOf = (folder: string | null): NodeSingular[] =>
    folder === null
      ? cy
          .nodes()
          .filter((node) => (node as NodeSingular).parent().empty())
          .map((node) => node as NodeSingular)
      : realChildren(cy.getElementById(folder) as NodeSingular).map((node) => node as NodeSingular);

  const placements = new Map<string, Placed>();

  /** Rect for one child, plus the offset turning a rect centre back into a position. */
  const rectFor = (node: NodeSingular): { rect: Rect; offset: Box } => {
    if (!node.isParent()) {
      const size = measured(node);
      return { rect: { id: node.id(), x: 0, y: 0, w: size.w, h: size.h }, offset: size };
    }
    const frame = solve(node.id());
    const chrome = boxChrome(node);
    return {
      rect: { id: node.id(), x: 0, y: 0, w: frame.w + chrome.w, h: frame.h + chrome.h },
      offset: chrome,
    };
  };

  /** Solves one folder in local coordinates and returns the frame it needs. */
  function solve(folder: string): Frame {
    const parts = childrenOf(folder).map(rectFor);
    const rects = parts.map((part) => part.rect);
    const margin = INNER.margin ?? 12;

    // A hand-set size is a floor; an auto size is recomputed, so a full layout
    // can shrink a box again instead of only ever growing it.
    const need = requiredSize(rects, margin);
    const floor = { w: Math.max(need.w, MIN_FRAME.w), h: Math.max(need.h, MIN_FRAME.h) };
    const stored = store.get(folder);
    const frame: Frame = store.isPinned(folder)
      ? { w: Math.max(stored.w, floor.w), h: Math.max(stored.h, floor.h) }
      : { ...floor };

    // Bounds tighter than the contents would leave overlaps the projection step
    // cannot resolve, so grow and re-solve until the arrangement is clean.
    const links = linksAmong(folder);
    for (let attempt = 0; ; attempt++) {
      seedGrid(rects, margin);
      arrangeRects(rects, links, {
        ...INNER,
        bounds: { x1: -frame.w / 2, y1: -frame.h / 2, x2: frame.w / 2, y2: frame.h / 2 },
      });
      if (countOverlaps(rects, margin) === 0 || attempt >= 4) break;
      frame.w = Math.ceil(frame.w * 1.18);
      frame.h = Math.ceil(frame.h * 1.18);
    }
    if (frame.w !== stored.w || frame.h !== stored.h) store.set(folder, frame);

    const centres = new Map<string, { x: number; y: number }>();
    for (const part of parts) {
      centres.set(part.rect.id, { x: part.rect.x - part.offset.ox, y: part.rect.y - part.offset.oy });
    }
    placements.set(folder, { frame, centres });
    return frame;
  }

  const top = childrenOf(null).map(rectFor);

  // Deterministic seed, then solve. There is no simulation to inherit a shape from: the springs +
  // gravity + projection in `arrangeRects` produce the global arrangement on their own, and a grid
  // start makes the result reproducible — the same vault lays out the same way every time.
  const topRects = top.map((part) => part.rect);
  seedGrid(topRects, OUTER.margin ?? 18);
  arrangeRects(topRects, linksAmong(null), OUTER);

  cy.batch(() => {
    const place = (id: string, centre: { x: number; y: number }): void => {
      const placed = placements.get(id);
      if (!placed) {
        (cy.getElementById(id) as NodeSingular).position(centre);
        return;
      }
      setFrame(cy, id, centre, placed.frame, false);
      for (const [childId, childCentre] of placed.centres) {
        place(childId, { x: centre.x + childCentre.x, y: centre.y + childCentre.y });
      }
    };
    for (const part of top) {
      place(part.rect.id, { x: part.rect.x - part.offset.ox, y: part.rect.y - part.offset.oy });
    }
  });

  correctOverlaps(cy, store);
}

/** Moves a node — and, for a folder, its whole subtree and frame — by a delta. */
function shift(node: NodeSingular, dx: number, dy: number): void {
  const move = (target: NodeSingular): void => {
    const at = target.position();
    target.position({ x: at.x + dx, y: at.y + dy });
  };
  if (!node.isParent()) {
    move(node);
    return;
  }
  // Includes the frame anchors, so the box travels with its contents.
  node.descendants().forEach((descendant) => move(descendant as NodeSingular));
}

/**
 * Closes the loop against what cytoscape actually renders. The solver works from
 * a model of each rectangle (frame + measured chrome), and that model can
 * under-predict — a folder whose label overhangs a small box, for instance. This
 * pass re-measures real bounding boxes and projects any residual overlap out,
 * deepest groups first so a box's true size is settled before its parent is
 * adjusted.
 */
function correctOverlaps(cy: Core, store: FrameStore): void {
  for (let round = 0; round < 6; round++) {
    const groups = new Map<string, NodeSingular[]>();
    cy.nodes().forEach((node) => {
      if (isAnchor(node.id())) return;
      const parent = (node as NodeSingular).parent().first();
      const key = parent.nonempty() ? parent.id() : "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(node as NodeSingular);
    });

    let moved = 0;
    const keys = [...groups.keys()].sort((a, b) => (b ? b.split("/").length : 0) - (a ? a.split("/").length : 0));
    for (const key of keys) {
      const members = groups.get(key)!;
      if (members.length < 2) continue;
      const margin = (key ? INNER.margin : OUTER.margin) ?? 12;

      const rects: Rect[] = members.map((node) => {
        const bb = node.boundingBox({ includeLabels: true, includeOverlays: false });
        return { id: node.id(), x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2, w: bb.w, h: bb.h };
      });
      const origin = rects.map((rect) => ({ x: rect.x, y: rect.y }));

      let bounds: ArrangeOptions["bounds"];
      if (key) {
        const centre = frameCentre(cy, key);
        if (centre) {
          const frame = store.get(key);
          bounds = {
            x1: centre.x - frame.w / 2,
            y1: centre.y - frame.h / 2,
            x2: centre.x + frame.w / 2,
            y2: centre.y + frame.h / 2,
          };
        }
      }

      for (let pass = 0; pass < 400; pass++) {
        if (separateRects(rects, margin, bounds) === 0) break;
      }

      cy.batch(() => {
        rects.forEach((rect, index) => {
          const dx = rect.x - origin[index].x;
          const dy = rect.y - origin[index].y;
          if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
          shift(members[index], dx, dy);
          moved++;
        });
      });
    }
    if (moved === 0) break;
  }
}
