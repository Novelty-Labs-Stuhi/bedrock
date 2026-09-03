// What this vault is set up to be: how the canvas looks, which features are switched on,
// and which outside services it is plugged into.
//
// All of it is kept in `.notes/config.json`, beside the layout cache and the stickies:
// a preference is a property of the vault, so it travels with the folder rather than
// living in the app. The one thing NOT kept here is a credential — Linear's API key is
// the shell's business (the OS keychain), deliberately not the vault's, because the
// commit button snapshots the vault wholesale.

import { swatchRow } from "./node-style";
import { SIZINGS, type Sizing } from "./scoring";
import type { Vault } from "./vault";

export type Feature =
  | "stickies"
  | "linear"
  | "git"
  | "antigravity"
  | "claude"
  | "files"
  | "web"
  | "active"
  | "freeform"
  | "notion"
  | "slack"
  | "google"
  | "applenotes"
  | "word";

export const CONFIG_FILE = ".notes/config.json";

/**
 * Everything off. A vault is a folder of markdown until somebody says otherwise: nobody
 * opening one for the first time asked for sticky notes, webpage tiles or a Linear
 * connection, and a feature that has to be switched on is a feature somebody chose.
 *
 * A vault that already has a config keeps whatever is written in it — these are the
 * answers for the keys nobody has answered yet, not a reset.
 */
const DEFAULTS: Record<Feature, boolean> = {
  stickies: false,
  linear: false,
  git: false,
  antigravity: false,
  claude: false,
  files: false,
  web: false,
  active: false,
  freeform: false,
  notion: false,
  slack: false,
  google: false,
  applenotes: false,
  word: false,
};

/** Linear took the todos' place, so a vault that had todos on keeps its checklists. */
const RENAMED: Record<string, Feature> = { todos: "linear" };

const WRITE_DELAY = 700;

/* -------------------------------------------------------------------- look --- */

/**
 * The canvas before any note or folder has said anything about itself. Each is a token
 * rather than a colour: a palette name (`"blue"`), a hex somebody typed, or the empty
 * string for "whatever the app normally does" — which is not the same as any particular
 * colour, and has to survive the app changing its mind about what normal looks like.
 */
export type Look = {
  /** The ground the graph is drawn on — a `CANVASES` key, or "" for the app's own. */
  bg: string;
  /** A note with no tags and no colour of its own. */
  node: string;
  /** A connection nobody has coloured. */
  edge: string;
  /** A folder box's fill, its fence and its name. */
  folder: string;
  /** Whether a folder box is drawn with a line round it at all. */
  fence: boolean;
  /**
   * Whether notes and connections wear their names all the time. Off, the graph is read
   * as shapes and a name is something you go and ask for: the pointer on a note names it,
   * its neighbours and the links between them, and the pointer on a link names that link.
   * A folder box keeps its name either way — a box cannot be hovered (see the `events: no`
   * in the stylesheet), so a nameless one would have no way of ever saying what it is.
   */
  captions: boolean;
};

const LOOK_DEFAULT: Look = { bg: "", node: "", edge: "", folder: "", fence: true, captions: true };

/* ------------------------------------------------------------------ layout --- */

/**
 * How the canvas is sized and moved about. Per vault like the look: a vault of a few
 * dozen notes and a vault of a thousand want their hubs drawn differently, and the
 * question is asked of the vault, not of the app.
 */
export type LayoutPrefs = {
  /** What a note's diameter is read off — see `scoring.ts`. */
  sizing: Sizing;
  /** The smallest and the biggest a note is drawn, in canvas pixels. */
  sizeMin: number;
  sizeMax: number;
  /**
   * What a plain scroll does. "pan" is the trackpad's reading — two fingers move the
   * canvas, a pinch zooms it; "zoom" is the mouse's, where the wheel zooms and the canvas
   * is dragged with the right button held. Right-drag pans in both.
   */
  scroll: "pan" | "zoom";
};

export const LAYOUT_DEFAULT: LayoutPrefs = { sizing: "degree", sizeMin: 20, sizeMax: 68, scroll: "pan" };
/** What a note can be sized between, whatever gets typed. */
export const SIZE_RANGE = { min: 6, max: 200 };

/**
 * Backgrounds are their own palette, and not the notes' one: a hue picked to be told
 * apart at twenty pixels is the last thing you want a whole canvas painted in. These are
 * grounds — near-black with a cast to them, and two pale ones for anybody who reads
 * better on paper. The label ink follows (`inkOn`), so a light ground is legible.
 */
export const CANVASES: Array<{ key: string; name: string; hex: string }> = [
  { key: "ink", name: "Ink", hex: "#0d1117" },
  { key: "black", name: "Black", hex: "#000000" },
  { key: "slate", name: "Slate", hex: "#182029" },
  { key: "plum", name: "Plum", hex: "#221a26" },
  { key: "olive", name: "Olive", hex: "#1b2019" },
  { key: "paper", name: "Paper", hex: "#f3f1ec" },
  { key: "linen", name: "Linen", hex: "#e6e2d8" },
];

/** What the canvas is when nobody has chosen — the app's own `--bg`. */
export const CANVAS_DEFAULT = "#1e1e1e";

const CANVAS_HEX = new Map(CANVASES.map((c) => [c.key, c.hex]));

export const canvasHex = (token: string): string =>
  CANVAS_HEX.get(token) ?? (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(token) ? token : CANVAS_DEFAULT);

/** A hex as three channels, whatever length it was written at. */
function channels(hex: string): [number, number, number] {
  const raw = hex.replace("#", "");
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0) as [number, number, number];
}

/** Rec. 601 luma — good enough to answer "is this light?", the only question asked of it. */
const isLight = (hex: string): boolean => {
  const [r, g, b] = channels(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 > 140;
};

/**
 * A ground lifted `amount` of the way towards the far end of its own range: towards white
 * when it is dark, towards black when it is pale. One function for both, so every shade the
 * app paints keeps the same relationship to the ground whichever way round the theme is.
 */
function lift(ground: string, amount: number): string {
  const light = isLight(ground);
  return (
    "#" +
    channels(ground)
      .map((c) => Math.round(light ? c * (1 - amount) : c + (255 - c) * amount))
      .map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Ink for a ground: the near-white the app writes in, or a near-black when the ground is
 * pale.
 */
export const inkOn = (background: string): string => (isLight(background) ? "#22252a" : "#dcddde");

/**
 * The whole app's palette, worked out from the one colour that was actually chosen.
 *
 * Picking a canvas and leaving the sidebar and the editor behind reads as a bug, not a
 * setting — so the ground IS the theme, and everything the app paints is a lift off it.
 * The amounts are the ratios the hand-written dark theme already used, which is why the
 * default ground still comes out looking exactly like the app always did.
 *
 * What is NOT in here: the accent, and anything that is a thing rather than chrome — a
 * sticky's yellow, an issue card, a tag's hue. Those are the same colour on any ground,
 * because they are not the background wearing a shade.
 */
export function themeOn(ground: string): Record<string, string> {
  const light = isLight(ground);
  return {
    bg: ground,
    "bg-side": lift(ground, 0.031),
    "bg-hover": lift(ground, 0.08),
    line: lift(ground, 0.111),
    // Buttons and the rows under a cursor: the same ladder, further up it.
    btn: lift(ground, 0.08),
    "btn-hover": lift(ground, 0.133),
    "btn-on": lift(ground, 0.173),
    sel: lift(ground, 0.062),
    "sel-strong": lift(ground, 0.102),
    text: inkOn(ground),
    muted: light ? "#6a6f78" : "#8b8d90",
    // For the one thing under the cursor, which has to beat the ordinary text.
    "text-strong": light ? "#101216" : "#ffffff",
  };
}

/** Paints that palette onto the document, where every rule in `style.css` reads it. */
export function applyTheme(ground: string): void {
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(themeOn(ground))) root.setProperty(`--${name}`, value);
}

/* ------------------------------------------------------------------- store --- */

/* ------------------------------------------------------------ integrations --- */

/**
 * What each integration needs to know beyond "on". None of it is a credential: a key or a
 * cookie is the SHELL's business — the OS keychain, the chat window's own session — and
 * deliberately not the vault's, which the commit button snapshots wholesale. What lives
 * here is only ever a choice: which folder, which team, which window.
 */
export type Setup = {
  /**
   * Where a new Claude session runs when the note does not say. Per vault on purpose:
   * "the folder this vault is about" is a different answer in every vault, and answering
   * it once is the difference between a session note and a questionnaire.
   */
  claudeFolder: string;
  /**
   * Where a session runs. "app" hands it to the Claude app over `claude://`. "terminal"
   * hands it to the CLI in your own terminal — which is the lighter of the two, and the
   * only one where the agent is genuinely independent of Bedrock.
   */
  claudeWindow: "app" | "terminal";
  /** Linear's team and project ids, with the names kept alongside so the settings
      window can say where issues go without a round trip to draw one line. */
  linearTeam: string;
  linearTeamName: string;
  linearProject: string;
  linearProjectName: string;
  /** The one Slack channel threads start in — its id, with the name kept alongside for
      the same reason Linear's are. One channel on purpose: a thread note points at a
      thread, and where new ones begin is a property of the vault, not of each note. */
  slackChannel: string;
  slackChannelName: string;
  /** The Google Tasks list new tasks go in — its id, with the name alongside. "" is the
      account's default list ("My Tasks"), which needs no choosing. */
  googleList: string;
  googleListName: string;
  /**
   * Where a new Antigravity session runs when the note does not say — the same question
   * `claudeFolder` answers, asked separately because the two are rarely the same folder:
   * a vault runs its Claude sessions in the repo it is about, and its Antigravity ones
   * wherever that agent is wanted.
   */
  antigravityFolder: string;
  /**
   * The GitHub remote this vault pushes to — an `https://…` or `git@…` URL. A choice, not
   * a credential: it says WHICH repo, and the machine's own git says who you are and holds
   * whatever token or key gets you in. Empty means push has nowhere to go yet, so the git
   * page asks for it before it offers to push.
   */
  gitRemote: string;
  /**
   * Where new Word documents are saved — a folder path, or "" for the default the shell
   * keeps (Documents/word-bedrock). Word needs this question asked because a document,
   * unlike a board or an Apple note, is a file: something has to say where it lives.
   */
  wordFolder: string;
  /**
   * Which Apple Notes folder new notes are made in — a folder name in the default
   * account, or "" for the default the shell keeps (“Bedrock”).
   */
  notesFolder: string;
};

const SETUP_DEFAULT: Setup = {
  claudeFolder: "",
  claudeWindow: "app",
  linearTeam: "",
  linearTeamName: "",
  linearProject: "",
  linearProjectName: "",
  slackChannel: "",
  slackChannelName: "",
  googleList: "",
  googleListName: "",
  antigravityFolder: "",
  gitRemote: "",
  wordFolder: "",
  notesFolder: "",
};

const clampSize = (value: number): number =>
  Math.round(Math.min(SIZE_RANGE.max, Math.max(SIZE_RANGE.min, value)));

export class SettingsStore {
  private vault: Vault | null = null;
  private features: Record<Feature, boolean> = { ...DEFAULTS };
  private looks: Look = { ...LOOK_DEFAULT };
  private setups: Setup = { ...SETUP_DEFAULT };
  private layouts: LayoutPrefs = { ...LAYOUT_DEFAULT };
  private timer: number | undefined;
  private dirty = false;
  /** Fired after any toggle, so the menu and the canvas follow at once. */
  onChange: (() => void) | null = null;
  /** Fired after any appearance change — only the canvas cares. */
  onLook: (() => void) | null = null;
  /** Fired after a sizing or scrolling change — again the canvas's business alone. */
  onLayout: (() => void) | null = null;

  /** Reads this vault's config, after flushing any owed to the previous one. */
  async attach(vault: Vault): Promise<void> {
    await this.flush();
    this.vault = vault;
    this.features = { ...DEFAULTS };
    this.looks = { ...LOOK_DEFAULT };
    this.setups = { ...SETUP_DEFAULT };
    this.layouts = { ...LAYOUT_DEFAULT };
    let raw = "";
    try {
      raw = await vault.read(CONFIG_FILE);
    } catch {
      return; // no config yet — the defaults are the config
    }
    if (!raw.trim()) return;
    try {
      const parsed = JSON.parse(raw) as {
        features?: Record<string, unknown>;
        look?: Record<string, unknown>;
        setup?: Record<string, unknown>;
        layout?: Record<string, unknown>;
        claude?: { folder?: unknown };
      };
      for (const key of Object.keys(DEFAULTS) as Feature[]) {
        const value = parsed.features?.[key];
        if (typeof value === "boolean") this.features[key] = value;
      }
      for (const [was, now] of Object.entries(RENAMED)) {
        const value = parsed.features?.[was];
        if (typeof value === "boolean" && parsed.features?.[now] === undefined) this.features[now] = value;
      }
      for (const key of ["bg", "node", "edge", "folder"] as const) {
        const value = parsed.look?.[key];
        if (typeof value === "string") this.looks[key] = value;
      }
      if (typeof parsed.look?.fence === "boolean") this.looks.fence = parsed.look.fence;
      if (typeof parsed.look?.captions === "boolean") this.looks.captions = parsed.look.captions;
      for (const key of Object.keys(SETUP_DEFAULT) as Array<keyof Setup>) {
        const value = parsed.setup?.[key];
        if (typeof value === "string") this.setups[key] = value as never;
      }
      if (this.setups.claudeWindow !== "terminal") this.setups.claudeWindow = "app";
      const sizing = parsed.layout?.sizing;
      if (SIZINGS.some((row) => row.key === sizing)) this.layouts.sizing = sizing as Sizing;
      for (const key of ["sizeMin", "sizeMax"] as const) {
        const value = parsed.layout?.[key];
        if (typeof value === "number" && Number.isFinite(value)) this.layouts[key] = clampSize(value);
      }
      if (parsed.layout?.scroll === "zoom") this.layouts.scroll = "zoom";
      // Version 2 kept the Claude folder on its own; it is a setup like any other now.
      if (!this.setups.claudeFolder && typeof parsed.claude?.folder === "string") {
        this.setups.claudeFolder = parsed.claude.folder;
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

  look(): Look {
    return { ...this.looks };
  }

  setLook(patch: Partial<Look>): void {
    let changed = false;
    for (const [key, value] of Object.entries(patch) as Array<[keyof Look, never]>) {
      if (this.looks[key] === value) continue;
      this.looks[key] = value;
      changed = true;
    }
    if (!changed) return;
    this.schedule();
    this.onLook?.();
  }

  setup(): Setup {
    return { ...this.setups };
  }

  layout(): LayoutPrefs {
    return { ...this.layouts };
  }

  setLayout(patch: Partial<LayoutPrefs>): void {
    let changed = false;
    for (const [key, value] of Object.entries(patch) as Array<[keyof LayoutPrefs, never]>) {
      const next = key === "sizeMin" || key === "sizeMax" ? (clampSize(value) as never) : value;
      if (this.layouts[key] === next) continue;
      this.layouts[key] = next;
      changed = true;
    }
    if (!changed) return;
    this.schedule();
    this.onLayout?.();
  }

  setSetup(patch: Partial<Setup>): void {
    let changed = false;
    for (const [key, value] of Object.entries(patch) as Array<[keyof Setup, never]>) {
      if (this.setups[key] === value) continue;
      this.setups[key] = value;
      changed = true;
    }
    if (changed) this.schedule();
  }

  /** The vault's default folder for new Antigravity sessions, or null when it has none. */
  antigravityFolder(): string | null {
    return this.setups.antigravityFolder || null;
  }

  /** The vault's default folder for new Claude sessions, or null when it has none. */
  claudeFolder(): string | null {
    return this.setups.claudeFolder || null;
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
        JSON.stringify(
          { version: 3, features: this.features, look: this.looks, setup: this.setups, layout: this.layouts },
          null,
          1,
        ) + "\n",
      );
    } catch {
      /* read-only vault */
    }
  }
}

/* -------------------------------------------------------------------- panel --- */

type Row = { feature: Feature; name: string; what: string };

/**
 * What the app can do on its own. A feature is the canvas growing a new kind of node or a
 * new gesture — nothing outside this machine is involved, so there is nothing to set up:
 * the switch IS the whole configuration.
 */
const FEATURES: Row[] = [
  {
    feature: "files",
    name: "Files and folders",
    what: "file and folder nodes — a click opens the default app or Finder (desktop app)",
  },
  {
    feature: "web",
    name: "Webpages",
    what: "paste an address and the node wears the site's own icon, and opens it",
  },
  {
    feature: "active",
    name: "Note styles",
    what: "right-click a note to give it a sign, a colour and a pulse",
  },
  { feature: "stickies", name: "Stickies", what: "loose text pinned to the canvas" },
];

/**
 * Somebody else's service, reached from a note. These are the rows with a second half:
 * switching one on says you want it, and it still has to be told which account, which
 * folder, which key — see `PanelHooks.detail`.
 */
const INTEGRATIONS: Row[] = [
  { feature: "linear", name: "Linear", what: "issue notes — tick them here, the tick lands in Linear" },
  {
    feature: "claude",
    name: "Claude Code",
    what: "session notes — the node opens a coding session in the Claude app (desktop app)",
  },
  {
    feature: "antigravity",
    name: "Antigravity",
    what: "session notes — the node opens an agent session in your own terminal (desktop app)",
  },
  { feature: "git", name: "GitHub", what: "commit the vault and push it to a GitHub remote, from this page (desktop app)" },
  {
    feature: "freeform",
    name: "Freeform",
    what: "board notes — link Apple's whiteboards and make new ones from here (desktop app, Mac)",
  },
  {
    feature: "notion",
    name: "Notion",
    what: "page notes — link Notion pages and make new ones from here (desktop app)",
  },
  {
    feature: "slack",
    name: "Slack",
    what: "thread notes — start a thread in one channel, or attach one going already; a click opens it in Slack (desktop app)",
  },
  {
    feature: "google",
    name: "Google Tasks",
    what: "task notes — the tasks on your Google Calendar; make one or attach one, and the node wears a tick when it is done (desktop app)",
  },
  {
    feature: "applenotes",
    name: "Apple Notes",
    what: "notes that point at Apple's notes — link them and make new ones from here (desktop app, Mac)",
  },
  {
    feature: "word",
    name: "Word",
    what: "document notes — link Word documents and make new ones from here (desktop app, Mac)",
  },
];

/**
 * One question on an integration's own page: what is being decided, where it currently
 * stands, and how to change it — a button, or a set of answers to pick between. A line
 * with neither is a statement, which is the honest shape for the things this app does
 * not get to decide (whether the Claude app is installed, what git already knows).
 */
export type SetupLine = {
  label: string;
  value: string;
  action?: { id: string; label: string };
  choices?: Array<{ id: string; label: string; on: boolean }>;
};

/**
 * An integration's page, folded away under its switch until somebody opens it. `status`
 * is the one line that shows while it is folded — the answer to "is this working?" — and
 * `ready` is whether that line should read as working or as still needing something.
 */
export type SetupPage = { status: string; ready?: boolean; lines: SetupLine[] };

export type PanelHooks = {
  page?: (feature: Feature) => SetupPage | null;
  onAction?: (feature: Feature, action: string) => void;
  /** The Layout tab's one button: relax the whole graph from where it is. */
  onLayoutAll?: () => void;
};

type Tab = "general" | "layout" | "features" | "integrations";

const TABS: Array<{ key: Tab; name: string }> = [
  { key: "general", name: "General" },
  { key: "layout", name: "Layout" },
  { key: "features", name: "Features" },
  { key: "integrations", name: "Integrations" },
];

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A plain switch — a feature has nothing behind it to configure. */
const switchRow = (row: Row, on: boolean): string =>
  `<label class="setting"><input type="checkbox" data-feature="${row.feature}"${on ? " checked" : ""} />` +
  `<span><b>${row.name}</b><small>${row.what}</small></span></label>`;

/** One question on an integration's page. */
const setupLine = (feature: Feature, line: SetupLine): string =>
  `<div class="setup-line"><span class="setup-label">${line.label}</span>` +
  `<span class="setup-value">${escapeHtml(line.value)}</span>` +
  (line.action
    ? `<button type="button" data-act="${feature}:${line.action.id}">${line.action.label}</button>`
    : "") +
  (line.choices
    ? `<span class="setup-choices">` +
      line.choices
        .map(
          (choice) =>
            `<button type="button" class="style-pick${choice.on ? " on" : ""}"` +
            ` data-act="${feature}:${choice.id}">${choice.label}</button>`,
        )
        .join("") +
      `</span>`
    : "") +
  `</div>`;

/**
 * An integration: its switch, and its own page folded underneath. The header is the whole
 * hit area for folding — except the checkbox, which is a different question and keeps its
 * own click. A page is drawn only while it is open, so a fold costs nothing to keep shut.
 */
const integrationRow = (row: Row, on: boolean, page: SetupPage | null, open: boolean): string =>
  `<div class="setup${open ? " open" : ""}">` +
  `<div class="setup-head" data-fold="${row.feature}">` +
  `<input type="checkbox" data-feature="${row.feature}"${on ? " checked" : ""} />` +
  `<span class="setup-name"><b>${row.name}</b><small>${row.what}</small></span>` +
  (page
    ? `<span class="setup-status${page.ready ? " ready" : ""}">${escapeHtml(page.status)}</span>`
    : "") +
  `<span class="setup-fold">${open ? "⌄" : "›"}</span>` +
  `</div>` +
  (open && page ? `<div class="setup-body">${page.lines.map((l) => setupLine(row.feature, l)).join("")}</div>` : "") +
  `</div>`;

/** A titled row of swatches in the General tab. */
const lookRow = (title: string, note: string, body: string): string =>
  `<div class="settings-look"><h5>${title}</h5><small>${note}</small>${body}</div>`;

/**
 * Wires the ⚙ button to the settings window — a card in the middle of the screen with a
 * tab for each kind of question: what the canvas looks like, what the app does, and who
 * it is plugged into. Esc, the backdrop and the ✕ all close it.
 *
 * Returns a redraw, for when something the window reports about has changed underneath it
 * (a Linear key accepted, a folder chosen) while it is still open.
 */
export function mountSettings(
  button: HTMLElement,
  host: HTMLElement,
  store: SettingsStore,
  hooks: PanelHooks = {},
): () => void {
  let tab: Tab = "general";
  /** Which integration pages are unfolded. One at a time would hide a comparison. */
  const unfolded = new Set<Feature>();

  const general = (): string => {
    const look = store.look();
    return (
      lookRow(
        "Canvas",
        "the ground the graph is drawn on",
        swatchRow("bg", look.bg, { title: "The app's own" }, { options: CANVASES }),
      ) +
      lookRow(
        "Notes",
        "a note with no tags and no colour of its own",
        swatchRow("node", look.node, { title: "The usual red", fill: "#f92411" }),
      ) +
      lookRow(
        "Connections",
        "a link nobody has coloured",
        swatchRow("edge", look.edge, { title: "The usual red", fill: "#f92411" }),
      ) +
      lookRow(
        "Folders",
        "the fill, the fence and the name of a folder box",
        swatchRow("folder", look.folder, { title: "The usual blue", fill: "#4c8dff" }),
      ) +
      `<label class="setting"><input type="checkbox" data-look="fence"${look.fence ? " checked" : ""} />` +
      `<span><b>Fence round folders</b><small>off leaves a patch of coloured ground with a name on it` +
      ` — a folder that styled its own fence still gets one</small></span></label>` +
      `<label class="setting"><input type="checkbox" data-look="captions"${look.captions ? " checked" : ""} />` +
      `<span><b>Names on the canvas</b><small>off reads the graph as shapes: put the pointer on a note` +
      ` to name it, its neighbours and the links between them, or on a link to name that link` +
      ` — folder names stay, a box has no other way to say what it is</small></span></label>`
    );
  };

  /** A row of radio choices in the Layout tab, each with a line saying what it means. */
  const choices = (field: string, picked: string, rows: Array<{ key: string; name: string; what: string }>): string =>
    rows
      .map(
        (row) =>
          `<label class="setting"><input type="radio" name="layout-${field}" data-layout="${field}" value="${row.key}"` +
          `${row.key === picked ? " checked" : ""} /><span><b>${row.name}</b><small>${row.what}</small></span></label>`,
      )
      .join("");

  const layout = (): string => {
    const prefs = store.layout();
    const number = (field: "sizeMin" | "sizeMax", label: string): string =>
      `<label class="settings-num"><span>${label}</span>` +
      `<input type="number" data-layout="${field}" value="${prefs[field]}" min="${SIZE_RANGE.min}" max="${SIZE_RANGE.max}" step="1" /> px</label>`;
    return (
      `<div class="settings-look"><h5>Run the layout</h5>` +
      `<small>nothing on the canvas moves until you ask: this relaxes every note and folder from where it is now` +
      ` — springs on the links, breathing room between neighbours — and a drag round some notes offers the same for` +
      ` just those</small>` +
      `<button type="button" class="settings-run" data-layout-run>Lay out the whole graph</button></div>` +
      `<div class="settings-look"><h5>Note sizes</h5><small>what a note's circle is sized by</small>` +
      choices("sizing", prefs.sizing, SIZINGS) +
      `<div class="settings-nums">${number("sizeMin", "smallest")}${number("sizeMax", "biggest")}</div></div>` +
      `<div class="settings-look"><h5>Scrolling</h5>` +
      `<small>a drag on empty canvas draws a selection; the right button (or Space) held down drags the canvas itself</small>` +
      choices("scroll", prefs.scroll, [
        { key: "pan", name: "Trackpad", what: "two fingers move the canvas, a pinch zooms it" },
        { key: "zoom", name: "Mouse", what: "the wheel zooms; hold the right button to move the canvas" },
      ]) +
      `</div>`
    );
  };

  const features = (): string =>
    FEATURES.map((row) => switchRow(row, store.enabled(row.feature))).join("");

  const integrations = (): string =>
    INTEGRATIONS.map((row) =>
      integrationRow(
        row,
        store.enabled(row.feature),
        hooks.page?.(row.feature) ?? null,
        unfolded.has(row.feature),
      ),
    ).join("");

  const draw = (): void => {
    const body =
      tab === "general" ? general() : tab === "layout" ? layout() : tab === "features" ? features() : integrations();
    host.innerHTML =
      `<div class="settings-card">` +
      `<div class="settings-head"><h3>Settings</h3>` +
      `<button type="button" class="settings-close" title="Close (Esc)">✕</button></div>` +
      `<div class="settings-tabs">` +
      TABS.map(
        (t) =>
          `<button type="button" class="settings-tab${t.key === tab ? " on" : ""}" data-tab="${t.key}">${t.name}</button>`,
      ).join("") +
      `</div>` +
      `<div class="settings-body">${body}</div>` +
      `</div>`;
  };

  const show = (open: boolean): void => {
    if (open) draw(); // the vault (and so the config) may have changed since last time
    host.classList.toggle("open", open);
    button.classList.toggle("on", open);
  };

  host.addEventListener("change", (event) => {
    const box = event.target as HTMLInputElement;
    if (box.dataset.look === "fence") {
      store.setLook({ fence: box.checked });
      return;
    }
    if (box.dataset.look === "captions") {
      store.setLook({ captions: box.checked });
      return;
    }
    const field = box.dataset.layout as keyof LayoutPrefs | undefined;
    if (field === "sizing") {
      store.setLayout({ sizing: box.value as Sizing });
      return;
    }
    if (field === "scroll") {
      store.setLayout({ scroll: box.value === "zoom" ? "zoom" : "pan" });
      return;
    }
    if (field === "sizeMin" || field === "sizeMax") {
      const value = Number(box.value);
      if (Number.isFinite(value)) store.setLayout({ [field]: value });
      box.value = String(store.layout()[field]); // say what was kept, if it had to be clamped
      return;
    }
    const feature = box.dataset.feature as Feature | undefined;
    if (!feature) return;
    store.set(feature, box.checked);
    draw(); // a row switched on may now have something to report
  });

  host.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target === host) {
      show(false); // the backdrop, which is the card's own margin
      return;
    }
    const hit = target.closest<HTMLElement>("button");
    if (!hit) {
      // Not a button: the only other thing worth clicking is an integration's header,
      // which folds its page. The checkbox on it is its own question and keeps its click.
      const fold = target.closest<HTMLElement>("[data-fold]")?.dataset.fold as Feature | undefined;
      if (!fold || (target as HTMLInputElement).type === "checkbox") return;
      if (!unfolded.delete(fold)) unfolded.add(fold);
      draw();
      return;
    }

    if (hit.classList.contains("settings-close")) {
      show(false);
      return;
    }
    if (hit.dataset.layoutRun !== undefined) {
      show(false); // the run is the thing to watch, and the window is over it
      hooks.onLayoutAll?.();
      return;
    }
    const picked = hit.dataset.tab as Tab | undefined;
    if (picked) {
      tab = picked;
      draw();
      return;
    }
    // A swatch: which field it sets is which data- attribute it carries.
    for (const field of ["bg", "node", "edge", "folder"] as const) {
      const value = hit.dataset[field];
      if (value === undefined) continue;
      store.setLook({ [field]: value });
      draw();
      return;
    }
    // A button on an integration's page: "<feature>:<action>". The click must not also
    // reach the header behind it, which would fold the page it was pressed on.
    const act = hit.dataset.act;
    if (!act) return;
    event.stopPropagation();
    const [feature, action] = act.split(":");
    hooks.onAction?.(feature as Feature, action);
  });

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    show(!host.classList.contains("open"));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && host.classList.contains("open")) {
      event.stopPropagation(); // don't also cancel a graph draft behind the window
      show(false);
    }
  });

  // Only worth redrawing while it is on screen; opening it draws anyway.
  return () => {
    if (host.classList.contains("open")) draw();
  };
}
