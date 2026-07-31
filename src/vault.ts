// A vault is a flat listing of markdown files + the folders that hold them.
// Paths are always "/"-separated and relative to the vault root ("notes/idea.md").

export type Entry = { path: string; kind: "file" | "dir" };

export interface Vault {
  readonly name: string;
  /** Every folder and every .md file in the vault. */
  entries(): Promise<Entry[]>;
  /** Whether a file is actually there — `write` creates, so callers that must not. */
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  createDir(path: string): Promise<void>;
  /** Creates the file (and any missing parent folders) if it does not exist. */
  createFile(path: string, text?: string): Promise<void>;
  remove(path: string, kind: "file" | "dir"): Promise<void>;
  rename(from: string, to: string, kind: "file" | "dir"): Promise<void>;

  /* Attachments. Images are vault files too, but they are NOT notes: they stay out of
     `entries()` so the tree, the graph and link resolution keep seeing markdown only. */

  /** Every image file in the vault, "/"-separated from the root. */
  assets(): Promise<string[]>;
  /** An attachment's bytes, or null when it is not there. */
  readBinary(path: string): Promise<Blob | null>;
  writeBinary(path: string, data: Blob): Promise<void>;
}

/* ---------------------------------------------------------------- paths --- */

export const parts = (path: string): string[] => path.split("/").filter(Boolean);
export const dirname = (path: string): string => parts(path).slice(0, -1).join("/");
export const basename = (path: string): string => parts(path).pop() ?? "";
/** File name without the .md extension — what [[wikilinks]] refer to. */
export const noteName = (path: string): string => basename(path).replace(/\.md$/i, "");
export const join = (...bits: string[]): string => bits.filter(Boolean).join("/");
export const isMarkdown = (path: string): boolean => /\.md$/i.test(path);
/**
 * Anything under a dot-prefixed segment is the app's own state, not the user's notes —
 * `.notes/layout.json`, `.obsidian/`, and so on. Kept out of every listing, so the tree,
 * the graph and link resolution never see it.
 */
export const isHidden = (path: string): boolean => parts(path).some((part) => part.startsWith("."));

/** Extensions treated as embeddable images (what a drop or a `![[…]]` may carry). */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"];
const IMAGE_RE = new RegExp(`\\.(${IMAGE_EXTENSIONS.join("|")})$`, "i");
/** True for a path (or link target) that names an image — the query/hash tail is ignored. */
export const isImage = (path: string): boolean => IMAGE_RE.test(path.split(/[?#]/)[0]);

/** Where dropped and pasted images land — matches the vault's existing `![[screenshots/…]]`. */
export const ATTACHMENT_DIR = "screenshots";

/**
 * First free path of the form `dir/base.ext`, `dir/base 2.ext`, … — so creation
 * never has to block on a name.
 */
export function uniquePath(existing: Iterable<string>, dir: string, base: string, ext: string): string {
  const taken = new Set([...existing].map((p) => p.toLowerCase()));
  let candidate = join(dir, `${base}${ext}`);
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = join(dir, `${base} ${n}${ext}`);
  return candidate;
}

/** Every ancestor folder of a path, outermost first: a/b/c.md -> ["a", "a/b"]. */
export function ancestors(path: string): string[] {
  const p = parts(dirname(path));
  return p.map((_, i) => p.slice(0, i + 1).join("/"));
}

/* --------------------------------------------------------- localStorage --- */

/** ``assets`` holds attachments as data URLs — localStorage cannot keep a Blob. */
type Snapshot = { dirs: string[]; files: Record<string, string>; assets?: Record<string, string> };

const KEY = "obsidian-lite:vault";

/* ------------------------------------------------------------- blob <-> url --- */

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Default in-browser vault, so the app is usable without picking a folder. */
export class LocalVault implements Vault {
  readonly name = "local vault";
  private snap: Snapshot;

  constructor() {
    this.snap = this.load();
  }

  private load(): Snapshot {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Snapshot;
        if (parsed && parsed.files)
          return { dirs: parsed.dirs ?? [], files: parsed.files, assets: parsed.assets ?? {} };
      }
    } catch {
      /* corrupt payload — fall through to the seed */
    }
    return seed();
  }

  private flush(): void {
    localStorage.setItem(KEY, JSON.stringify(this.snap));
  }

  async entries(): Promise<Entry[]> {
    const files = Object.keys(this.snap.files).filter((path) => !isHidden(path));
    const dirs = new Set(this.snap.dirs.filter((path) => !isHidden(path)));
    for (const path of files) for (const d of ancestors(path)) dirs.add(d);
    return [
      ...[...dirs].map((path) => ({ path, kind: "dir" as const })),
      ...files.map((path) => ({ path, kind: "file" as const })),
    ];
  }

  async exists(path: string): Promise<boolean> {
    return path in this.snap.files;
  }

  async read(path: string): Promise<string> {
    return this.snap.files[path] ?? "";
  }

  async write(path: string, text: string): Promise<void> {
    this.snap.files[path] = text;
    this.flush();
  }

  async createDir(path: string): Promise<void> {
    if (!this.snap.dirs.includes(path)) this.snap.dirs.push(path);
    this.flush();
  }

  async createFile(path: string, text = ""): Promise<void> {
    if (!(path in this.snap.files)) this.snap.files[path] = text;
    this.flush();
  }

  async remove(path: string, kind: "file" | "dir"): Promise<void> {
    const assets = this.snap.assets ?? (this.snap.assets = {});
    if (kind === "file") {
      delete this.snap.files[path];
      delete assets[path];
    } else {
      const prefix = path + "/";
      this.snap.dirs = this.snap.dirs.filter((d) => d !== path && !d.startsWith(prefix));
      for (const f of Object.keys(this.snap.files)) if (f.startsWith(prefix)) delete this.snap.files[f];
      for (const a of Object.keys(assets)) if (a.startsWith(prefix)) delete assets[a];
    }
    this.flush();
  }

  async rename(from: string, to: string, kind: "file" | "dir"): Promise<void> {
    const assets = this.snap.assets ?? (this.snap.assets = {});
    if (kind === "file") {
      if (from === to) return;
      if (from in assets) {
        assets[to] = assets[from];
        delete assets[from];
      } else {
        this.snap.files[to] = this.snap.files[from] ?? "";
        delete this.snap.files[from];
      }
    } else {
      const move = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
      this.snap.dirs = this.snap.dirs.map(move);
      const next: Record<string, string> = {};
      for (const [p, text] of Object.entries(this.snap.files)) next[move(p)] = text;
      this.snap.files = next;
      const movedAssets: Record<string, string> = {};
      for (const [p, url] of Object.entries(assets)) movedAssets[move(p)] = url;
      this.snap.assets = movedAssets;
    }
    this.flush();
  }

  async assets(): Promise<string[]> {
    return Object.keys(this.snap.assets ?? {}).filter((path) => !isHidden(path));
  }

  async readBinary(path: string): Promise<Blob | null> {
    const url = (this.snap.assets ?? {})[path];
    if (!url) return null;
    return (await fetch(url)).blob();
  }

  async writeBinary(path: string, data: Blob): Promise<void> {
    const assets = this.snap.assets ?? (this.snap.assets = {});
    assets[path] = await blobToDataUrl(data);
    try {
      this.flush();
    } catch (err) {
      // localStorage is a few MB; a couple of screenshots fill it. Roll the write back so the
      // note never ends up embedding an attachment the vault does not actually hold.
      delete assets[path];
      const why = err instanceof Error ? err.name : String(err);
      throw new Error(
        `the local vault is full (${(data.size / 1e6).toFixed(1)} MB image, ${why}) — ` +
          "open a real folder to keep images",
      );
    }
  }
}

function seed(): Snapshot {
  return {
    dirs: ["ideas", "people"],
    files: {
      "Home.md": "# Home\n\nStart here. Try [[Graph]] and [[ideas/Cytoscape]].\n",
      "Graph.md": "# Graph\n\nThe graph view is just another open tab. Folders are the boxes.\n\nSee [[Home]].\n",
      "ideas/Cytoscape.md": "# Cytoscape\n\nCompound nodes + the cola layout.\n\nLinked from [[Home]], relates to [[ideas/Obsidian]].\n",
      "ideas/Obsidian.md": "# Obsidian\n\nMarkdown files, `[[wikilinks]]`, a graph.\n\nSee [[ideas/Cytoscape]] and [[people/Ada]].\n",
      "people/Ada.md": "# Ada\n\nWrote about [[ideas/Cytoscape]].\n",
    },
  };
}

/* ------------------------------------------------ File System Access API --- */

export const canPickFolder = (): boolean => "showDirectoryPicker" in window;

/** Vault backed by a real folder on disk (Chromium: showDirectoryPicker). */
export class FolderVault implements Vault {
  constructor(private root: FileSystemDirectoryHandle) {}

  get name(): string {
    return this.root.name;
  }

  static async pick(): Promise<FolderVault> {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    return new FolderVault(handle);
  }

  /** One walk, both listings: markdown entries for the app, image paths for embeds. */
  private async scan(): Promise<{ entries: Entry[]; assets: string[] }> {
    const entries: Entry[] = [];
    const assets: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const handle of dir.values()) {
        if (handle.name.startsWith(".")) continue;
        const path = join(prefix, handle.name);
        if (handle.kind === "directory") {
          entries.push({ path, kind: "dir" });
          await walk(handle as FileSystemDirectoryHandle, path);
        } else if (isMarkdown(handle.name)) {
          entries.push({ path, kind: "file" });
        } else if (isImage(handle.name)) {
          assets.push(path);
        }
      }
    };
    await walk(this.root, "");
    return { entries, assets };
  }

  async entries(): Promise<Entry[]> {
    return (await this.scan()).entries;
  }

  async assets(): Promise<string[]> {
    return (await this.scan()).assets;
  }

  async readBinary(path: string): Promise<Blob | null> {
    try {
      return await (await this.file(path)).getFile();
    } catch {
      return null; // not there — the caller renders a missing-image marker
    }
  }

  async writeBinary(path: string, data: Blob): Promise<void> {
    const writable = await (await this.file(path, true)).createWritable();
    await writable.write(data);
    await writable.close();
  }

  private async dir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    let handle = this.root;
    for (const part of parts(path)) handle = await handle.getDirectoryHandle(part, { create });
    return handle;
  }

  private async file(path: string, create = false): Promise<FileSystemFileHandle> {
    const parent = await this.dir(dirname(path), create);
    return parent.getFileHandle(basename(path), { create });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.file(path);
      return true;
    } catch {
      return false;
    }
  }

  async read(path: string): Promise<string> {
    return (await (await this.file(path)).getFile()).text();
  }

  async write(path: string, text: string): Promise<void> {
    const writable = await (await this.file(path, true)).createWritable();
    await writable.write(text);
    await writable.close();
  }

  async createDir(path: string): Promise<void> {
    await this.dir(path, true);
  }

  async createFile(path: string, text = ""): Promise<void> {
    try {
      await this.file(path);
      return; // already there
    } catch {
      await this.write(path, text);
    }
  }

  async remove(path: string, _kind: "file" | "dir"): Promise<void> {
    const parent = await this.dir(dirname(path));
    await parent.removeEntry(basename(path), { recursive: true });
  }

  async rename(from: string, to: string, kind: "file" | "dir"): Promise<void> {
    if (from === to) return;

    if (kind === "file") {
      const handle = await this.file(from);
      // A real move where the platform has one: nothing is copied, so nothing can
      // be left behind if the tidy-up afterwards fails.
      if (canMove(handle)) {
        await handle.move(await this.dir(dirname(to), true), basename(to));
        return;
      }
      await this.write(to, await this.read(from));
      await this.remove(from, "file");
      return;
    }

    const source = await this.dir(from);
    const parent = await this.dir(dirname(to), true);
    if (canMove(source)) {
      await source.move(parent, basename(to));
      return;
    }

    /*
     * No native move, so the tree has to be copied and the original dropped. Two
     * things matter, and the obvious version gets both wrong:
     *
     *   - Copy EVERYTHING, not just the markdown. `entries()` lists notes only, so
     *     walking it silently destroys every image and attachment in the folder.
     *   - Never leave both copies. A failed copy is rolled back; a copy that cannot
     *     then remove the original is reported as such, because a folder quietly
     *     duplicated on disk is worse than a move that plainly did not happen.
     */
    const target = await parent.getDirectoryHandle(basename(to), { create: true });
    try {
      await copyTree(source, target);
    } catch (err) {
      await parent.removeEntry(basename(to), { recursive: true }).catch(() => {});
      throw err;
    }
    try {
      await this.remove(from, "dir");
    } catch (err) {
      throw new Error(
        `copied ${from} to ${to} but could not remove the original — both are on disk ` +
          `(${(err as Error).message})`,
      );
    }
  }
}

/** Handles gain `move()` in newer Chromium; it is not in TypeScript's DOM lib yet. */
type Movable = { move(parent: FileSystemDirectoryHandle, name: string): Promise<void> };

const canMove = <T extends FileSystemHandle>(handle: T): handle is T & Movable =>
  typeof (handle as unknown as Partial<Movable>).move === "function";

/** Every file and subfolder, attachments and dot-files included. */
async function copyTree(from: FileSystemDirectoryHandle, to: FileSystemDirectoryHandle): Promise<void> {
  for await (const handle of from.values()) {
    if (handle.kind === "directory") {
      const child = await to.getDirectoryHandle(handle.name, { create: true });
      await copyTree(handle as FileSystemDirectoryHandle, child);
      continue;
    }
    const file = await (handle as FileSystemFileHandle).getFile();
    const writable = await (await to.getFileHandle(handle.name, { create: true })).createWritable();
    await writable.write(file);
    await writable.close();
  }
}
