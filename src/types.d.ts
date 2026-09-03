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
    /** Where the `agy` CLI is (null when it is not installed), and whether it has ever run
        on this machine. There is no sign-in question: the CLI holds its own OAuth login in
        the keychain and asks for one in the terminal, where it can be answered. */
    agyStatus(): Promise<{ cli: string | null; ran: boolean; platform: string }>;
    /** Mints an Antigravity conversation scoped to `folder` and resolves with its id. The
        conversation is left EMPTY — `name` is only what the CLI needs to start, and the
        process is killed the moment it announces the id, before any model call. */
    agyCreate(folder: string, name: string): Promise<string>;
    /** Hands a conversation to the person's own terminal — whichever app owns `.command`.
        Resolves once the terminal has been asked to open; what happens in it is the CLI's. */
    agyOpen(options: { id: string; folder?: string; title?: string }): Promise<boolean>;
    /** The conversations on this machine, most recently touched first — what a note can be
        plugged into. `title` and `steps` are empty for one the CLI has no summary row for,
        which is every conversation minted here and not yet talked to. */
    agyConversations(
      limit?: number,
    ): Promise<Array<{ id: string; title: string; preview: string; steps: number; folder: string; at: number }>>;
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

    /** Proves a bot token against Slack and keeps it in the OS keychain. Rejects with
        what Slack said if the token is no good; resolves with who the token is. */
    slackConnect(token: string): Promise<{ team: string; teamId: string; url: string; user: string }>;
    /** `bot` is a bot token: posts come from the app rather than from the person. */
    slackStatus(): Promise<{ connected: boolean; team: string; user: string; bot: boolean }>;
    slackForget(): Promise<boolean>;
    /** The channels the token can see, public and private, the ones the app is in first. */
    slackChannels(): Promise<Array<{ id: string; name: string; member: boolean; private: boolean }>>;
    /** The threads going in a channel — its answered messages, newest first. */
    slackThreads(channel: string, limit?: number): Promise<SlackThread[]>;
    /** One thread, by the channel and timestamp that name it — what a pasted link comes to. */
    slackThread(channel: string, ts: string): Promise<SlackThread>;
    /** Starts a thread: posts `text` as its first message, and resolves with the thread. */
    slackPost(channel: string, text: string): Promise<SlackThread>;
    /** Opens THE thread — the Slack app when it is here, the browser otherwise. False for
        an address that is not a Slack message link. */
    slackOpen(url: string): Promise<boolean>;

    /** OAuth in the browser: opens Google's consent page and catches the answer on a
        loopback port. Resolves with the account's address once linked. */
    googleConnect(): Promise<{ email: string }>;
    /** `ownClient` is a client of the person's own standing in for Bedrock's; `builtClient`
        is whether this build was made with Bedrock's at all (a clone built without the
        secret has none, and can only link over a client of the person's own). */
    googleStatus(): Promise<{ linked: boolean; email: string; ownClient: boolean; builtClient: boolean }>;
    /** Revokes the grant with Google (best effort) and forgets the tokens here. */
    googleForget(): Promise<boolean>;
    /** Stores a Google OAuth client of the person's own, or with an empty id goes back to
        Bedrock's. Either way the account is unlinked — a token belongs to its client. */
    googleClient(id: string, secret: string): Promise<boolean>;
    /** The account's task lists. */
    googleLists(): Promise<Array<{ id: string; title: string }>>;
    /** A list's open tasks, in Google's order. "" or "@default" means the default list. */
    googleTasks(list: string): Promise<GoogleTask[]>;
    /** Makes a task titled `title` in `list` and resolves with it. */
    googleTaskCreate(list: string, title: string): Promise<GoogleTask>;
    /** Where each `list/id` stands now: the task, null when Google no longer has it, and
        absent when that one read failed — the round goes on for the rest. */
    googleTaskStatus(refs: string[]): Promise<Record<string, GoogleTask | null>>;
    /** Opens THE task in Google Tasks on the web — or Tasks itself for one with no address. */
    googleOpen(url: string): Promise<boolean>;

    /** Whether Freeform is on this Mac, and whether Bedrock's shortcut — Apple's only
        door into making a board — is in the Shortcuts library. */
    freeformStatus(): Promise<{ app: boolean; shortcut: boolean }>;
    /** The boards Freeform knows of, latest edit first — read off the index Freeform
        keeps for its widget, never off its database. */
    freeformBoards(limit?: number): Promise<FreeformBoard[]>;
    /** Makes a board by running the shipped shortcut, and resolves with the board once
        it shows up in the index — or null if the run succeeded but nothing appeared. */
    freeformCreate(title: string): Promise<FreeformBoard | null>;
    /** Opens THE board, in Freeform, over its URL scheme. False for a malformed id. */
    freeformOpen(id: string): Promise<boolean>;
    /** Opens Shortcuts' import dialog on the shipped shortcut — the one Add Shortcut
        click Apple keeps for the person. Rejects with what the OS said went wrong. */
    freeformInstall(): Promise<boolean>;

    /** Whether Apple Notes is on this Mac. Whether Bedrock may drive it is macOS's to
        say, and macOS only says when asked — the first real action asks. */
    notesStatus(): Promise<{ app: boolean }>;
    /** The notes Apple Notes holds, latest edit first, the deleted ones left out.
        Rejects with directions when macOS is keeping Bedrock away. */
    notesList(limit?: number): Promise<AppleNote[]>;
    /** Makes a note titled `title` in the named Notes folder ("" means the default,
        “Bedrock”), making the folder too if it is not there yet. */
    notesCreate(folder: string, title: string): Promise<AppleNote>;
    /** The folders of the default account a new note could land in, the bin left out. */
    notesFolders(): Promise<string[]>;
    /** Opens THE note, in Apple Notes. False for a malformed id. */
    notesOpen(id: string): Promise<boolean>;

    /** Links a Notion workspace: OAuth in the real browser, the token into the OS
        keychain. Resolves once the browser comes back; rejects if it never does. */
    notionConnect(): Promise<{ workspace: string }>;
    notionStatus(): Promise<{ linked: boolean; workspace: string }>;
    notionForget(): Promise<boolean>;
    /** The pages the workspace can see for `query` — empty lists what is recent. */
    notionSearch(query?: string): Promise<NotionPage[]>;
    /** Makes a page titled `title` (private, at the workspace root) and resolves with it. */
    notionCreate(title: string): Promise<NotionPage>;
    /** Opens THE page — the Notion app when it is installed, the browser otherwise.
        False for an address that is not Notion's. */
    notionOpen(url: string): Promise<boolean>;

    /** Whether Microsoft Word is on this Mac — not a system app, so a real question. */
    wordStatus(): Promise<{ app: boolean }>;
    /** Word's own recent documents, latest first, read off the list it keeps beside its
        preferences — no launch, no prompt. Ones that moved since are left out. */
    wordRecent(limit?: number): Promise<WordDoc[]>;
    /** Makes a .docx named `title` in `folder` ("" means the default,
        Documents/word-bedrock), opens it in Word, and resolves with where it landed.
        The name is uniquified rather than overwriting. */
    wordCreate(folder: string, title: string): Promise<WordDoc>;
    /** Opens THE document, in Word specifically — whatever app owns the double-click. */
    wordOpen(path: string): Promise<"opened" | "missing">;

    /** The menu bar speaking: Settings… or Open Vault… was picked. */
    onMenu(fn: (what: "settings" | "open-vault") => void): void;

    /** Where the `claude` CLI is (null when it is not installed). The whole prerequisite
        for terminal mode: there is nothing else to install, and no window to own. */
    claudeCliStatus(): Promise<{ cli: string | null; platform: string }>;
    /** Starts a session in the person's own terminal, with an id minted up front. Resolves
        with that id — no watching, no guessing: the note has its session's name
        immediately. Pass a previous id to resume it instead, which keeps that id rather
        than branching. `title` names the terminal window. */
    claudeCliStart(folder: string, resume?: string | null, title?: string): Promise<string>;
    /** Which account the CLI runs as — identity only, never a token, and never a guess at
        what that account may spend. The CLI and the Claude app keep separate logins, so
        which one is which is worth saying out loud. */
    claudeAccount(): Promise<{ email: string; org: string; seat: string }>;
  };
}

/** An Apple note as the pointer Bedrock keeps: never the note itself. */
type AppleNote = {
  /** The CoreData id Apple minted (`x-coredata://…`) — what `show` opens. */
  id: string;
  title: string;
  /** Last edit, epoch milliseconds. */
  at: number;
};

/** A Word document as the pointer Bedrock keeps: a file of the user's own. */
type WordDoc = {
  /** Absolute path on this disk — what Word is handed to open it. */
  path: string;
  /** The basename with the extension shed. */
  title: string;
  /** Last use, epoch milliseconds. */
  at: number;
};

/** A Slack thread as the pointer Bedrock keeps: never the conversation itself. */
type SlackThread = {
  /** The channel it is in, and the timestamp of the message that started it — together
      the thread's whole identity as far as Slack is concerned. */
  channel: string;
  ts: string;
  /** The first message, as plain words — what the note is named after. */
  text: string;
  replies: number;
  /** When it started, and when it was last answered, both epoch milliseconds. */
  at: number;
  latest: number;
  /** The thread's permalink — what the note keeps, and what a click opens. */
  url: string;
};

/** A Google task as the pointer Bedrock keeps: the title, the due date and the tick stay
    with Google. */
type GoogleTask = {
  /** The list it is in, and Google's id for it — together the whole handle. */
  list: string;
  id: string;
  title: string;
  status: "needsAction" | "completed";
  /** Due, completed and last touched — epoch milliseconds, 0 for "not". */
  due: number;
  completed: number;
  updated: number;
  /** The task's own address in Google Tasks on the web — what a click opens. */
  url: string;
};

/** A Notion page as the pointer Bedrock keeps: never the page itself. */
type NotionPage = {
  /** The 32-hex id Notion minted, pulled off the URL. */
  id: string;
  title: string;
  /** The page's own address — what a click opens. */
  url: string;
};

/** A Freeform board as the pointer Bedrock keeps: never the board itself. */
type FreeformBoard = {
  /** The uuid Freeform minted — what `freeform://board?id=` opens. */
  id: string;
  title: string;
  /** Last edit, epoch milliseconds. */
  at: number;
  shared: boolean;
};

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
