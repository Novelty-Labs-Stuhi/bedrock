// The File System Access API bits TypeScript's DOM lib still omits.

interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

interface Window {
  showDirectoryPicker(options?: { mode?: "read" | "readwrite"; id?: string }): Promise<FileSystemDirectoryHandle>;
  /** The desktop shell's bridge (electron/preload.cjs); absent in a plain browser. */
  bedrock?: {
    gitCommit(root: string): Promise<string>;
    /** Point `origin` at `remote` (add or repoint) and push HEAD upstream. Auth is the
        machine's own git's; resolves with what was pushed, or rejects with git's message. */
    gitPush(root: string, remote: string): Promise<string>;
    /** Fetch and rebase onto the remote. Refuses on uncommitted work and aborts rather
        than leaving a half-rebased vault, so the worst case is that nothing happened. */
    gitPull(root: string, remote: string): Promise<string>;
    /** Everything the settings page reports about the vault's repository, read off git
        itself. Answers rather than throws for "not a repository yet" and "no git here". */
    gitStatus(root: string): Promise<GitStatus>;
    /** The OS's own picker; a folder pick can create the folder right in the dialog.
        Null when the dialog was dismissed. */
    pickPath(kind: "file" | "folder"): Promise<string | null>;
    /** Opens a path the OS way — default app for a file, Finder/Explorer for a folder.
        Resolves "opened", "missing", or whatever the OS said went wrong. */
    openPath(target: string): Promise<string>;
    /** Opens a chat in a watched window; resolves with the conversation's URL once
        Google mints one, or null if the window closes first. */
    geminiChat(url: string): Promise<string | null>;
    /** Whether the chat window's own Google session is signed in — read off the cookie
        jar, since Google offers nothing else to ask. */
    geminiStatus(): Promise<{ signedIn: boolean }>;
    /** Opens a window whose only job is Google's sign-in, and closes it the moment the
        login takes. Resolves with where that left things. */
    geminiSignIn(): Promise<{ signedIn: boolean }>;
    /** Clears that session. Notes keep their conversation links. */
    geminiForget(): Promise<boolean>;
    /** What a webpage says about itself: its `<title>`, and the biggest icon it offers as a
        data URI (both empty strings when the site gives nothing). Answers are cached in the
        app's own folder, so the same address costs one scrape, not one per launch. */
    webPage(url: string): Promise<{ url: string; title: string; icon: string }>;
    /** The folder Claude Code last worked in, or null if it has never run here. */
    claudeFolder(): Promise<string | null>;
    /** The folders Claude Code has worked in lately, most recent first. */
    claudeFolders(limit?: number): Promise<string[]>;
    /** The sessions on this machine, most recently touched first — what a note can be
        plugged into. `at` is when the session was last written to. */
    claudeSessions(
      limit?: number,
    ): Promise<Array<{ id: string; folder: string; title: string; at: number }>>;
    /** Opens a new Claude Code session in the Claude app, scoped to `folder`, with an empty
        composer — nothing is sent on the note's behalf. Resolves with the session's id once
        the first message is sent, or null if none ever is. */
    claudeStart(folder: string): Promise<string | null>;
    /** Opens THE session in the Claude app — its own view, live or dormant ("opened"). A
        session the app has never seen (born in a terminal) is brought in through the app's
        import door instead ("imported"), which happens at most once: from then on it has a
        view of its own. */
    claudeOpen(session: string): Promise<"opened" | "imported">;
    /** The session started in `folder` since `since` (an ISO stamp), found on disk — how a
        note catches up with its session when the live watch was interrupted. `id` is set only
        when there is exactly one candidate; more than one and it will not guess, so they are
        handed back in `candidates` for somebody who knows to choose between. */
    claudeAdopt(folder: string, since: string): Promise<{ id: string | null; candidates: string[] }>;
    /** What each session is doing, read off its transcript: `running` while Claude has the
        floor, `waiting` on an unanswered question or permission prompt, `done` when the
        turn is over, `idle` for one that was interrupted. `at` is its last turn; `focus`
        is when the Claude app last had the session on its own screen (0 if never) — how
        a turn read in the app, rather than through the graph, still counts as read. */
    claudeStatus(
      sessions: string[],
    ): Promise<
      Record<string, { state: "running" | "waiting" | "done" | "idle"; at: number; focus: number }>
    >;
    /** Proves an API key against Linear and keeps it in the OS keychain. Rejects
        with what Linear said if the key is no good. */
    linearConnect(key: string): Promise<{ user: string }>;
    linearStatus(): Promise<{ connected: boolean; user: string }>;
    linearForget(): Promise<boolean>;
    /** One GraphQL call, with the stored key added by the shell. */
    linearCall(query: string, variables?: unknown): Promise<unknown>;

    /** Whether sessions can be run in a terminal here: where tmux is (null when it is not
        installed), and how it could be got. The whole mode is gated on this. */
    termStatus(): Promise<{ tmux: string | null; installer: "brew" | null; platform: string }>;
    /** `brew install tmux`. Rejects with what brew said. */
    termInstall(): Promise<{ tmux: string }>;
    /** Starts a session under tmux, with an id minted up front. Resolves with that id —
        no watching, no guessing: the note has its session's name immediately. Pass a
        previous id to resume it instead, which keeps that id rather than branching. */
    claudeCliStart(folder: string, resume?: string | null): Promise<string>;
    /** Whether that tmux session is still running. */
    claudeCliAlive(session: string): Promise<boolean>;
    /** Which account the CLI runs as — identity only, never a token, and never a guess at
        what that account may spend. The CLI and the Claude app keep separate logins, so
        which one is which is worth saying out loud. */
    claudeAccount(): Promise<{ email: string; org: string; seat: string }>;
    /** Ends it for good — what closing its window deliberately does not do. */
    claudeCliKill(session: string): Promise<boolean>;
    /** Opens (or raises) the window that draws it. */
    claudeCliWindow(options: { id: string; title?: string }): Promise<boolean>;

    /* Used only by the terminal window itself. */
    termAttach(options: { id: string; cols: number; rows: number }): Promise<boolean>;
    termInput(data: string): void;
    termResize(cols: number, rows: number): void;
    onTermData(fn: (data: string) => void): void;
    onTermEnded(fn: () => void): void;
  };
}

/** The vault's repository as git describes it. `repo` is false both when the folder has
    never been initialised and when it merely sits inside somebody else's checkout. */
type GitStatus = {
  /** False only when there is no git on this machine at all. */
  installed: boolean;
  repo: boolean;
  /** Null on a repository with no commits yet, or a detached HEAD. */
  branch: string | null;
  /** Files added, changed or untracked since the last commit. */
  changes: number;
  lastCommit: string | null;
  /** What `origin` actually points at, which may not be what the config says. */
  origin: string | null;
  /** `Name <email>`, or null when git has no identity here and a commit would be refused. */
  identity: string | null;
  /** Whether the branch tracks anything — the counts mean nothing until it does. */
  upstream: boolean;
  ahead: number;
  behind: number;
};
