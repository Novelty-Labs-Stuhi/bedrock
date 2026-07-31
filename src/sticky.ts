// Stickies: loose text pinned to the canvas, belonging to no note.
//
// Kept in `.notes/stickies.json`, deliberately NOT in `layout.json`: that file is a
// derived cache and throwing it away only costs you an arrangement, whereas a sticky is
// something you typed. Mixing the two would make deleting the cache destroy real text.

import type { Vault } from "./vault";

export type Sticky = {
  id: string;
  text: string;
  /** Model-space centre-independent top-left corner, and size in model units. */
  x: number;
  y: number;
  w: number;
  h: number;
};

export const STICKY_FILE = ".notes/stickies.json";

/** Big enough to type into, small enough not to cover the graph. */
export const STICKY_W = 180;
export const STICKY_H = 72;

const WRITE_DELAY = 700;

let counter = 0;
const nextId = (): string => `s${Date.now().toString(36)}${(counter++).toString(36)}`;

const isSticky = (value: unknown): value is Sticky => {
  const s = value as Sticky | null;
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

export class StickyStore {
  private vault: Vault | null = null;
  private items = new Map<string, Sticky>();
  private timer: number | undefined;
  private dirty = false;

  /** Reads this vault's stickies, after flushing any owed to the previous one. */
  async attach(vault: Vault): Promise<void> {
    await this.flush();
    this.vault = vault;
    this.items.clear();
    let raw = "";
    try {
      raw = await vault.read(STICKY_FILE);
    } catch {
      return; // none yet
    }
    if (!raw.trim()) return;
    try {
      const parsed = JSON.parse(raw) as { stickies?: unknown[] };
      for (const item of parsed.stickies ?? []) if (isSticky(item)) this.items.set(item.id, { ...item });
    } catch {
      // Corrupt file: better an empty canvas than a vault that will not open.
    }
  }

  all(): Sticky[] {
    return [...this.items.values()];
  }

  add(at: { x: number; y: number }): Sticky {
    // Placed centred on the click, which is where the pointer already is.
    const sticky: Sticky = {
      id: nextId(),
      text: "",
      x: at.x - STICKY_W / 2,
      y: at.y - STICKY_H / 2,
      w: STICKY_W,
      h: STICKY_H,
    };
    this.items.set(sticky.id, sticky);
    this.schedule();
    return sticky;
  }

  update(id: string, patch: Partial<Omit<Sticky, "id">>): void {
    const held = this.items.get(id);
    if (!held) return;
    const next = { ...held, ...patch };
    if (next.text === held.text && next.x === held.x && next.y === held.y && next.w === held.w && next.h === held.h) {
      return;
    }
    this.items.set(id, next);
    this.schedule();
  }

  remove(id: string): void {
    if (!this.items.delete(id)) return;
    this.schedule();
  }

  private schedule(): void {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), WRITE_DELAY);
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty || !this.vault) return;
    this.dirty = false;
    try {
      await this.vault.write(STICKY_FILE, JSON.stringify({ version: 1, stickies: this.all() }, null, 1) + "\n");
    } catch {
      /* read-only vault */
    }
  }
}
