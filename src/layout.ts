// The layout solver — the only thing that positions this graph.
//
// It works on the *real* rectangles (a folder is a fixed frame, not a shrink-wrap of its notes, so
// a general force layout's overlap avoidance would be void here): springs pull linked items to a
// target edge length, weak gravity keeps components together, and a projection step separates
// overlapping rectangles on every iteration. The final projection loop runs to convergence, so
// non-overlap is hard rather than merely encouraged. Seeded from a grid (`seedGrid`), so the same
// vault always lands the same way.

import type { Frame } from "./frames";

export type Rect = { id: string; x: number; y: number; w: number; h: number };
export type Link = { a: string; b: string; weight: number };

export type ArrangeOptions = {
  /** Desired clear gap between the borders of two linked rectangles. */
  edgeLength?: number;
  /** Minimum clear gap between any two rectangles. */
  margin?: number;
  iterations?: number;
  /** Keeps every rectangle fully inside this box (used for folder interiors). */
  bounds?: { x1: number; y1: number; x2: number; y2: number };
  /** Pull toward the centroid; higher values keep disconnected parts closer. */
  gravity?: number;
};

/** Extent of a rectangle from its centre along the unit direction (ux, uy). */
const extent = (rect: Rect, ux: number, uy: number): number =>
  (Math.abs(ux) * rect.w) / 2 + (Math.abs(uy) * rect.h) / 2;

function clampRect(rect: Rect, bounds: NonNullable<ArrangeOptions["bounds"]>): void {
  const halfW = rect.w / 2;
  const halfH = rect.h / 2;
  // A rectangle wider than its bounds is centred rather than jammed to one side.
  rect.x =
    bounds.x2 - bounds.x1 < rect.w
      ? (bounds.x1 + bounds.x2) / 2
      : Math.min(Math.max(rect.x, bounds.x1 + halfW), bounds.x2 - halfW);
  rect.y =
    bounds.y2 - bounds.y1 < rect.h
      ? (bounds.y1 + bounds.y2) / 2
      : Math.min(Math.max(rect.y, bounds.y1 + halfH), bounds.y2 - halfH);
}

/**
 * Pushes every overlapping pair apart along the axis needing the least movement.
 * Returns how many pairs it had to fix, so callers can loop to convergence.
 */
export function separateRects(rects: Rect[], margin: number, bounds?: ArrangeOptions["bounds"]): number {
  let fixed = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      // Coincident centres have no separation direction; break the tie
      // deterministically rather than with a random jitter.
      if (dx === 0 && dy === 0) {
        dx = (i + 1) * 0.01;
        dy = (j + 1) * 0.01;
      }
      const overlapX = (a.w + b.w) / 2 + margin - Math.abs(dx);
      const overlapY = (a.h + b.h) / 2 + margin - Math.abs(dy);
      if (overlapX <= 0 || overlapY <= 0) continue;
      fixed++;
      if (overlapX < overlapY) {
        const push = (overlapX / 2) * (dx >= 0 ? 1 : -1);
        a.x -= push;
        b.x += push;
      } else {
        const push = (overlapY / 2) * (dy >= 0 ? 1 : -1);
        a.y -= push;
        b.y += push;
      }
    }
  }
  if (bounds) for (const rect of rects) clampRect(rect, bounds);
  return fixed;
}

/** Refines `rects` in place. No overlaps on return, unless `bounds` is too small. */
export function arrangeRects(rects: Rect[], links: Link[], options: ArrangeOptions = {}): void {
  const edgeLength = options.edgeLength ?? 80;
  const margin = options.margin ?? 16;
  const iterations = options.iterations ?? 300;
  const gravity = options.gravity ?? 0.012;
  const { bounds } = options;
  if (rects.length < 2) {
    if (bounds && rects.length === 1) clampRect(rects[0], bounds);
    return;
  }

  const byId = new Map(rects.map((rect) => [rect.id, rect]));
  const edges = links
    .map((link) => ({ a: byId.get(link.a), b: byId.get(link.b), weight: link.weight }))
    .filter((edge): edge is { a: Rect; b: Rect; weight: number } => !!edge.a && !!edge.b && edge.a !== edge.b);

  for (let step = 0; step < iterations; step++) {
    // Cooling: large corrections early, fine adjustments later.
    const cool = 0.9 * (1 - step / iterations) + 0.1;

    // Springs toward the target gap along each link.
    for (const edge of edges) {
      const dx = edge.b.x - edge.a.x;
      const dy = edge.b.y - edge.a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const ux = dx / dist;
      const uy = dy / dist;
      const target = edgeLength + extent(edge.a, ux, uy) + extent(edge.b, ux, uy);
      const pull = ((dist - target) / dist) * 0.5 * cool * Math.min(edge.weight, 3);
      edge.a.x += dx * pull;
      edge.a.y += dy * pull;
      edge.b.x -= dx * pull;
      edge.b.y -= dy * pull;
    }

    // Mild short-range repulsion so unlinked items don't pile into one spot.
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist2 = dx * dx + dy * dy || 0.01;
        const reach = edgeLength + extent(a, 1, 0) + extent(b, 1, 0);
        if (dist2 > reach * reach * 4) continue;
        const dist = Math.sqrt(dist2);
        const push = ((reach * reach) / dist2) * 0.35 * cool;
        a.x -= (dx / dist) * push;
        a.y -= (dy / dist) * push;
        b.x += (dx / dist) * push;
        b.y += (dy / dist) * push;
      }
    }

    // Gravity toward the centroid holds disconnected components together.
    let cx = 0;
    let cy = 0;
    for (const rect of rects) {
      cx += rect.x;
      cy += rect.y;
    }
    cx /= rects.length;
    cy /= rects.length;
    for (const rect of rects) {
      rect.x += (cx - rect.x) * gravity * cool;
      rect.y += (cy - rect.y) * gravity * cool;
    }

    separateRects(rects, margin, bounds);
  }

  // Hard constraint: keep projecting until nothing overlaps.
  for (let pass = 0; pass < 600; pass++) {
    if (separateRects(rects, margin, bounds) === 0) break;
  }
}

/**
 * Frame big enough to hold `rects`, from their total area rather than a grid of
 * worst-case cells — one very long note title would otherwise widen every column
 * and blow the whole box up.
 */
export function requiredSize(rects: Rect[], margin: number, aspect = 1.5): Frame {
  if (rects.length === 0) return { w: 0, h: 0 };
  let area = 0;
  let widest = 0;
  let tallest = 0;
  for (const rect of rects) {
    area += (rect.w + margin) * (rect.h + margin);
    widest = Math.max(widest, rect.w);
    tallest = Math.max(tallest, rect.h);
  }
  area *= 1.22; // slack, since rectangles never tile perfectly
  const w = Math.max(Math.sqrt(area * aspect), widest + margin * 2);
  return { w: Math.ceil(w), h: Math.ceil(Math.max(area / w, tallest + margin * 2)) };
}

/** Overlapping pairs, without moving anything — used to verify the hard constraint. */
export function countOverlaps(rects: Rect[], margin: number): number {
  let count = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const overlapX = (a.w + b.w) / 2 + margin - Math.abs(b.x - a.x);
      const overlapY = (a.h + b.h) / 2 + margin - Math.abs(b.y - a.y);
      if (overlapX > 0 && overlapY > 0) count++;
    }
  }
  return count;
}

/** Deterministic grid seed, so a fresh solve never starts fully degenerate. */
export function seedGrid(rects: Rect[], margin: number): void {
  if (rects.length === 0) return;
  const cols = Math.max(1, Math.ceil(Math.sqrt(rects.length)));
  const cellW = Math.max(...rects.map((r) => r.w)) + margin;
  const cellH = Math.max(...rects.map((r) => r.h)) + margin;
  rects.forEach((rect, index) => {
    rect.x = (index % cols) * cellW;
    rect.y = Math.floor(index / cols) * cellH;
  });
}

