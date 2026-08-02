// Connections are notes too.
//
// A node's file says what the thing IS and how it works. The edge between two nodes is
// the other half of that: how they are wired together and what flows across the wire.
// Until now an edge could only carry a short relation name (`built with:: [[X]]`), which
// is a label, not an explanation — so every edge can now also own a markdown file.
//
// The link in the markdown is still what MAKES the edge; this file is what the edge says.
// Nothing here creates a connection, so an edge note can never disagree with the vault.

import { NOTES_DIR } from "./spatial";
import { noteName } from "./vault";

/** Edge notes sit beside the vault's other app-owned files, so they travel with it. */
export const EDGE_DIR = `${NOTES_DIR}/edges`;

/** Separates the two ends, in the file name and in every label built from one. */
export const ARROW = " → ";

/**
 * Where a connection's note lives. Derived from the two note NAMES rather than their
 * paths: filing a note into a folder does not change what the connection is, so a move
 * must not orphan the description of it. Two same-named notes in different folders
 * therefore share one connection note — the same trade Obsidian already makes when it
 * resolves a bare `[[link]]` to the shallowest match.
 */
export const edgeNotePath = (source: string, target: string): string =>
  `${EDGE_DIR}/${edgeTitle(source, target)}.md`;

/** "Cytoscape → Obsidian" — the file's name, and what the tab and the hints call it. */
export const edgeTitle = (source: string, target: string): string =>
  `${noteName(source)}${ARROW}${noteName(target)}`;

/** Edge notes are not vault notes: they are never in `entries()`, so paths identify them. */
export const isEdgeNote = (path: string): boolean => path.startsWith(EDGE_DIR + "/");

/**
 * What a connection note starts as. The relation name, if one was given when the link
 * was drawn, is the first line — it is the one-word version of what the file goes on
 * to explain, and it saves the writer retyping it.
 */
export const edgeNoteTemplate = (source: string, target: string, label: string | null): string =>
  `# ${edgeTitle(source, target)}\n\n${label ? `${label}\n\n` : ""}`;

/**
 * The path an edge note takes when a note at either end is renamed, or null when nothing
 * about it changes. `renames` is keyed by note name, not path — the file name only ever
 * held names.
 *
 * A note whose own name contains the arrow makes the split ambiguous; such a file is left
 * exactly where it is rather than being renamed into the wrong connection.
 */
export function renamedEdgeNote(path: string, renames: Map<string, string>): string | null {
  const ends = noteName(path).split(ARROW);
  if (ends.length !== 2) return null;
  const [from, to] = ends;
  const source = renames.get(from) ?? from;
  const target = renames.get(to) ?? to;
  if (source === from && target === to) return null;
  return `${EDGE_DIR}/${source}${ARROW}${target}.md`;
}
