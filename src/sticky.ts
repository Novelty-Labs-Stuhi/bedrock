// Stickies: loose text pinned to the canvas, belonging to no note.
//
// Each one is a real markdown file in a folder you can see — `stickies/` for plain
// text, `todos/` for checklists — named after the moment it was made. Only the
// GEOMETRY stays in `.notes/stickies.json`: where a card sits and how big it is,
// which is arrangement, not writing — the same trade `layout.json` already makes.
// The graph never draws these files as nodes; the cards are their rendering.

import { uniquePath, type Vault } from "./vault";

export const STICKY_DIR = "stickies";
export const TODO_DIR = "todos";

/** Where the cards' positions and sizes live; the words live in the md files. */
export const GEOMETRY_FILE = ".notes/stickies.json";

export type Sticky = {
  /** The md file's vault path — `todos/2026-08-02 14.32.md`. */
  id: string;
  text: string;
  /** Model-space top-left corner and size, in model units — cards are part of the
      graph and scale with it 1:1, like every node does. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** "todo" renders as a checklist that can point an arrow at a note; absent = plain text. */
  kind?: "todo";
  /** A todo collapsed to its little yellow square. */
  folded?: boolean;
};

type Geometry = { x: number; y: number; w: number; h: number; folded?: boolean };

/** Big enough to type into, small enough not to cover the graph. */
export const STICKY_W = 180;
export const STICKY_H = 72;

const WRITE_DELAY = 700;

const pad = (n: number): string => String(n).padStart(2, "0");

/** "2026-08-02 14.32" — a card's name IS its creation date (":" is unsafe in file names). */
export function stamp(now = new Date()): string {
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}.${pad(now.getMinutes())}`
  );
}

/** The creation date a card's file name carries, ready to show — null if renamed away. */
export function createdLabel(id: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2}) (\d{2})\.(\d{2})/.exec(id);
  return m ? `${m[1]} ${m[2]}:${m[3]}` : null;
}

export const isCardPath = (path: string): boolean =>
  path.startsWith(STICKY_DIR + "/") || path.startsWith(TODO_DIR + "/");

/* The shape stickies had when their text lived inside the json file itself. */
type LegacySticky = Geometry & { id: string; text: string; kind?: "todo" };

const isLegacy = (value: unknown): value is LegacySticky => {
  const s = value as LegacySticky | null;
  return (
    !!s &&
    typeof s.id === "string" &&
    typeof s.text === "string" &&
    Number.isFinite(s.x) &&
    Number.isFinite(s.y) &&
    s.w > 0 &&
    s.h > 0
  );
};

const isGeometry = (value: unknown): value is Geometry => {
  const g = value as Geometry | null;
  return !!g && Number.isFinite(g.x) && Number.isFinite(g.y) && g.w > 0 && g.h > 0;
};

export class StickyStore {
  private vault: Vault | null = null;
  private items = new Map<string, Sticky>();
  private timer: number | undefined;
  private dirtyGeometry = false;
  /** Card texts owed to their md files. */
  private dirtyText = new Set<string>();
  /** Files whose creation has not landed yet — sync() must not sweep them away. */
  private creating = new Set<string>();
  /** Fired after a card's file lands or leaves, so the tree can show it at once. */
  onFilesChanged: (() => void) | null = null;

  /** Reads this vault's cards, after flushing anything owed to the previous one. */
  async attach(vault: Vault): Promise<void> {
    await this.flush();
    this.vault = vault;
    this.items.clear();
    this.dirtyText.clear();
    this.creating.clear();
    this.dirtyGeometry = false;

    const { geometry, legacy } = await readGeometryFile(vault);

    for (const dir of [STICKY_DIR, TODO_DIR] as const) {
      for (const path of await vault.listFiles(dir)) {
        let text = "";
        try {
          text = (await vault.read(path)).replace(/\n$/, "");
        } catch {
          continue;
        }
        const at = geometry.get(path);
        this.items.set(path, {
          id: path,
          text,
          ...(dir === TODO_DIR ? { kind: "todo" as const } : {}),
          x: at?.x ?? 40,
          y: at?.y ?? 40,
          w: at?.w ?? STICKY_W,
          h: at?.h ?? STICKY_H,
          ...(at?.folded ? { folded: true } : {}),
        });
      }
    }

    // Cards from before they were files: give each its md file, keep its spot.
    for (const old of legacy) {
      const dir = old.kind === "todo" ? TODO_DIR : STICKY_DIR;
      const path = uniquePath(this.items.keys(), dir, stamp(), ".md");
      try {
        await vault.createFile(path, old.text + "\n");
      } catch {
        continue; // read-only vault — the card survives in memory for this session
      }
      this.items.set(path, {
        id: path,
        text: old.text,
        ...(old.kind ? { kind: old.kind } : {}),
        x: old.x,
        y: old.y,
        w: old.w,
        h: old.h,
        ...(old.folded ? { folded: true } : {}),
      });
      this.dirtyGeometry = true;
    }
    if (this.dirtyGeometry) await this.flush(); // the migrated shape, written once
  }

  all(): Sticky[] {
    return [...this.items.values()];
  }

  add(at: { x: number; y: number }, kind?: "todo"): Sticky {
    const dir = kind === "todo" ? TODO_DIR : STICKY_DIR;
    const path = uniquePath([...this.items.keys(), ...this.creating], dir, stamp(), ".md");
    // Placed centred on the click, which is where the pointer already is — corner
    // and size are both model units, so no zoom enters into it.
    const sticky: Sticky = {
      id: path,
      // A todo starts as one empty task line — every line of one is a task line.
      text: kind === "todo" ? "- [ ] " : "",
      ...(kind ? { kind } : {}),
      x: at.x - STICKY_W / 2,
      y: at.y - STICKY_H / 2,
      w: STICKY_W,
      h: STICKY_H,
    };
    this.items.set(path, sticky);
    this.creating.add(path);
    void this.vault
      ?.createFile(path, sticky.text + "\n")
      .catch(() => {})
      .finally(() => {
        this.creating.delete(path);
        this.onFilesChanged?.();
      });
    this.dirtyGeometry = true;
    this.schedule();
    return sticky;
  }

  update(id: string, patch: Partial<Omit<Sticky, "id">>): void {
    const held = this.items.get(id);
    if (!held) return;
    const next = { ...held, ...patch };
    if ((Object.keys(next) as Array<keyof Sticky>).every((key) => next[key] === held[key])) return;
    if (next.text !== held.text) this.dirtyText.add(id);
    if (
      next.x !== held.x ||
      next.y !== held.y ||
      next.w !== held.w ||
      next.h !== held.h ||
      next.folded !== held.folded
    ) {
      this.dirtyGeometry = true;
    }
    this.items.set(id, next);
    this.schedule();
  }

  remove(id: string): void {
    if (!this.items.delete(id)) return;
    this.dirtyText.delete(id);
    this.dirtyGeometry = true;
    void this.vault
      ?.remove(id, "file") // the card IS the file
      .catch(() => {})
      .finally(() => this.onFilesChanged?.());
    this.schedule();
  }

  /**
   * Brings the cache in line with the vault after a structural change: cards whose
   * file was deleted (or renamed) in the tree go, files somebody put into the two
   * folders by hand become cards. `paths` is every file the vault currently holds.
   */
  async sync(paths: Iterable<string>): Promise<void> {
    const vault = this.vault;
    if (!vault) return;
    const want = new Set<string>();
    for (const path of paths) if (isCardPath(path)) want.add(path);
    let changed = false;
    for (const id of [...this.items.keys()]) {
      if (want.has(id) || this.creating.has(id)) continue;
      this.items.delete(id);
      this.dirtyText.delete(id);
      changed = true;
    }
    for (const path of want) {
      if (this.items.has(path)) continue;
      let text = "";
      try {
        text = (await vault.read(path)).replace(/\n$/, "");
      } catch {
        continue;
      }
      this.items.set(path, {
        id: path,
        text,
        ...(path.startsWith(TODO_DIR + "/") ? { kind: "todo" as const } : {}),
        x: 40,
        y: 40,
        w: STICKY_W,
        h: STICKY_H,
      });
      changed = true;
    }
    if (changed) {
      this.dirtyGeometry = true;
      this.schedule();
    }
  }

  /**
   * A vault-wide relink just rewrote the files on disk; apply the same rewrite to the
   * cache so the two agree — WITHOUT marking anything dirty, the disk already has it.
   */
  rewriteTexts(rewrite: (text: string) => string): void {
    for (const [id, held] of this.items) {
      const next = rewrite(held.text);
      if (next !== held.text) this.items.set(id, { ...held, text: next });
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), WRITE_DELAY);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const vault = this.vault;
    if (!vault) return;
    for (const id of [...this.dirtyText]) {
      this.dirtyText.delete(id);
      const held = this.items.get(id);
      if (!held) continue;
      try {
        await vault.write(id, held.text + "\n");
      } catch {
        /* read-only vault */
      }
    }
    if (!this.dirtyGeometry) return;
    this.dirtyGeometry = false;
    const geometry: Record<string, Geometry> = {};
    for (const held of this.items.values()) {
      geometry[held.id] = {
        x: held.x,
        y: held.y,
        w: held.w,
        h: held.h,
        ...(held.folded ? { folded: true } : {}),
      };
    }
    try {
      await vault.write(GEOMETRY_FILE, JSON.stringify({ version: 2, geometry }, null, 1) + "\n");
    } catch {
      /* read-only vault */
    }
  }
}

/** Both spellings of the geometry file: v2 (paths -> geometry) and v1 (text inside). */
async function readGeometryFile(
  vault: Vault,
): Promise<{ geometry: Map<string, Geometry>; legacy: LegacySticky[] }> {
  const geometry = new Map<string, Geometry>();
  const legacy: LegacySticky[] = [];
  let raw = "";
  try {
    raw = await vault.read(GEOMETRY_FILE);
  } catch {
    return { geometry, legacy };
  }
  if (!raw.trim()) return { geometry, legacy };
  try {
    const parsed = JSON.parse(raw) as { stickies?: unknown[]; geometry?: Record<string, unknown> };
    for (const item of parsed.stickies ?? []) if (isLegacy(item)) legacy.push(item);
    for (const [path, g] of Object.entries(parsed.geometry ?? {})) {
      if (isGeometry(g)) geometry.set(path, g);
    }
  } catch {
    // Corrupt file: better cards at default spots than a vault that will not open.
  }
  return { geometry, legacy };
}

/* -------------------------------------------------------------------- todos --- */
// A todo is a sticky whose text is plain markdown tasks: every line is `- [ ] …`, and
// the note it points at is an ordinary `[[wikilink]]` line. The link line is stored
// like any other markdown but never shown — the arrow on the canvas is its rendering.

/** A task line. Its arrow, if it has one, is a trailing `[[link]]` on the same line. */
export type TodoItem = { done: boolean; text: string; target?: string };
/** `targets` are the card-level `[[link]]` lines — the old shape, one arrow each. */
export type TodoDoc = { items: TodoItem[]; targets: string[] };

const ITEM_RE = /^- \[([ xX])\] ?(.*)$/;
const TARGET_RE = /^\[\[([^\][|]+)\]\]$/;
/** A task line's own arrow: the `[[link]]` it ends with. */
const ITEM_TARGET_RE = /\s*\[\[([^\][|]+)\]\]\s*$/;

/** Reads a todo sticky's markdown. A stray prose line counts as an unchecked task. */
export function parseTodo(text: string): TodoDoc {
  const items: TodoItem[] = [];
  const targets: string[] = [];
  for (const line of text.split("\n")) {
    const item = ITEM_RE.exec(line);
    if (item) {
      let body = item[2];
      const inline = ITEM_TARGET_RE.exec(body);
      const target = inline?.[1].trim();
      if (inline) body = body.slice(0, inline.index);
      items.push({ done: item[1] !== " ", text: body, ...(target ? { target } : {}) });
      continue;
    }
    const link = TARGET_RE.exec(line.trim());
    if (link) {
      const name = link[1].trim();
      if (!targets.some((t) => t.toLowerCase() === name.toLowerCase())) targets.push(name);
      continue;
    }
    if (line.trim()) items.push({ done: false, text: line.trim() });
  }
  return { items, targets };
}

/** Writes it back: the task lines (arrow links inline), then the card-level link lines. */
export function serializeTodo(doc: TodoDoc): string {
  const lines = doc.items.map(
    (item) => `- [${item.done ? "x" : " "}] ${item.text}${item.target ? ` [[${item.target}]]` : ""}`,
  );
  for (const target of doc.targets) lines.push(`[[${target}]]`);
  return lines.join("\n");
}

/** When every task is ticked, the todo's arrow turns green. */
export const allDone = (doc: TodoDoc): boolean =>
  doc.items.length > 0 && doc.items.every((item) => item.done);
