// A Granola meeting on the canvas: its note is a copy of the summary Granola wrote, and
// every heading of that summary is a LEAF — a small circle round the meeting's tile from
// which the section is pointed at a note of your own. A leaf is not a file: the meeting's
// note holds it, and the arrow it draws is a `[[link]]` written at the end of its heading
// line, so on disk a section's assignment reads as an ordinary link in an ordinary note.

export type Section = {
  /** Position among the note's headings — what a leaf is named by. */
  index: number;
  /** The heading's words, links taken out. */
  title: string;
  /** Everything under the heading up to the next one — what a leaf shows when hovered. */
  body: string;
  /** The notes the heading line links to, as written. */
  targets: string[];
  /** The heading's line number in the note. */
  line: number;
};

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
/* The same spelling `links.ts` reads: a wikilink that is not an image embed. */
const LINK_RE = /(?<!!)\[\[([^\][|]+)(?:\|([^\][]*))?\]\]/g;

/** Every heading in the note, in order, with the text under it. Fenced code is skipped. */
export function parseSections(text: string): Section[] {
  const lines = text.split("\n");
  const found: Section[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = HEADING_RE.exec(line);
    if (!heading) continue;
    const targets = [...heading[2].matchAll(LINK_RE)].map((m) => m[1].trim()).filter(Boolean);
    const title = heading[2].replace(LINK_RE, "").replace(/\s+/g, " ").trim();
    found.push({ index: found.length, title, body: "", targets, line: i });
  }
  for (let s = 0; s < found.length; s++) {
    const from = found[s].line + 1;
    const to = s + 1 < found.length ? found[s + 1].line : lines.length;
    found[s].body = lines.slice(from, to).join("\n").trim();
  }
  return found;
}

/** What separates a meeting's path from a leaf's index in the leaf's id. */
const LEAF_MARK = "#leaf:";

export const leafId = (path: string, index: number): string => `${path}${LEAF_MARK}${index}`;

/** The meeting and the section a leaf id names, or null for an id that is a plain path. */
export function leafOf(id: string): { path: string; index: number } | null {
  const at = id.lastIndexOf(LEAF_MARK);
  if (at < 0) return null;
  const index = Number(id.slice(at + LEAF_MARK.length));
  return Number.isInteger(index) && index >= 0 ? { path: id.slice(0, at), index } : null;
}

/** The note with its heading lines' links taken out: the links that are the leaves', not the note's. */
export function withoutSectionLinks(text: string): string {
  const lines = text.split("\n");
  for (const section of parseSections(text)) {
    lines[section.line] = lines[section.line].replace(LINK_RE, "").trimEnd();
  }
  return lines.join("\n");
}

/** The heading line of section `index` with `[[target]]` at its end — unchanged if it already points there. */
export function linkSection(text: string, index: number, target: string): string {
  const section = parseSections(text)[index];
  if (!section) return text;
  if (section.targets.some((t) => t.trim() === target.trim())) return text;
  const lines = text.split("\n");
  lines[section.line] = `${lines[section.line].trimEnd()} [[${target}]]`;
  return lines.join("\n");
}

/**
 * The heading lines with every link `cut` says yes to taken out — of section `index`, or
 * of every section when none is named. (`unlinkText` in links.ts would leave the link's
 * words behind as prose, which is right in a sentence and wrong in a heading.)
 */
export function unlinkSection(text: string, index: number | null, cut: (target: string) => boolean): string {
  const lines = text.split("\n");
  for (const section of parseSections(text)) {
    if (index !== null && section.index !== index) continue;
    lines[section.line] = lines[section.line]
      .replace(LINK_RE, (whole, target: string) => (cut(target.trim()) ? "" : whole))
      .replace(/[ \t]+$/, "")
      .replace(/[ \t]{2,}/g, " ");
  }
  return lines.join("\n");
}

/** "Sep 11" — the day a meeting's `date::` line names, which is what its node is called. */
export function meetingDay(date: string | null): string | null {
  const at = date ? Date.parse(date) : NaN;
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The note without section `index`: its heading and everything under it, up to the next heading. */
export function deleteSection(text: string, index: number): string {
  const sections = parseSections(text);
  const section = sections[index];
  if (!section) return text;
  const lines = text.split("\n");
  const to = sections[index + 1]?.line ?? lines.length;
  lines.splice(section.line, to - section.line);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * The note with only the sections `keep` says yes to — the text before the first heading
 * stays as it is. What a second copy of a meeting is made of: the sections still free.
 */
export function keepSections(text: string, keep: (section: Section) => boolean): string {
  const sections = parseSections(text);
  const lines = text.split("\n");
  for (let s = sections.length - 1; s >= 0; s--) {
    if (keep(sections[s])) continue;
    const to = sections[s + 1]?.line ?? lines.length;
    lines.splice(sections[s].line, to - sections[s].line);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** How two copies of a meeting agree a heading is the same one: its words, case and spacing aside. */
export const sectionKey = (title: string): string => title.toLowerCase().replace(/\s+/g, " ").trim();
