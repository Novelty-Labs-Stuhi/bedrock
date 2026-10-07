// The vault picker: the vaults under the Bedrock folder, as a list to type into — the
// front door of a window with no vault, and ⌘O over one that has. No OS sheet: the list is
// read off the disk by the shell, and a name that matches nothing becomes a new vault.

export type PickerHooks = {
  /** Open the vault at `root`; `listing` is what the picker knew about it. */
  open(root: string, listing: VaultListing | null): void;
  /** A browser tab has no Bedrock folder to list: the OS's own folder dialog instead. */
  browse(): void;
  /** Whether there is a vault behind the picker to go back to (Esc, a click outside). */
  canClose(): boolean;
};

type Row = { kind: "vault"; vault: VaultListing } | { kind: "create"; name: string } | { kind: "browse" };

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

export function mountPicker(host: HTMLElement, hooks: PickerHooks) {
  host.innerHTML =
    `<div class="picker">` +
    `<div class="picker-title">Bedrock</div>` +
    `<input class="picker-search" type="text" spellcheck="false" placeholder="Open a vault, or name a new one" />` +
    `<div class="picker-list" role="listbox"></div>` +
    `<div class="picker-foot"><span class="picker-base"></span><span class="picker-note"></span></div>` +
    `</div>`;
  const input = host.querySelector<HTMLInputElement>(".picker-search")!;
  const list = host.querySelector<HTMLElement>(".picker-list")!;
  const base = host.querySelector<HTMLElement>(".picker-base")!;
  const note = host.querySelector<HTMLElement>(".picker-note")!;

  let vaults: VaultListing[] = [];
  let rows: Row[] = [];
  let at = 0;

  function build(): void {
    const query = input.value.trim();
    const q = query.toLowerCase();
    const hits = q ? vaults.filter((v) => v.name.toLowerCase().includes(q)) : vaults;
    // Prefix matches first, then the rest in the order they came (most recent first).
    if (q) hits.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)));
    rows = hits.map((vault) => ({ kind: "vault", vault }) as Row);
    if (window.bedrock) {
      if (query && !vaults.some((v) => v.name.toLowerCase() === q)) rows.push({ kind: "create", name: query });
    } else rows.push({ kind: "browse" });
    at = Math.min(at, Math.max(rows.length - 1, 0));
    list.innerHTML = rows
      .map((row, i) => {
        const on = i === at ? " on" : "";
        if (row.kind === "vault") {
          const side = row.vault.open ? "open" : ago(row.vault.edited);
          return `<div class="picker-row${on}" data-i="${i}"><span class="picker-name">${escapeHtml(row.vault.name)}</span><span class="picker-side">${side}</span></div>`;
        }
        if (row.kind === "create")
          return `<div class="picker-row picker-new${on}" data-i="${i}"><span class="picker-name">New vault <b>${escapeHtml(row.name)}</b></span><span class="picker-side">↵</span></div>`;
        return `<div class="picker-row picker-new${on}" data-i="${i}"><span class="picker-name">Open a folder…</span></div>`;
      })
      .join("");
    if (!rows.length) list.innerHTML = `<div class="picker-empty">No vaults yet — type a name to make one</div>`;
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
    if (row.kind === "browse") return hooks.browse();
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
      if (input.value) {
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
  // A click on the backdrop goes back to the vault behind, when there is one.
  host.addEventListener("mousedown", (event) => {
    if (event.target === host && hooks.canClose()) hide();
  });
  // The input keeps the keyboard however the window was focused.
  host.addEventListener("mouseup", () => input.focus());

  async function show(message = ""): Promise<void> {
    host.hidden = false;
    input.value = "";
    note.textContent = message;
    at = 0;
    input.focus();
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
