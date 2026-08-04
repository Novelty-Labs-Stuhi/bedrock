// Which integrations this vault has switched on.
//
// Kept in `.notes/config.json`, beside the layout cache and the stickies: a toggle is a
// property of the vault, so it travels with the folder rather than living in the app.

import type { Vault } from "./vault";

export type Feature = "stickies" | "linear" | "git" | "gemini" | "claude" | "active";

export const CONFIG_FILE = ".notes/config.json";

/** Stickies default on — they predate the switch, so an old vault keeps what it had. */
const DEFAULTS: Record<Feature, boolean> = {
  stickies: true,
  linear: false,
  git: false,
  gemini: false,
  claude: false,
  active: false,
};

/** Linear took the todos' place, so a vault that had todos on keeps its checklists. */
const RENAMED: Record<string, Feature> = { todos: "linear" };

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
      const parsed = JSON.parse(raw) as { features?: Record<string, unknown> };
      for (const key of Object.keys(DEFAULTS) as Feature[]) {
        const value = parsed.features?.[key];
        if (typeof value === "boolean") this.features[key] = value;
      }
      for (const [was, now] of Object.entries(RENAMED)) {
        const value = parsed.features?.[was];
        if (typeof value === "boolean" && parsed.features?.[now] === undefined) this.features[now] = value;
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
  { feature: "linear", name: "Linear", what: "issue notes — tick them here, the tick lands in Linear" },
  { feature: "git", name: "Git", what: "a commit button that snapshots the vault (desktop app)" },
  { feature: "gemini", name: "Gemini", what: "conversation notes — rectangles that open the chat in the browser" },
  {
    feature: "claude",
    name: "Claude Code",
    what: "session notes — the node opens a coding session in the Claude app (desktop app)",
  },
  { feature: "active", name: "Active", what: "right-click a note to make it radiate a green pulse" },
];

/**
 * A line under a row's own description, for an integration that has something to say
 * about itself — Linear needs to report whether it is connected, and offer the button
 * that changes that. `action` is the button's label; null means the row is plain.
 */
export type RowDetail = { text: string; action?: string } | null;

export type PanelHooks = {
  detail?: (feature: Feature) => RowDetail;
  onAction?: (feature: Feature) => void;
};

/**
 * Wires the ⚙ button to a panel of toggles floated over the sidebar's foot. Same
 * manners as the help panel: Esc, a click outside, or the button itself close it.
 * Returns a redraw, for when something the panel reports about has changed.
 */
export function mountSettings(
  button: HTMLElement,
  panel: HTMLElement,
  store: SettingsStore,
  hooks: PanelHooks = {},
): () => void {
  const draw = (): void => {
    panel.innerHTML =
      `<h4>Integrations</h4>` +
      ROWS.map((row) => {
        const detail = hooks.detail?.(row.feature) ?? null;
        return (
          `<label class="setting"><input type="checkbox" data-feature="${row.feature}"` +
          `${store.enabled(row.feature) ? " checked" : ""} />` +
          `<span><b>${row.name}</b><small>${row.what}</small>` +
          (detail
            ? `<small class="setting-detail">${detail.text}` +
              (detail.action
                ? ` <button type="button" data-connect="${row.feature}">${detail.action}</button>`
                : "") +
              `</small>`
            : "") +
          `</span></label>`
        );
      }).join("");
  };

  panel.addEventListener("change", (event) => {
    const box = event.target as HTMLInputElement;
    const feature = box.dataset.feature as Feature | undefined;
    if (feature) {
      store.set(feature, box.checked);
      draw(); // a row switched on may now have something to report
    }
  });

  panel.addEventListener("click", (event) => {
    const feature = (event.target as HTMLElement).closest<HTMLElement>("[data-connect]")?.dataset
      .connect as Feature | undefined;
    if (!feature) return;
    // The button lives inside the <label>, whose click would flip the checkbox too.
    event.preventDefault();
    hooks.onAction?.(feature);
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

  // Only worth redrawing while it is on screen; opening it draws anyway.
  return () => {
    if (!panel.classList.contains("hidden")) draw();
  };
}
