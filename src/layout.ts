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


/* ------------------------------------------------------------- relaxation --- */

export type Bounds = NonNullable<ArrangeOptions["bounds"]>;

/**
 * A rectangle as the incremental solver sees it: `fixed` ones are scenery — they push
 * and pull the others but never move themselves — and `bounds` is the frame a folder's
 * note may not leave.
 */
export type Body = Rect & { fixed?: boolean; bounds?: Bounds };

export type RelaxOptions = Omit<ArrangeOptions, "bounds"> & {
  /** How many ticks the cooling schedule runs over. Past it the schedule sits at its floor. */
  iterations?: number;
};

/**
 * `arrangeRects`, one tick at a time and from wherever things already are.
 *
 * The whole-graph solve starts from a grid because it has nothing to start from; this
 * starts from the arrangement on screen, because the arrangement on screen is months of
 * somebody's work. Every tick moves the free bodies a little way along the same forces —
 * springs on the links, short-range repulsion, a weak pull to the centre of the moving
 * set, and the overlap projection — so a caller can draw the graph between ticks and the
 * layout is seen happening rather than arriving. Fixed bodies take part in every force
 * and move in none of them: what was not selected stays exactly where it was.
 */
export class Relaxation {
  private tick = 0;
  private readonly edgeLength: number;
  private readonly margin: number;
  private readonly iterations: number;
  private readonly gravity: number;
  private readonly edges: Array<{ a: Body; b: Body; weight: number }>;
  private readonly free: Body[];

  constructor(
    private readonly bodies: Body[],
    links: Link[],
    options: RelaxOptions = {},
  ) {
    this.edgeLength = options.edgeLength ?? 80;
    this.margin = options.margin ?? 16;
    this.iterations = options.iterations ?? 200;
    this.gravity = options.gravity ?? 0.012;
    const byId = new Map(bodies.map((body) => [body.id, body]));
    this.edges = links
      .map((link) => ({ a: byId.get(link.a), b: byId.get(link.b), weight: link.weight }))
      .filter(
        (edge): edge is { a: Body; b: Body; weight: number } =>
          !!edge.a && !!edge.b && edge.a !== edge.b && !(edge.a.fixed && edge.b.fixed),
      );
    this.free = bodies.filter((body) => !body.fixed);
  }

  /** How many bodies this relaxation is allowed to move. */
  moving(): number {
    return this.free.length;
  }

  /** One iteration. Returns the furthest any body moved, in model units. */
  step(): number {
    if (this.free.length === 0) return 0;
    const cool = Math.max(0.12, 1 - this.tick / this.iterations) * 0.9;
    this.tick++;
    const before = this.free.map((body) => ({ x: body.x, y: body.y }));

    // Springs toward the target gap. A fixed end cannot give, so the free end takes the
    // whole correction — the spring is exactly as stiff either way.
    for (const edge of this.edges) {
      const dx = edge.b.x - edge.a.x;
      const dy = edge.b.y - edge.a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const ux = dx / dist;
      const uy = dy / dist;
      const target = this.edgeLength + extent(edge.a, ux, uy) + extent(edge.b, ux, uy);
      const pull = ((dist - target) / dist) * 0.5 * cool * Math.min(edge.weight, 3);
      const share = edge.a.fixed || edge.b.fixed ? 2 : 1;
      if (!edge.a.fixed) {
        edge.a.x += dx * pull * share;
        edge.a.y += dy * pull * share;
      }
      if (!edge.b.fixed) {
        edge.b.x -= dx * pull * share;
        edge.b.y -= dy * pull * share;
      }
    }

    // Short-range repulsion, so unlinked bodies do not pile into one spot.
    const bodies = this.bodies;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        if (a.fixed && b.fixed) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist2 = dx * dx + dy * dy || 0.01;
        const reach = this.edgeLength + extent(a, 1, 0) + extent(b, 1, 0);
        if (dist2 > reach * reach * 4) continue;
        const dist = Math.sqrt(dist2);
        const push = ((reach * reach) / dist2) * 0.35 * cool;
        const share = a.fixed || b.fixed ? 2 : 1;
        if (!a.fixed) {
          a.x -= (dx / dist) * push * share;
          a.y -= (dy / dist) * push * share;
        }
        if (!b.fixed) {
          b.x += (dx / dist) * push * share;
          b.y += (dy / dist) * push * share;
        }
      }
    }

    // Gravity toward the centre of what is moving: a selection stays an island rather
    // than scattering to the corners of its frame.
    let cx = 0;
    let cy = 0;
    for (const body of this.free) {
      cx += body.x;
      cy += body.y;
    }
    cx /= this.free.length;
    cy /= this.free.length;
    for (const body of this.free) {
      body.x += (cx - body.x) * this.gravity * cool;
      body.y += (cy - body.y) * this.gravity * cool;
    }

    this.separate();

    let furthest = 0;
    this.free.forEach((body, index) => {
      furthest = Math.max(furthest, Math.hypot(body.x - before[index].x, body.y - before[index].y));
    });
    return furthest;
  }

  /** Projects until nothing overlaps (or gives up), so the hard constraint holds at the end. */
  settle(): void {
    for (let pass = 0; pass < 600; pass++) {
      if (this.separate() === 0) break;
    }
  }

  /**
   * `separateRects`, with fixed bodies as walls: a free body overlapping a fixed one
   * takes the whole push, two free bodies split it. Returns how many pairs it fixed.
   */
  private separate(): number {
    const bodies = this.bodies;
    let fixed = 0;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        if (a.fixed && b.fixed) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        if (dx === 0 && dy === 0) {
          dx = (i + 1) * 0.01;
          dy = (j + 1) * 0.01;
        }
        const overlapX = (a.w + b.w) / 2 + this.margin - Math.abs(dx);
        const overlapY = (a.h + b.h) / 2 + this.margin - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        fixed++;
        const share = a.fixed || b.fixed ? 1 : 0.5;
        if (overlapX < overlapY) {
          const push = overlapX * share * (dx >= 0 ? 1 : -1);
          if (!a.fixed) a.x -= push;
          if (!b.fixed) b.x += push;
        } else {
          const push = overlapY * share * (dy >= 0 ? 1 : -1);
          if (!a.fixed) a.y -= push;
          if (!b.fixed) b.y += push;
        }
      }
    }
    for (const body of this.free) if (body.bounds) clampRect(body, body.bounds);
    return fixed;
  }
}
