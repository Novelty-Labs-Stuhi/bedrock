// What this vault is set up to be: how the canvas looks, which features are switched on,
// and which outside services it is plugged into.
//
// All of it is kept in `.notes/config.json`, beside the layout cache and the stickies:
// a preference is a property of the vault, so it travels with the folder rather than
// living in the app. Since the Bedrock folder came, the folder has a config of its own
// too, and a vault's holds only what it answers differently — see the layers below. The
// one thing NOT kept here is a credential — Linear's API key is the shell's business
// (the OS keychain), deliberately not the vault's, because the commit button snapshots
// the vault wholesale.

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
  | "granola"
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
  granola: false,
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
  /**
   * Whether notes and connections wear their names all the time. Off, the graph is read
   * as shapes and a name is something you go and ask for: the pointer on a note names it,
   * its neighbours and the links between them, and the pointer on a link names that link.
   */
  captions: boolean;
};

const LOOK_DEFAULT: Look = { bg: "", node: "", edge: "", captions: true };

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
   * The layout run's two dials, in canvas pixels — see `colaOptions` in graph.ts. How long
   * a link wants to be, centre to centre; and how much clear ground every note keeps round
   * itself, label included. Between them: how tight a cluster knots, and how far apart
   * everything sits.
   */
  edgeLength: number;
  nodeSpacing: number;
  /**
   * What a plain scroll does. "pan" is the trackpad's reading — two fingers move the
   * canvas, a pinch zooms it; "zoom" is the mouse's, where the wheel zooms and the canvas
   * is dragged with the right button held. Right-drag pans in both.
   */
  scroll: "pan" | "zoom";
};

export const LAYOUT_DEFAULT: LayoutPrefs = {
  sizing: "degree",
  sizeMin: 20,
  sizeMax: 68,
  edgeLength: 140,
  nodeSpacing: 14,
  scroll: "pan",
};
/** What the two layout dials run between. */
export const EDGE_LENGTH_RANGE = { min: 40, max: 400 };
export const NODE_SPACING_RANGE = { min: 0, max: 80 };
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

const clampDial = (key: "edgeLength" | "nodeSpacing", value: number): number => {
  const range = key === "edgeLength" ? EDGE_LENGTH_RANGE : NODE_SPACING_RANGE;
  return Math.round(Math.min(range.max, Math.max(range.min, value)));
};

/* ------------------------------------------------------------------- layers --- */

/**
 * The preferences that are answered in two places. The Bedrock folder's own
 * `.notes/config.json` is what every vault starts from; a vault's config holds only the
 * answers it gave differently, and falls through to the folder's for the rest. So a look
 * chosen for all vaults reaches every vault that never said otherwise, and a vault that
 * did keeps its answer whatever the folder says later. A config written before there
 * were layers answers every key, which pins the vault to exactly how it was — as it must.
 *
 * Setup is not layered: which Slack channel, which git remote, which Linear team are a
 * vault's connections, not a preference it could inherit.
 */
type Prefs = {
  features: Partial<Record<Feature, boolean>>;
  look: Partial<Look>;
  layout: Partial<LayoutPrefs>;
};

/** Which layer the settings window is writing to: every vault's answers, or this one's. */
export type Scope = "root" | "vault";

const emptyPrefs = (): Prefs => ({ features: {}, look: {}, layout: {} });

/** The keys a config file actually answers, and nothing for the ones it leaves out. */
function parsePrefs(parsed: {
  features?: Record<string, unknown>;
  look?: Record<string, unknown>;
  layout?: Record<string, unknown>;
}): Prefs {
  const prefs = emptyPrefs();
  for (const key of Object.keys(DEFAULTS) as Feature[]) {
    const value = parsed.features?.[key];
    if (typeof value === "boolean") prefs.features[key] = value;
  }
  for (const [was, now] of Object.entries(RENAMED)) {
    const value = parsed.features?.[was];
    if (typeof value === "boolean" && prefs.features[now] === undefined) prefs.features[now] = value;
  }
  for (const key of ["bg", "node", "edge"] as const) {
    const value = parsed.look?.[key];
    if (typeof value === "string") prefs.look[key] = value;
  }
  if (typeof parsed.look?.captions === "boolean") prefs.look.captions = parsed.look.captions;
  const sizing = parsed.layout?.sizing;
  if (SIZINGS.some((row) => row.key === sizing)) prefs.layout.sizing = sizing as Sizing;
  for (const key of ["sizeMin", "sizeMax"] as const) {
    const value = parsed.layout?.[key];
    if (typeof value === "number" && Number.isFinite(value)) prefs.layout[key] = clampSize(value);
  }
  for (const key of ["edgeLength", "nodeSpacing"] as const) {
    const value = parsed.layout?.[key];
    if (typeof value === "number" && Number.isFinite(value)) prefs.layout[key] = clampDial(key, value);
  }
  const scroll = parsed.layout?.scroll;
  if (scroll === "zoom" || scroll === "pan") prefs.layout.scroll = scroll;
  return prefs;
}

/** A config file's text, parsed if it can be; null for none, empty or broken. */
async function readConfig(vault: Vault): Promise<Record<string, unknown> | null> {
  let raw = "";
  try {
    raw = await vault.read(CONFIG_FILE);
  } catch {
    return null; // no config yet — the defaults are the config
  }
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null; // a corrupt config is a cosmetic loss; the defaults keep the vault usable
  }
}

type Resolved = { features: Record<Feature, boolean>; look: Look; layout: LayoutPrefs };

export class SettingsStore {
  private vault: Vault | null = null;
  /** The Bedrock folder, when the shell knows it and this vault is not it. */
  private rootVault: Vault | null = null;
  /** What the Bedrock folder's config answers. Empty in a browser tab, which has no folder. */
  private root: Prefs = emptyPrefs();
  /** What this vault answers differently. Every key, for a vault configured before layers. */
  private over: Prefs = emptyPrefs();
  /** This vault's connections — never inherited. */
  private setups: Setup = { ...SETUP_DEFAULT };
  private writeScope: Scope = "vault";
  private timer: number | undefined;
  private dirtyRoot = false;
  private dirtyVault = false;
  /** Fired after any toggle, so the menu and the canvas follow at once. */
  onChange: (() => void) | null = null;
  /** Fired after any appearance change — only the canvas cares. */
  onLook: (() => void) | null = null;
  /** Fired after a sizing or scrolling change — again the canvas's business alone. */
  onLayout: (() => void) | null = null;

  /**
   * Reads this vault's config over the Bedrock folder's, after flushing any owed to the
   * previous pair. `root` is the folder as a vault, or null when there is none to read
   * (a browser tab) or this vault IS the folder.
   */
  async attach(vault: Vault, root: Vault | null = null): Promise<void> {
    await this.flush();
    this.vault = vault;
    this.rootVault = root;
    this.root = emptyPrefs();
    this.over = emptyPrefs();
    this.setups = { ...SETUP_DEFAULT };
    this.writeScope = "vault";
    if (root) {
      const parsed = await readConfig(root);
      if (parsed) this.root = parsePrefs(parsed as never);
    }
    const parsed = await readConfig(vault);
    if (!parsed) return;
    this.over = parsePrefs(parsed as never);
    const setup = (parsed.setup ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(SETUP_DEFAULT) as Array<keyof Setup>) {
      const value = setup[key];
      if (typeof value === "string") this.setups[key] = value as never;
    }
    if (this.setups.claudeWindow !== "terminal") this.setups.claudeWindow = "app";
    // Version 2 kept the Claude folder on its own; it is a setup like any other now.
    const claude = parsed.claude as { folder?: unknown } | undefined;
    if (!this.setups.claudeFolder && typeof claude?.folder === "string") this.setups.claudeFolder = claude.folder;
    // An answer the same as the folder's is not a different answer. Dropped, so the list of
    // what this vault does its own way says something, and the folder's later changes reach
    // it here — the vault looks exactly the same either way today.
    if (root) this.trimOverrides();
  }

  private trimOverrides(): void {
    const base = this.resolve("root");
    for (const key of Object.keys(this.over.features) as Feature[]) {
      if (this.over.features[key] === base.features[key]) delete this.over.features[key];
    }
    for (const key of Object.keys(this.over.look) as Array<keyof Look>) {
      if (this.over.look[key] === base.look[key]) delete this.over.look[key];
    }
    for (const key of Object.keys(this.over.layout) as Array<keyof LayoutPrefs>) {
      if (this.over.layout[key] === base.layout[key]) delete this.over.layout[key];
    }
  }

  /** The answers as they stand at a layer: the defaults, the folder's, then (for the vault) this vault's. */
  private resolve(scope: Scope): Resolved {
    const layers = scope === "root" ? [this.root] : [this.root, this.over];
    const out: Resolved = { features: { ...DEFAULTS }, look: { ...LOOK_DEFAULT }, layout: { ...LAYOUT_DEFAULT } };
    for (const layer of layers) {
      Object.assign(out.features, layer.features);
      Object.assign(out.look, layer.look);
      Object.assign(out.layout, layer.layout);
    }
    return out;
  }

  /** Whether there is a Bedrock folder under this vault to answer for it. */
  layered(): boolean {
    return this.rootVault !== null;
  }

  scope(): Scope {
    return this.layered() ? this.writeScope : "vault";
  }

  setScope(scope: Scope): void {
    this.writeScope = scope;
  }

  /** The answers the settings window should show: the layer it is writing to, resolved. */
  shown(): Resolved {
    return this.resolve(this.scope());
  }

  /** The keys this vault answers its own way — feature ids, look keys, layout keys. */
  overrides(): string[] {
    return [...Object.keys(this.over.features), ...Object.keys(this.over.look), ...Object.keys(this.over.layout)];
  }

  /** This vault goes back to the folder's answers for everything. Its connections stay. */
  dropOverrides(): void {
    if (this.overrides().length === 0) return;
    this.over = emptyPrefs();
    this.schedule("vault");
    this.onChange?.();
    this.onLook?.();
    this.onLayout?.();
  }

  enabled(feature: Feature): boolean {
    return this.resolve("vault").features[feature];
  }

  look(): Look {
    return this.resolve("vault").look;
  }

  layout(): LayoutPrefs {
    return this.resolve("vault").layout;
  }

  setup(): Setup {
    return { ...this.setups };
  }

  /**
   * Writes one answer into the layer the window is on. Written to the vault, an answer
   * that matches the folder's is no override at all, and is dropped rather than pinned:
   * flipping a switch back leaves the vault following the folder again.
   */
  private write<K extends keyof Prefs>(kind: K, key: keyof Prefs[K], value: Prefs[K][keyof Prefs[K]]): boolean {
    const scope = this.scope();
    const layer = (scope === "root" ? this.root : this.over)[kind] as Record<string, unknown>;
    const before = this.resolve(scope)[kind] as Record<string, unknown>;
    if (before[key as string] === value) return false;
    if (scope === "vault" && (this.resolve("root")[kind] as Record<string, unknown>)[key as string] === value) {
      delete layer[key as string];
    } else {
      layer[key as string] = value;
    }
    this.schedule(scope);
    return true;
  }

  set(feature: Feature, on: boolean): void {
    if (this.write("features", feature, on)) this.onChange?.();
  }

  setLook(patch: Partial<Look>): void {
    let changed = false;
    for (const [key, value] of Object.entries(patch) as Array<[keyof Look, never]>) {
      if (this.write("look", key, value)) changed = true;
    }
    if (changed) this.onLook?.();
  }

  setLayout(patch: Partial<LayoutPrefs>): void {
    let changed = false;
    for (const [key, value] of Object.entries(patch) as Array<[keyof LayoutPrefs, never]>) {
      const next =
        key === "sizeMin" || key === "sizeMax"
          ? (clampSize(value) as never)
          : key === "edgeLength" || key === "nodeSpacing"
            ? (clampDial(key, value) as never)
            : value;
      if (this.write("layout", key, next)) changed = true;
    }
    if (changed) this.onLayout?.();
  }

  setSetup(patch: Partial<Setup>): void {
    let changed = false;
    for (const [key, value] of Object.entries(patch) as Array<[keyof Setup, never]>) {
      if (this.setups[key] === value) continue;
      this.setups[key] = value;
      changed = true;
    }
    if (changed) this.schedule("vault");
  }

  /** The vault's default folder for new Antigravity sessions, or null when it has none. */
  antigravityFolder(): string | null {
    return this.setups.antigravityFolder || null;
  }

  /** The vault's default folder for new Claude sessions, or null when it has none. */
  claudeFolder(): string | null {
    return this.setups.claudeFolder || null;
  }

  private schedule(scope: Scope): void {
    if (scope === "root") this.dirtyRoot = true;
    else this.dirtyVault = true;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), WRITE_DELAY);
  }

  /**
   * This vault's config file as it would be written now: what it answers its own way, and
   * its connections. What a vault made inside this one starts from — it inherits the
   * folder's answers the same way, so only the differences need copying.
   */
  snapshot(): string {
    return (
      JSON.stringify(
        { version: 4, features: this.over.features, look: this.over.look, layout: this.over.layout, setup: this.setups },
        null,
        1,
      ) + "\n"
    );
  }

  /** The Bedrock folder's config file as it would be written now. */
  private rootSnapshot(): string {
    return (
      JSON.stringify({ version: 4, features: this.root.features, look: this.root.look, layout: this.root.layout }, null, 1) +
      "\n"
    );
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.dirtyVault && this.vault) {
      this.dirtyVault = false;
      await writeConfig(this.vault, this.snapshot());
    }
    if (this.dirtyRoot && this.rootVault) {
      this.dirtyRoot = false;
      await writeConfig(this.rootVault, this.rootSnapshot());
    }
  }
}

/** Writes the config, making `.notes` first if it is missing — the Bedrock folder may have none yet. */
async function writeConfig(vault: Vault, text: string): Promise<void> {
  try {
    await vault.write(CONFIG_FILE, text);
  } catch {
    try {
      await vault.createDir(CONFIG_FILE.slice(0, CONFIG_FILE.lastIndexOf("/")));
      await vault.write(CONFIG_FILE, text);
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
    feature: "granola",
    name: "Granola",
    what: "meeting notes — attach a meeting Granola took notes of; the notes come along, and a click opens it in Granola (desktop app)",
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
  /** The Bedrock folder as the shell knows it — null in a browser tab, which has none. */
  base?: () => string | null;
  /** The General tab's "Choose…" beside it: pick another folder. */
  onBasePick?: () => void;
  /** What this build calls itself — null in a browser tab, which has no build. */
  version?: () => string | null;
  /** The General tab's "Check for updates…": ask the bucket now, answer in a dialog. */
  onUpdateCheck?: () => void;
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
    const look = store.shown().look;
    const base = hooks.base?.() ?? null;
    const version = hooks.version?.() ?? null;
    return (
      (version
        ? lookRow(
            "Version",
            "newer builds download on their own and install when Bedrock restarts; a plaque in the corner says when one is waiting",
            `<div class="setup-line"><span class="setup-value">Bedrock ${escapeHtml(version)}</span>` +
              `<button type="button" data-update-check>Check for updates…</button></div>`,
          )
        : "") +
      (base
        ? lookRow(
            "Bedrock folder",
            "where vaults live: new vaults are made in it, the folder sheet opens in it, and a search across vaults reaches everything under it — references between vaults are written relative to it, so the whole folder can move",
            `<div class="setup-line"><span class="setup-value">${escapeHtml(base)}</span>` +
              `<button type="button" data-base-pick>Choose…</button></div>`,
          )
        : "") +
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
      `<label class="setting"><input type="checkbox" data-look="captions"${look.captions ? " checked" : ""} />` +
      `<span><b>Names on the canvas</b><small>off reads the graph as shapes: put the pointer on a note` +
      ` to name it, its neighbours and the links between them, or on a link to name that link</small></span></label>`
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
    const prefs = store.shown().layout;
    /** A slider with its value beside it; the next run reads it, nothing moves on its own. */
    const dial = (field: "edgeLength" | "nodeSpacing", label: string, what: string, range: { min: number; max: number }): string =>
      `<label class="settings-dial"><span class="settings-dial-head"><b>${label}</b>` +
      `<output data-dial-out="${field}">${prefs[field]}</output> px</span>` +
      `<input type="range" data-layout="${field}" value="${prefs[field]}" min="${range.min}" max="${range.max}" step="1" />` +
      `<small>${what}</small></label>`;
    const number = (field: "sizeMin" | "sizeMax", label: string): string =>
      `<label class="settings-num"><span>${label}</span>` +
      `<input type="number" data-layout="${field}" value="${prefs[field]}" min="${SIZE_RANGE.min}" max="${SIZE_RANGE.max}" step="1" /> px</label>`;
    return (
      `<div class="settings-look"><h5>The layout</h5>` +
      `<small>nothing that has a place ever moves on its own. A drag round some notes lays out just those (cola —` +
      ` linked notes at the Pull distance, every note keeping the Spread clear round its label) with the rest held` +
      ` still, and a note that arrives without a place settles among its links the same way</small>` +
      dial("edgeLength", "Pull", "how long a link wants to be — shorter knots a cluster tighter", EDGE_LENGTH_RANGE) +
      dial("nodeSpacing", "Spread", "clear ground round every note — more pushes everything apart", NODE_SPACING_RANGE) +
      `</div>` +
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

  const features = (): string => {
    const on = store.shown().features;
    return FEATURES.map((row) => switchRow(row, on[row.feature])).join("");
  };

  const integrations = (): string => {
    const on = store.shown().features;
    // An integration's page is this vault's connection to it. Every vault's answers can
    // say the integration is on; which channel, which team, is not theirs to say.
    const atRoot = store.scope() === "root";
    return INTEGRATIONS.map((row) =>
      integrationRow(row, on[row.feature], atRoot ? null : (hooks.page?.(row.feature) ?? null), unfolded.has(row.feature)),
    ).join("");
  };

  /** What an override key is called on screen, so the list of them reads as the rows do. */
  const overrideName = (key: string): string =>
    [...FEATURES, ...INTEGRATIONS].find((row) => row.feature === key)?.name ??
    ({
      bg: "Canvas",
      node: "Notes",
      edge: "Connections",
      captions: "Names on the canvas",
      sizing: "Note sizes",
      sizeMin: "smallest",
      sizeMax: "biggest",
      edgeLength: "Pull",
      nodeSpacing: "Spread",
      scroll: "Scrolling",
    }[key] ?? key);

  /**
   * Which layer the window writes to, and what that means here. Only when there is a
   * Bedrock folder to answer for every vault — a browser tab has one vault and one file.
   */
  const scopeStrip = (): string => {
    if (!store.layered()) return "";
    const scope = store.scope();
    const pill = (key: Scope, name: string): string =>
      `<button type="button" class="settings-scope-pill${scope === key ? " on" : ""}" data-scope="${key}">${name}</button>`;
    const overrides = store.overrides();
    const word =
      scope === "root"
        ? "what every vault starts from — a vault that answered differently keeps its answer"
        : overrides.length === 0
          ? "this vault follows the answers for every vault; change one here and only this vault changes"
          : `this vault answers its own way for ${overrides.map(overrideName).map(escapeHtml).join(", ")}`;
    return (
      `<div class="settings-scope"><span class="settings-scope-pills">${pill("root", "All vaults")}${pill("vault", "This vault")}</span>` +
      `<small>${word}</small>` +
      (scope === "vault" && overrides.length > 0
        ? `<button type="button" class="settings-scope-drop" data-drop-overrides title="Back to the answers for every vault">Drop</button>`
        : "") +
      `</div>`
    );
  };

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
      scopeStrip() +
      `<div class="settings-body">${body}</div>` +
      `</div>`;
  };

  const show = (open: boolean): void => {
    if (open) draw(); // the vault (and so the config) may have changed since last time
    host.classList.toggle("open", open);
    button.classList.toggle("on", open);
  };

  host.addEventListener("input", (event) => {
    const box = event.target as HTMLInputElement;
    const field = box.dataset.layout;
    if (box.type !== "range" || !field) return;
    const out = host.querySelector<HTMLOutputElement>(`[data-dial-out="${field}"]`);
    if (out) out.textContent = box.value;
  });

  host.addEventListener("change", (event) => {
    const box = event.target as HTMLInputElement;
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
    if (field === "sizeMin" || field === "sizeMax" || field === "edgeLength" || field === "nodeSpacing") {
      const value = Number(box.value);
      if (Number.isFinite(value)) store.setLayout({ [field]: value });
      box.value = String(store.shown().layout[field]); // say what was kept, if it had to be clamped
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
    if (hit.dataset.basePick !== undefined) {
      hooks.onBasePick?.(); // redraws the window itself once the folder is chosen
      return;
    }
    if (hit.dataset.updateCheck !== undefined) {
      hooks.onUpdateCheck?.(); // the shell answers in a dialog of its own
      return;
    }
    const scope = hit.dataset.scope as Scope | undefined;
    if (scope) {
      store.setScope(scope);
      draw();
      return;
    }
    if (hit.dataset.dropOverrides !== undefined) {
      store.dropOverrides();
      draw();
      return;
    }
    const picked = hit.dataset.tab as Tab | undefined;
    if (picked) {
      tab = picked;
      draw();
      return;
    }
    // A swatch: which field it sets is which data- attribute it carries.
    for (const field of ["bg", "node", "edge"] as const) {
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
