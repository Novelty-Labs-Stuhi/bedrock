// How big a note's circle is: a score per note, from the shape of the graph around it.
//
// Three ways of asking "how central is this note?", each an answer to a different
// question. Degree is the plain count of connections. PageRank is degree with the
// neighbours' own weight behind it — a note pointed at by hubs outranks one pointed at
// by leaves. Eigenvector centrality is the same idea without PageRank's damping, so it is
// sharper about the core of the biggest connected part and says next to nothing about
// notes off in a small island of their own.

import type { EdgeCollection, NodeCollection } from "cytoscape";

export type Sizing = "degree" | "pagerank" | "eigenvector";

export const SIZINGS: Array<{ key: Sizing; name: string; what: string }> = [
  { key: "degree", name: "Connections", what: "the number of links in and out — hubs are big, leaves are small" },
  { key: "pagerank", name: "PageRank", what: "links from well-linked notes count for more" },
  {
    key: "eigenvector",
    name: "Eigenvector",
    what: "the core of the biggest connected cluster is big; small islands are barely sized",
  },
];

/**
 * A raw score per note. Not normalised here — `sizeFor` decides what the numbers mean —
 * except that every strategy returns 0 for a note with no links at all.
 */
export function scoreNodes(notes: NodeCollection, edges: EdgeCollection, sizing: Sizing): Map<string, number> {
  const scores = new Map<string, number>();
  if (sizing === "degree") {
    notes.forEach((node) => {
      scores.set(node.id(), 0);
    });
    edges.forEach((edge) => {
      const a = edge.source().id();
      const b = edge.target().id();
      if (a === b) return;
      if (scores.has(a)) scores.set(a, (scores.get(a) ?? 0) + 1);
      if (scores.has(b)) scores.set(b, (scores.get(b) ?? 0) + 1);
    });
    return scores;
  }
  if (sizing === "pagerank") {
    const graph = notes.union(edges);
    const ranked = graph.pageRank({ dampingFactor: 0.85, precision: 1e-6, iterations: 200 });
    notes.forEach((node) => {
      // A note nobody links to and that links to nobody still gets PageRank's floor —
      // that is not a score, it is the absence of one.
      scores.set(node.id(), node.connectedEdges().intersection(edges).empty() ? 0 : ranked.rank(node));
    });
    return scores;
  }
  // Eigenvector centrality by power iteration on the undirected adjacency.
  const index = new Map<string, number>();
  notes.forEach((node) => {
    index.set(node.id(), index.size);
  });
  const n = index.size;
  const adjacency: number[][] = Array.from({ length: n }, () => []);
  edges.forEach((edge) => {
    const a = index.get(edge.source().id());
    const b = index.get(edge.target().id());
    if (a === undefined || b === undefined || a === b) return;
    adjacency[a].push(b);
    adjacency[b].push(a);
  });
  let vector = new Array<number>(n).fill(1);
  for (let round = 0; round < 100; round++) {
    const next = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (const j of adjacency[i]) next[i] += vector[j];
    const norm = Math.hypot(...next) || 1;
    let drift = 0;
    for (let i = 0; i < n; i++) {
      next[i] /= norm;
      drift = Math.max(drift, Math.abs(next[i] - vector[i]));
    }
    vector = next;
    if (drift < 1e-7) break;
  }
  for (const [id, i] of index) scores.set(id, adjacency[i].length ? vector[i] : 0);
  return scores;
}

/**
 * A score turned into a diameter between `min` and `max`.
 *
 * Connections keep the rule the graph has always drawn by — the first couple of links
 * count for a lot, then the square root flattens it, and `max` is a ceiling. The two
 * centralities are relative by nature, so they are scaled against the biggest score on
 * the canvas: the most central note is always drawn at `max`, whatever the vault's size.
 */
export function sizeFor(score: number, top: number, sizing: Sizing, min: number, max: number): number {
  const floor = Math.min(min, max);
  const ceiling = Math.max(min, max);
  if (sizing === "degree") return Math.min(ceiling, Math.round(floor + 16 * Math.sqrt(score)));
  if (top <= 0 || score <= 0) return floor;
  return Math.round(floor + (ceiling - floor) * Math.sqrt(score / top));
}
