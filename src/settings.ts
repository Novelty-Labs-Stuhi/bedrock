// Which integrations this vault has switched on.
//
// Kept in `.notes/config.json`, beside the layout cache and the stickies: a toggle is a
// property of the vault, so it travels with the folder rather than living in the app.

import type { Vault } from "./vault";

export type Feature = "stickies" | "todos" | "git" | "gemini";

export const CONFIG_FILE = ".notes/config.json";

/** Stickies default on — they predate the switch, so an old vault keeps what it had. */
const DEFAULTS: Record<Feature, boolean> = { stickies: true, todos: false, git: false, gemini: false };

const WRITE_DELAY = 700;

export class SettingsStore {
  private vault: Vault | null = null;
  private features: Record<Feature, boolean> = { ...DEFAULTS };
  private timer: number | undefined;
  private dirty = false;
  /** Fired after any toggle, so the menu, the canvas and the git button follow at once. */
  onChange: (() => void) | null = null;

  /** Reads this vault's config, after flushing any owed to the previous one. */
  async attach(vault: Vault): Promise<void> {
    await this.flush();
    this.vault = vault;
    this.features = { ...DEFAULTS };
    let raw = "";
    try {
      raw = await vault.read(CONFIG_FILE);
    } catch {
      return; // no config yet — the defaults are the config
    }
    if (!raw.trim()) return;
    try {
      const parsed = JSON.parse(raw) as { features?: Partial<Record<Feature, unknown>> };
      for (const key of Object.keys(DEFAULTS) as Feature[]) {
        const value = parsed.features?.[key];
        if (typeof value === "boolean") this.features[key] = value;
      }
    } catch {
      // A corrupt config is a cosmetic loss; the defaults keep the vault usable.
    }
  }

  enabled(feature: Feature): boolean {
    return this.features[feature];
  }

  set(feature: Feature, on: boolean): void {
    if (this.features[feature] === on) return;
    this.features[feature] = on;
    this.schedule();
    this.onChange?.();
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
      await this.vault.write(
        CONFIG_FILE,
        JSON.stringify({ version: 1, features: this.features }, null, 1) + "\n",
      );
    } catch {
      /* read-only vault */
    }
  }
}

/* -------------------------------------------------------------------- panel --- */

const ROWS: Array<{ feature: Feature; name: string; what: string }> = [
  { feature: "stickies", name: "Stickies", what: "loose text pinned to the canvas" },
  { feature: "todos", name: "Todos", what: "checklist stickies that can point an arrow at a note" },
  { feature: "git", name: "Git", what: "a commit button that snapshots the vault (desktop app)" },
  { feature: "gemini", name: "Gemini", what: "conversation notes — rectangles that open the chat in the browser" },
];

/**
 * Wires the ⚙ button to a panel of toggles floated over the sidebar's foot. Same
 * manners as the help panel: Esc, a click outside, or the button itself close it.
 */
export function mountSettings(button: HTMLElement, panel: HTMLElement, store: SettingsStore): void {
  const draw = (): void => {
    panel.innerHTML =
      `<h4>Integrations</h4>` +
      ROWS.map(
        (row) =>
          `<label class="setting"><input type="checkbox" data-feature="${row.feature}"` +
          `${store.enabled(row.feature) ? " checked" : ""} />` +
          `<span><b>${row.name}</b><small>${row.what}</small></span></label>`,
      ).join("");
  };

  panel.addEventListener("change", (event) => {
    const box = event.target as HTMLInputElement;
    const feature = box.dataset.feature as Feature | undefined;
    if (feature) store.set(feature, box.checked);
  });

  const show = (open: boolean): void => {
    if (open) draw(); // the vault (and so the config) may have changed since last time
    panel.classList.toggle("hidden", !open);
    button.classList.toggle("on", open);
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation(); // else the document handler below closes it again at once
    show(panel.classList.contains("hidden"));
  });
  panel.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => show(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") show(false);
  });
}
