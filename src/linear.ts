// Linear issues on the canvas.
//
// An issue is a NOTE, so it is a node on the graph like everything else: it can be
// linked to, described, filed into a folder box, and searched. Its face is the Linear
// mark; clicking it opens the checklist in place, over the canvas.
//
// The flow is one-way on purpose. Nothing is ever polled back from Linear — a tick here
// is pushed there, and that is the whole contract. So the markdown file is the truth
// about what you see, and Linear is where that truth is announced. What the app cannot
// derive from the file (Linear's own uuids) rides in `.notes/linear.json`, the same
// trade `stickies.json` makes for geometry: ids are bookkeeping, not writing.

import { parseField, setField } from "./links";
import type { Vault } from "./vault";

/** Where new issues are written. Notes already under `todos/` count as issues too. */
export const ISSUE_DIR = "linear";
const LEGACY_DIR = "todos";

/** Whose notes are issues by virtue of where they live, no `type::` line needed. */
export const isIssuePath = (path: string): boolean =>
  path.startsWith(ISSUE_DIR + "/") || path.startsWith(LEGACY_DIR + "/");

/**
 * The issue folders themselves. They get no box on the graph: `linear/` is where the
 * app keeps issues, not somewhere anybody filed anything, and a box drawn round every
 * issue you own says nothing while covering the notes underneath it.
 */
export const isIssueDir = (path: string): boolean => path === ISSUE_DIR || path === LEGACY_DIR;

/**
 * The four states a tick can be in, named after Linear's own workflow state TYPES —
 * which is what the API groups states by, so a team's custom names ("In review",
 * "Shipped") map onto these without the app knowing any of them.
 */
export type TickState = "unstarted" | "started" | "done" | "canceled";

export const TICK_ORDER: readonly TickState[] = ["unstarted", "started", "done"];

/** A tick's markdown box. `[/]` for started is the spelling Obsidian themes use. */
const BOX: Record<TickState, string> = {
  unstarted: " ",
  started: "/",
  done: "x",
  canceled: "-",
};

const STATE_OF: Record<string, TickState> = {
  " ": "unstarted",
  "/": "started",
  x: "done",
  X: "done",
  "-": "canceled",
};

/** One line of an issue's checklist — a sub-issue in Linear once it has been pushed. */
export type IssueRow = {
  state: TickState;
  title: string;
  /** Linear's own "ENG-215", or null while the row exists only here. */
  identifier: string | null;
  /**
   * The note this line points at, written as an ordinary `[[link]]` at the end of it.
   * It is a real link in a real note, so the arrow on the graph is the graph's own —
   * drawn from the issue's icon to the note, and counted in its backlinks like any
   * other. The card hides the link text; the arrow is its rendering.
   */
  target: string | null;
};

export type IssueDoc = {
  /** The `# Heading`, which is the issue's title — falls back to the note's name. */
  title: string;
  rows: IssueRow[];
  identifier: string | null;
  state: TickState;
  url: string | null;
};

const ROW_RE = /^[ \t]*[-*] \[([ xX/-])\][ \t]*(.*)$/;
/** A row's own field, at the end of its line: `- [ ] Bisect it  linear:: ENG-215`. */
const ROW_FIELD_RE = /[ \t]+linear::[ \t]*([A-Za-z][\w]*-\d+)[ \t]*$/;
/** And the note it points at, just before that: `- [ ] Bisect it [[ideas/Cola]]`. */
const ROW_TARGET_RE = /[ \t]*\[\[([^\][|]+)\]\][ \t]*$/;
const HEADING_RE = /^#[ \t]+(.+?)[ \t]*$/;

const asState = (value: string | null): TickState =>
  value === "started" || value === "done" || value === "canceled" ? value : "unstarted";

/** Reads an issue note. Every `- [ ]` line is a tick; everything else stays prose. */
export function parseIssue(text: string, fallbackTitle: string): IssueDoc {
  const rows: IssueRow[] = [];
  let title = "";
  for (const line of text.split("\n")) {
    const row = ROW_RE.exec(line);
    if (row) {
      // Peeled off the end in the order they are written: the identifier, then the link.
      let body = row[2];
      const field = ROW_FIELD_RE.exec(body);
      if (field) body = body.slice(0, field.index);
      const link = ROW_TARGET_RE.exec(body);
      if (link) body = body.slice(0, link.index);
      rows.push({
        state: STATE_OF[row[1]] ?? "unstarted",
        title: body.trim(),
        identifier: field?.[1] ?? null,
        target: link?.[1].trim() ?? null,
      });
      continue;
    }
    if (!title) {
      const heading = HEADING_RE.exec(line);
      if (heading) title = heading[1];
    }
  }
  return {
    title: title || fallbackTitle,
    rows,
    identifier: parseField(text, "linear"),
    state: asState(parseField(text, "state")),
    url: parseField(text, "url"),
  };
}

const rowLine = (row: IssueRow): string => {
  // Joined rather than concatenated: a line whose words have not been written yet must
  // not come out as `- [ ]  [[Note]]`, with the gap where the title will go.
  const body = [row.title.trim(), row.target ? `[[${row.target}]]` : ""].filter(Boolean).join(" ");
  return `- [${BOX[row.state]}] ${body}` + (row.identifier ? `  linear:: ${row.identifier}` : "");
};

/**
 * Writes a doc back into the note it came from, leaving every other line where it was.
 *
 * A rewrite, not a render: an issue note holds prose, `[[links]]` and whatever else its
 * author put there, and none of that is the app's to reformat. Only the tick lines and
 * the fields are replaced — extra rows go in after the last tick, missing ones are cut.
 */
export function writeIssue(text: string, doc: IssueDoc): string {
  const lines = text.split("\n");
  const at: number[] = [];
  lines.forEach((line, index) => {
    if (ROW_RE.test(line)) at.push(index);
  });

  const kept = Math.min(at.length, doc.rows.length);
  for (let i = 0; i < kept; i++) lines[at[i]] = rowLine(doc.rows[i]);
  if (doc.rows.length > kept) {
    const extra = doc.rows.slice(kept).map(rowLine);
    // After the last tick if there is one; otherwise under the heading, where a
    // checklist belongs — never at the very end, past the fields.
    const after = at.length ? at[at.length - 1] + 1 : headInsertPoint(lines);
    lines.splice(after, 0, ...extra);
  } else if (at.length > kept) {
    for (const index of at.slice(kept).reverse()) lines.splice(index, 1);
  }

  let next = lines.join("\n");
  next = setField(next, "linear", doc.identifier);
  next = setField(next, "state", doc.state === "unstarted" ? null : doc.state);
  next = setField(next, "url", doc.url);
  return next;
}

/** Just past the `# Heading`, or above the fields when the note has no heading. */
function headInsertPoint(lines: string[]): number {
  const heading = lines.findIndex((line) => HEADING_RE.test(line));
  if (heading >= 0) return lines[heading + 1]?.trim() === "" ? heading + 2 : heading + 1;
  const field = lines.findIndex((line) => /^[ \t]*[\w-]+::/.test(line));
  return field >= 0 ? field : lines.length;
}

/**
 * The note a brand-new issue starts as: one empty tick and its type, and no heading —
 * an issue's title is the note's NAME, as it is for every other note in the vault, so
 * renaming the node renames the issue and there is no second copy to fall out of step.
 * A `# Heading` written by hand still wins, for anyone who wants one.
 */
export const issueTemplate = (): string => `- [ ] \n\ntype:: linear\n`;

/* ------------------------------------------------------------------- the seam --- */

/** What the app needs to know to address something in Linear. */
export type Ref = { id: string; identifier: string };

export type Created = { id: string; identifier: string; url: string };

/**
 * Everything the app asks of Linear — three writes and nothing else, because nothing is
 * ever read back. `LocalIssues` answers all of them without a network, so the whole
 * feature works before a key is ever pasted; `LinearApi` is the same three calls against
 * the real GraphQL endpoint. Swapping one for the other is the entire integration.
 */
export interface IssueSource {
  readonly connected: boolean;
  /** Announces a new issue. Null when it could not be created — the note still stands. */
  create(title: string): Promise<Created | null>;
  /** Announces a new checklist row as a sub-issue of `parent`. */
  addRow(parent: Ref, title: string): Promise<Created | null>;
  /** Moves an issue (or a row's sub-issue) into the state a tick means. */
  setState(ref: Ref, state: TickState): Promise<boolean>;
}

/**
 * No Linear at all: the notes are the issues and the ticks are just ticks. This is what
 * runs with the integration on but not connected — and it is a complete feature, not a
 * placeholder, which is why the app never has to care which source it is holding.
 */
export class LocalIssues implements IssueSource {
  readonly connected = false;
  async create(): Promise<Created | null> {
    return null;
  }
  async addRow(): Promise<Created | null> {
    return null;
  }
  async setState(): Promise<boolean> {
    return true; // the file IS the state; there is nowhere else for it to land
  }
}

/**
 * The real thing, over the desktop shell's bridge — the renderer never holds the API
 * key, it asks the shell to make the call and the shell adds the header. A browser tab
 * has no bridge (and no way past Linear's CORS), so there `connected` stays false and
 * the local source above takes over.
 */
export class LinearApi implements IssueSource {
  readonly connected = true;
  /** Team and workflow states, fetched once on the first write that needs them. */
  private team: Promise<{ id: string; states: Map<TickState, string> } | null> | null = null;

  constructor(private call: (query: string, variables?: unknown) => Promise<unknown>) {}

  async create(title: string): Promise<Created | null> {
    const team = await this.resolveTeam();
    if (!team) return null;
    return this.issueCreate({ title, teamId: team.id });
  }

  async addRow(parent: Ref, title: string): Promise<Created | null> {
    const team = await this.resolveTeam();
    if (!team || !parent.id) return null;
    return this.issueCreate({ title, teamId: team.id, parentId: parent.id });
  }

  async setState(ref: Ref, state: TickState): Promise<boolean> {
    const team = await this.resolveTeam();
    const stateId = team?.states.get(state);
    if (!team || !stateId || !ref.id) return false;
    const data = await this.send<{ issueUpdate?: { success?: boolean } }>(
      `mutation($id:String!,$state:String!){issueUpdate(id:$id,input:{stateId:$state}){success}}`,
      { id: ref.id, state: stateId },
    );
    return data?.issueUpdate?.success === true;
  }

  private async issueCreate(input: Record<string, string>): Promise<Created | null> {
    const data = await this.send<{
      issueCreate?: { success?: boolean; issue?: Created };
    }>(
      `mutation($input:IssueCreateInput!){issueCreate(input:$input){success issue{id identifier url}}}`,
      { input },
    );
    const issue = data?.issueCreate?.issue;
    return data?.issueCreate?.success && issue ? issue : null;
  }

  /**
   * The one read in the whole integration: which team to file under, and which of its
   * workflow states each tick means. Cached for the session — states change about as
   * often as a team renames its columns, and a restart re-reads them anyway.
   */
  private resolveTeam(): Promise<{ id: string; states: Map<TickState, string> } | null> {
    this.team ??= this.fetchTeam();
    return this.team;
  }

  private async fetchTeam(): Promise<{ id: string; states: Map<TickState, string> } | null> {
    const data = await this.send<{
      teams?: { nodes?: Array<{ id: string; states?: { nodes?: Array<{ id: string; type: string }> } }> };
    }>(`query{teams(first:1){nodes{id states{nodes{id type}}}}}`);
    const team = data?.teams?.nodes?.[0];
    if (!team) return null;
    const states = new Map<TickState, string>();
    for (const state of team.states?.nodes ?? []) {
      // Linear's own state types. `backlog` stands in for unstarted when a team has
      // no "Todo" column, so the first tick always has somewhere to go.
      if (state.type === "unstarted") states.set("unstarted", state.id);
      else if (state.type === "backlog" && !states.has("unstarted")) states.set("unstarted", state.id);
      else if (state.type === "started" && !states.has("started")) states.set("started", state.id);
      else if (state.type === "completed" && !states.has("done")) states.set("done", state.id);
      else if (state.type === "canceled" && !states.has("canceled")) states.set("canceled", state.id);
    }
    return { id: team.id, states };
  }

  private async send<T>(query: string, variables?: unknown): Promise<T | null> {
    try {
      return (await this.call(query, variables)) as T;
    } catch {
      return null; // the note is already written; a failed push is reported, not fatal
    }
  }
}

/* ------------------------------------------------------------------ the uuids --- */

const IDS_FILE = ".notes/linear.json";
const WRITE_DELAY = 700;

/**
 * Linear addresses issues by uuid, and a uuid in a note would be noise nobody reads.
 * So the notes carry the human name (`linear:: ENG-214`) and the uuids live here,
 * keyed by it — the same split the layout cache makes: what you wrote in one place,
 * what the app needs to do its job in another.
 */
export class IdStore {
  private vault: Vault | null = null;
  private ids = new Map<string, string>();
  private timer: number | undefined;
  private dirty = false;

  async attach(vault: Vault): Promise<void> {
    await this.flush();
    this.vault = vault;
    this.ids.clear();
    let raw = "";
    try {
      raw = await vault.read(IDS_FILE);
    } catch {
      return; // no issues pushed from this vault yet
    }
    if (!raw.trim()) return;
    try {
      const parsed = JSON.parse(raw) as { ids?: Record<string, unknown> };
      for (const [identifier, id] of Object.entries(parsed.ids ?? {})) {
        if (typeof id === "string" && id) this.ids.set(identifier, id);
      }
    } catch {
      // A corrupt cache costs the pushes on issues made before it broke, nothing else.
    }
  }

  /** The uuid for an identifier, ready to address Linear with. */
  ref(identifier: string | null): Ref | null {
    if (!identifier) return null;
    const id = this.ids.get(identifier);
    return id ? { id, identifier } : null;
  }

  remember(created: Created): void {
    if (this.ids.get(created.identifier) === created.id) return;
    this.ids.set(created.identifier, created.id);
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
        IDS_FILE,
        JSON.stringify({ version: 1, ids: Object.fromEntries(this.ids) }, null, 1) + "\n",
      );
    } catch {
      /* read-only vault */
    }
  }
}
