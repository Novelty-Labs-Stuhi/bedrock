// The vault picker: the front door of a window with no vault, and ⌘O over one that has.
// New vault and Open folder… on top (the latter the OS's own sheet, for a folder anywhere);
// below, the vaults under the Bedrock folder, read off the disk by the shell, to search.

export type PickerHooks = {
  /** Open the vault at `root`; `listing` is what the picker knew about it. */
  open(root: string, listing: VaultListing | null): void;
  /** Open folder…: the OS's own folder dialog, for a folder anywhere on the disk. */
  browse(): void;
  /** Whether there is a vault behind the picker to go back to (Esc, a click outside). */
  canClose(): boolean;
};

type Row = { kind: "vault"; vault: VaultListing } | { kind: "create"; name: string };

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function ago(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const tilde = (p: string): string => p.replace(/^\/Users\/[^/]+/, "~");

// The app's mark (build/icon.png), drawn: the graph on a black tile.
const MARK =
  `<svg class="picker-mark" viewBox="100 100 824 824" aria-hidden="true">` +
  `<rect x="100" y="100" width="824" height="824" rx="185" fill="#000" stroke="rgba(255,255,255,.14)" stroke-width="10"/>` +
  `<g stroke="#fff" stroke-width="26"><path d="M298 298L472 442L726 372M472 442L298 610M472 442L683 646L458 726"/></g>` +
  `<g fill="#fff"><circle cx="298" cy="298" r="48"/><circle cx="472" cy="442" r="90"/><circle cx="726" cy="372" r="48"/>` +
  `<circle cx="298" cy="610" r="48"/><circle cx="683" cy="646" r="90"/><circle cx="458" cy="726" r="48"/></g></svg>`;

const ICON_NEW =
  `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z M8 7.5v4 M6 9.5h4"/></svg>`;
const ICON_OPEN = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z"/></svg>`;

export function mountPicker(host: HTMLElement, hooks: PickerHooks) {
  host.innerHTML =
    `<div class="picker">` +
    `<div class="picker-brand">${MARK}<div><div class="picker-title">Bedrock</div><div class="picker-base"></div></div></div>` +
    `<div class="picker-cards">` +
    `<button class="picker-card" data-card="new">${ICON_NEW}<span>New vault</span></button>` +
    `<button class="picker-card" data-card="open">${ICON_OPEN}<span>Open folder…</span></button>` +
    `</div>` +
    `<div class="picker-label">Recent vaults</div>` +
    `<input class="picker-search" type="text" spellcheck="false" />` +
    `<div class="picker-list" role="listbox"></div>` +
    `<div class="picker-note"></div>` +
    `</div>`;
  const input = host.querySelector<HTMLInputElement>(".picker-search")!;
  const list = host.querySelector<HTMLElement>(".picker-list")!;
  const base = host.querySelector<HTMLElement>(".picker-base")!;
  const note = host.querySelector<HTMLElement>(".picker-note")!;

  const label = host.querySelector<HTMLElement>(".picker-label")!;

  let vaults: VaultListing[] = [];
  let rows: Row[] = [];
  let at = 0;
  /** "New vault" was pressed: what is typed is a name, and the list only offers to make it. */
  let naming = false;

  function setNaming(on: boolean): void {
    naming = on && !!window.bedrock;
    input.value = "";
    note.textContent = "";
    label.textContent = naming ? "New vault" : "Recent vaults";
    input.placeholder = naming ? "Name the new vault, then ↵" : "Search vaults";
    at = 0;
    build();
    input.focus();
  }

  function build(): void {
    const query = input.value.trim();
    const q = query.toLowerCase();
    const hits = naming ? [] : q ? vaults.filter((v) => v.name.toLowerCase().includes(q)) : vaults;
    // Prefix matches first, then the rest in the order they came (most recent first).
    if (q) hits.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)));
    rows = hits.map((vault) => ({ kind: "vault", vault }) as Row);
    if (window.bedrock) {
      if (query && !vaults.some((v) => v.name.toLowerCase() === q)) rows.push({ kind: "create", name: query });
    }
    at = Math.min(at, Math.max(rows.length - 1, 0));
    list.innerHTML = rows
      .map((row, i) => {
        const on = i === at ? " on" : "";
        if (row.kind === "vault") {
          const side = row.vault.open ? "open" : ago(row.vault.edited);
          return `<div class="picker-row${on}" data-i="${i}"><span class="picker-name">${escapeHtml(row.vault.name)}</span><span class="picker-side">${side}</span></div>`;
        }
        return `<div class="picker-row picker-new${on}" data-i="${i}"><span class="picker-name">New vault <b>${escapeHtml(row.name)}</b></span><span class="picker-side">↵</span></div>`;
      })
      .join("");
    if (!rows.length)
      list.innerHTML = `<div class="picker-empty">${naming ? (query ? `${escapeHtml(query)} already exists` : "Type a name") : q ? "No vault by that name" : "No vaults yet — New vault makes one"}</div>`;
    list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }

  function select(i: number): void {
    at = (i + rows.length) % Math.max(rows.length, 1);
    list.querySelectorAll(".picker-row").forEach((el, k) => el.classList.toggle("on", k === at));
    list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }

  async function choose(i: number): Promise<void> {
    const row = rows[i];
    if (!row) return;
    if (row.kind === "vault") return hooks.open(row.vault.root, row.vault);
    try {
      const root = await window.bedrock!.vaultCreate(row.name);
      hooks.open(root, null);
    } catch (err) {
      note.textContent = String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    }
  }

  input.addEventListener("input", () => {
    at = 0;
    note.textContent = "";
    build();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) select(at + 1);
    else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) select(at - 1);
    else if (event.key === "Enter") void choose(at);
    else if (event.key === "Escape") {
      if (naming) setNaming(false);
      else if (input.value) {
        input.value = "";
        build();
      } else if (hooks.canClose()) hide();
    } else return;
    event.preventDefault();
  });
  list.addEventListener("mousemove", (event) => {
    const i = (event.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i;
    if (i !== undefined && Number(i) !== at) select(Number(i));
  });
  list.addEventListener("click", (event) => {
    const i = (event.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i;
    if (i !== undefined) void choose(Number(i));
  });
  host.querySelector(".picker-cards")!.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-card]")?.dataset.card;
    if (card === "new") setNaming(!naming);
    else if (card === "open") hooks.browse();
  });
  // A click on the backdrop goes back to the vault behind, when there is one.
  host.addEventListener("mousedown", (event) => {
    if (event.target === host && hooks.canClose()) hide();
  });
  // The input keeps the keyboard however the window was focused.
  host.addEventListener("mouseup", () => input.focus());

  async function show(message = ""): Promise<void> {
    host.hidden = false;
    setNaming(false);
    note.textContent = message;
    if (window.bedrock) {
      const listed = await window.bedrock.vaultsList().catch(() => null);
      vaults = listed?.vaults ?? [];
      base.textContent = listed ? tilde(listed.base) : "";
    }
    build();
    input.focus();
  }

  function hide(): void {
    host.hidden = true;
  }

  return { show, hide, get shown() { return !host.hidden; } };
}
