// Where the graph's arrangement lives between sessions.
//
// It goes in the vault, not in localStorage: the layout is a property of these notes,
// so it belongs beside them — it survives a reinstall, follows the folder to another
// machine, and a second vault gets its own arrangement instead of inheriting this one.
//
// `.notes/` is dot-prefixed, which is exactly how both vaults decide what is a note:
// hidden paths never reach the tree, the graph or link resolution, so the cache cannot
// show up as a note about itself.

import type { Vault } from "./vault";

export type Point = { x: number; y: number };
/**
 * A folder box: its size, and the centre it sits at. `user` marks a size the user set
 * by dragging a corner. The centre has to be cached too — a box's position is otherwise
 * derived from the notes inside it, so one note left off-centre would drag the whole
 * frame across the canvas on the next start.
 */
export type StoredFrame = { w: number; h: number; user?: boolean; x?: number; y?: number };

type Snapshot = {
  version: 1;
  nodes: Record<string, Point>;
  frames: Record<string, StoredFrame>;
};

export const NOTES_DIR = ".notes";
export const LAYOUT_FILE = `${NOTES_DIR}/layout.json`;
/**
 * The arrangement exactly as it was when this vault was opened, written once, just
 * before the first overwrite of the session. An arrangement can represent months of
 * work; one bad write should never be the end of it.
 */
export const LAYOUT_BACKUP = `${NOTES_DIR}/layout.backup.json`;

/** How long to sit on changes before writing. A drag fires hundreds of them. */
const WRITE_DELAY = 700;

const isPoint = (value: unknown): value is Point => {
  const at = value as Point | null;
  return !!at && Number.isFinite(at.x) && Number.isFinite(at.y);
};

const isFrame = (value: unknown): value is StoredFrame => {
  const frame = value as StoredFrame | null;
  return !!frame && frame.w > 0 && frame.h > 0;
};

export class SpatialStore {
  private vault: Vault | null = null;
  private nodes = new Map<string, Point>();
  private frames = new Map<string, StoredFrame>();
  private timer: number | undefined;
  private dirty = false;
  /** What was on disk when this vault was opened, and whether it has been backed up. */
  private opened = "";
  private backedUp = false;
  /** Bumped on every attach, so the graph can tell it is looking at a different vault. */
  private gen = 0;

  /**
   * Points the store at a vault and reads back whatever arrangement it holds. Any
   * pending write goes to the OLD vault first — switching folders must not spill one
   * vault's layout into another's file.
   */
  async attach(vault: Vault): Promise<void> {
    await this.flush();
    this.vault = vault;
    this.gen++;
    this.nodes.clear();
    this.frames.clear();
    this.opened = "";
    this.backedUp = false;

    let raw = "";
    try {
      raw = await vault.read(LAYOUT_FILE);
    } catch {
      return; // nothing cached yet — the first solve will write one
    }
    if (!raw.trim()) return;
    this.opened = raw;

    try {
      const snap = JSON.parse(raw) as Partial<Snapshot>;
      for (const [path, at] of Object.entries(snap.nodes ?? {})) {
        if (isPoint(at)) this.nodes.set(path, { x: at.x, y: at.y });
      }
      for (const [path, frame] of Object.entries(snap.frames ?? {})) {
        if (!isFrame(frame)) continue;
        const placed = Number.isFinite(frame.x) && Number.isFinite(frame.y);
        this.frames.set(path, {
          w: frame.w,
          h: frame.h,
          user: frame.user,
          ...(placed ? { x: frame.x, y: frame.y } : {}),
        });
      }
    } catch {
      // A corrupt cache is a cosmetic loss. Never let it stop the vault opening.
    }
  }

  /** True once there is an arrangement worth restoring instead of re-solving. */
  hasLayout(): boolean {
    return this.nodes.size > 0;
  }

  /**
   * Which vault this store is holding, as a number that changes on every attach. The
   * graph compares it against the one it was built for: a mismatch means the canvas
   * belongs to a different vault and must be rebuilt, not patched. Making the graph
   * notice for itself is the point — it used to rely on the caller remembering, and the
   * one time it did not, a vault's whole arrangement was overwritten with a scatter.
   */
  generation(): number {
    return this.gen;
  }

  node(path: string): Point | undefined {
    return this.nodes.get(path);
  }

  frame(folder: string): StoredFrame | undefined {
    return this.frames.get(folder);
  }

  setFrame(folder: string, frame: StoredFrame): void {
    const held = this.frames.get(folder);
    const same =
      held &&
      held.w === frame.w &&
      held.h === frame.h &&
      held.user === frame.user &&
      // A box that has never been placed keeps whatever centre it already had.
      (frame.x === undefined || (Math.abs((held.x ?? NaN) - frame.x) <= 0.5 && Math.abs((held.y ?? NaN) - (frame.y ?? 0)) <= 0.5));
    if (same) return;
    this.frames.set(folder, { ...held, ...frame });
    this.schedule();
  }

  /**
   * Takes the positions of everything currently on the canvas. Replacing rather than
   * merging is deliberate: notes that have been deleted drop out of the file instead of
   * accumulating in it forever.
   */
  takeNodes(positions: Iterable<[string, Point]>): void {
    const next = new Map(positions);
    if (next.size === this.nodes.size) {
      let same = true;
      for (const [path, at] of next) {
        const held = this.nodes.get(path);
        // Sub-pixel drift is not worth a write.
        if (!held || Math.abs(held.x - at.x) > 0.5 || Math.abs(held.y - at.y) > 0.5) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    this.nodes = next;
    this.schedule();
  }

  private schedule(): void {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), WRITE_DELAY);
  }

  /** Writes now if anything is pending. Safe to call at any time. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty || !this.vault) return;
    this.dirty = false;
    const snap: Snapshot = {
      version: 1,
      nodes: Object.fromEntries(this.nodes),
      frames: Object.fromEntries(this.frames),
    };
    try {
      // Keep the arrangement this vault was opened with, once, before touching it.
      if (!this.backedUp && this.opened) {
        this.backedUp = true;
        await this.vault.write(LAYOUT_BACKUP, this.opened);
      }
      await this.vault.write(LAYOUT_FILE, JSON.stringify(snap, null, 1) + "\n");
    } catch {
      // A read-only vault still works; it just will not remember the arrangement.
    }
  }
}
