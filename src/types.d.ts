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
    /** Opens a chat in a watched window; resolves with the conversation's URL once
        Google mints one, or null if the window closes first. */
    geminiChat(url: string): Promise<string | null>;
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
        turn is over, `idle` for one that was interrupted. `at` is its last turn. */
    claudeStatus(
      sessions: string[],
    ): Promise<Record<string, { state: "running" | "waiting" | "done" | "idle"; at: number }>>;
    /** Proves an API key against Linear and keeps it in the OS keychain. Rejects
        with what Linear said if the key is no good. */
    linearConnect(key: string): Promise<{ user: string }>;
    linearStatus(): Promise<{ connected: boolean; user: string }>;
    linearForget(): Promise<boolean>;
    /** One GraphQL call, with the stored key added by the shell. */
    linearCall(query: string, variables?: unknown): Promise<unknown>;
  };
}
