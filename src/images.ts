// Attachments: turning `![[…]]` embeds into visible pixels, and dropped/pasted files into files.
//
// The renderer emits `<img data-vault-src="…">` because a vault attachment has no URL — its bytes
// live in localStorage or behind a directory handle. Everything that bridges that gap is here.

import { ATTACHMENT_DIR, basename, dirname, isImage, join, uniquePath, type Vault } from "./vault";

/** Object URLs handed to the DOM, so a re-render can revoke the previous batch. */
let live: string[] = [];

function revokeLive(): void {
  for (const url of live) URL.revokeObjectURL(url);
  live = [];
}

/**
 * Obsidian-style resolution of an embed target against the vault's attachments:
 *   1. the exact path from the vault root (`screenshots/x.png` — what this app writes),
 *   2. relative to the note holding the embed (`x.png` next to the note),
 *   3. any attachment with that file name, shallowest first (Obsidian's bare-name rule).
 * Case-insensitive, because the two vault backends disagree about case.
 */
export function resolveAsset(target: string, notePath: string, assets: string[]): string | null {
  const want = target.replace(/^\.?\//, "").toLowerCase();
  const byPath = new Map<string, string>();
  const depth = (p: string) => p.split("/").length;
  for (const path of [...assets].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))) {
    byPath.set(path.toLowerCase(), path);
  }
  const exact = byPath.get(want);
  if (exact) return exact;

  const beside = join(dirname(notePath), want).toLowerCase();
  const near = byPath.get(beside);
  if (near) return near;

  const name = basename(want);
  for (const [key, path] of byPath) if (basename(key) === name) return path;
  return null;
}

/**
 * Give every `data-vault-src` image real bytes. Unresolved embeds are marked instead of left blank,
 * so a broken path looks broken rather than looking like the renderer failed.
 */
export async function hydrateImages(root: HTMLElement, notePath: string, vault: Vault): Promise<void> {
  const targets = [...root.querySelectorAll<HTMLImageElement>("img[data-vault-src]")];
  revokeLive(); // the previous render's URLs are detached now
  if (!targets.length) return;

  const assets = await vault.assets();
  await Promise.all(
    targets.map(async (img) => {
      const target = img.dataset.vaultSrc ?? "";
      const path = resolveAsset(target, notePath, assets);
      const blob = path ? await vault.readBinary(path) : null;
      if (!blob) {
        img.classList.add("missing");
        img.replaceWith(missingMarker(target));
        return;
      }
      const url = URL.createObjectURL(blob);
      live.push(url);
      img.src = url;
      img.title = path ?? target;
    }),
  );
}

function missingMarker(target: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "embed-missing";
  span.textContent = `🖼 missing: ${target}`;
  span.title = "no attachment in the vault matches this embed";
  return span;
}

/* ------------------------------------------------------------------ writing --- */

const stamp = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const extensionOf = (file: File): string => {
  const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1];
  if (fromName) return fromName.toLowerCase();
  return (/^image\/([a-z0-9.+-]+)$/i.exec(file.type)?.[1] ?? "png").replace("jpeg", "jpg");
};

/** Images among dropped/pasted items — a drop of mixed content contributes only its pictures. */
export function imageFiles(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  const files = [...(transfer.files ?? [])];
  const fromItems = [...(transfer.items ?? [])]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null);
  const all = files.length ? files : fromItems;
  return all.filter((file) => file.type.startsWith("image/") || isImage(file.name));
}

/**
 * Store one image in the vault and return the embed to write into the note. Pasted screenshots
 * arrive as `image.png`/blank, so those get an Obsidian-style timestamped name; a dropped file keeps
 * its own name, uniquified so a second drop never overwrites the first.
 */
export async function saveImage(vault: Vault, file: File): Promise<{ path: string; embed: string }> {
  const ext = extensionOf(file);
  const named = file.name && !/^image\.(png|jpe?g)$/i.test(file.name);
  const base = named ? file.name.replace(/\.[a-z0-9]+$/i, "") : `Pasted image ${stamp()}`;
  const path = uniquePath(await vault.assets(), ATTACHMENT_DIR, sanitize(base), `.${ext}`);
  await vault.createDir(ATTACHMENT_DIR);
  await vault.writeBinary(path, file);
  return { path, embed: `![[${path}]]` };
}

/** Keep names path-safe; the embed syntax also dislikes brackets and pipes. */
const sanitize = (name: string): string =>
  name.replace(/[\\/:*?"<>|[\]]+/g, " ").replace(/\s+/g, " ").trim() || "image";

/** Splice text into a textarea at the caret, leaving the caret after it. */
export function insertAtCaret(editor: HTMLTextAreaElement, text: string): void {
  const start = editor.selectionStart ?? editor.value.length;
  const end = editor.selectionEnd ?? start;
  const before = editor.value.slice(0, start);
  const after = editor.value.slice(end);
  // An embed wants its own line — pad only where padding is missing.
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  const trail = after.startsWith("\n") || after === "" ? "" : "\n";
  editor.value = `${before}${lead}${text}${trail}${after}`;
  const caret = (before + lead + text).length;
  editor.setSelectionRange(caret, caret);
}
