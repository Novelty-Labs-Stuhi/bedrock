// What the renderer may ask the shell to do: run a git snapshot in the vault's
// folder, mint an Antigravity conversation and hand it to the person's terminal,
// open a Claude Code session in the Claude app and wait for the id it mints, read a
// webpage's title and icon off the site itself, and talk to Linear and Slack. Everything else
// goes through web APIs on purpose.
//
// Note what is NOT here: any way to read the Linear key back. The renderer can
// connect, ask whether it is connected, forget, and make calls — the key itself
// never crosses into page context.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bedrock", {
  gitCommit: (root) => ipcRenderer.invoke("git-commit", root),
  gitPush: (root, remote) => ipcRenderer.invoke("git-push", root, remote),
  gitPull: (root, remote) => ipcRenderer.invoke("git-pull", root, remote),
  gitStatus: (root) => ipcRenderer.invoke("git-status", root),
  pickPath: (kind, options) => ipcRenderer.invoke("fs-pick", kind, options),
  openPath: (target) => ipcRenderer.invoke("fs-open", target),
  vaultFs: (root, op, rel, arg) => ipcRenderer.invoke("vault-fs", root, op, rel, arg),
  peekNote: (target, root) => ipcRenderer.invoke("note-peek", target, root),
  vaultIndex: (root) => ipcRenderer.invoke("vault-index", root),
  agyStatus: () => ipcRenderer.invoke("agy-status"),
  agyCreate: (folder, name) => ipcRenderer.invoke("agy-create", folder, name),
  agyOpen: (options) => ipcRenderer.invoke("agy-open", options),
  agyConversations: (limit) => ipcRenderer.invoke("agy-conversations", limit),
  webPage: (url) => ipcRenderer.invoke("web-page", url),
  claudeFolder: () => ipcRenderer.invoke("claude-folder"),
  claudeFolders: (limit) => ipcRenderer.invoke("claude-folders", limit),
  claudeSessions: (limit) => ipcRenderer.invoke("claude-sessions", limit),
  claudeStart: (folder) => ipcRenderer.invoke("claude-start", folder),
  claudeOpen: (session) => ipcRenderer.invoke("claude-open", session),
  claudeStatus: (sessions) => ipcRenderer.invoke("claude-status", sessions),
  claudeAdopt: (folder, since) => ipcRenderer.invoke("claude-adopt", folder, since),
  linearConnect: (key) => ipcRenderer.invoke("linear-connect", key),
  linearStatus: () => ipcRenderer.invoke("linear-status"),
  linearForget: () => ipcRenderer.invoke("linear-forget"),
  linearCall: (query, variables) => ipcRenderer.invoke("linear-call", query, variables),
  slackConnect: (token) => ipcRenderer.invoke("slack-connect", token),
  slackStatus: () => ipcRenderer.invoke("slack-status"),
  slackForget: () => ipcRenderer.invoke("slack-forget"),
  slackChannels: () => ipcRenderer.invoke("slack-channels"),
  slackThreads: (channel, limit) => ipcRenderer.invoke("slack-threads", channel, limit),
  slackThread: (channel, ts) => ipcRenderer.invoke("slack-thread", channel, ts),
  slackPost: (channel, text) => ipcRenderer.invoke("slack-post", channel, text),
  slackOpen: (url) => ipcRenderer.invoke("slack-open", url),
  googleConnect: () => ipcRenderer.invoke("google-connect"),
  googleStatus: () => ipcRenderer.invoke("google-status"),
  googleForget: () => ipcRenderer.invoke("google-forget"),
  googleClient: (id, secret) => ipcRenderer.invoke("google-client", id, secret),
  googleLists: () => ipcRenderer.invoke("google-lists"),
  googleTasks: (list) => ipcRenderer.invoke("google-tasks", list),
  googleTaskCreate: (list, title) => ipcRenderer.invoke("google-task-create", list, title),
  googleTaskStatus: (refs) => ipcRenderer.invoke("google-task-status", refs),
  googleOpen: (url) => ipcRenderer.invoke("google-open", url),
  freeformStatus: () => ipcRenderer.invoke("freeform-status"),
  freeformBoards: (limit) => ipcRenderer.invoke("freeform-boards", limit),
  freeformCreate: (title) => ipcRenderer.invoke("freeform-create", title),
  freeformOpen: (id) => ipcRenderer.invoke("freeform-open", id),
  freeformInstall: () => ipcRenderer.invoke("freeform-install"),
  notesStatus: () => ipcRenderer.invoke("notes-status"),
  notesList: (limit) => ipcRenderer.invoke("notes-list", limit),
  notesCreate: (folder, title) => ipcRenderer.invoke("notes-create", folder, title),
  notesFolders: () => ipcRenderer.invoke("notes-folders"),
  notesOpen: (id) => ipcRenderer.invoke("notes-open", id),
  notionConnect: () => ipcRenderer.invoke("notion-connect"),
  notionStatus: () => ipcRenderer.invoke("notion-status"),
  notionForget: () => ipcRenderer.invoke("notion-forget"),
  notionSearch: (query) => ipcRenderer.invoke("notion-search", query),
  notionCreate: (title) => ipcRenderer.invoke("notion-create", title),
  notionOpen: (url) => ipcRenderer.invoke("notion-open", url),
  wordStatus: () => ipcRenderer.invoke("word-status"),
  wordRecent: (limit) => ipcRenderer.invoke("word-recent", limit),
  wordCreate: (folder, title) => ipcRenderer.invoke("word-create", folder, title),
  wordOpen: (path) => ipcRenderer.invoke("word-open", path),
  // The menu bar's two renderer-side doors: Settings…, Open Vault….
  onMenu: (fn) => ipcRenderer.on("menu", (_e, what) => fn(what)),

  // Windows. `windowRoot` is this window saying which vault it has open; `windowState`
  // asks whether this window is full screen and what the other windows are holding;
  // `windowShow` raises one of them, on a note if one is named. `onGoto` is the other
  // end of that: a window being raised is told where to land.
  windowRoot: (root) => ipcRenderer.invoke("window-root", root),
  windowState: () => ipcRenderer.invoke("window-state"),
  windowShow: (id, focus) => ipcRenderer.invoke("window-show", id, focus),
  // `windowOpen` is a window of its own onto a vault — a top-level one, not a child of
  // this window, so closing this one leaves it standing.
  windowOpen: (root, focus) => ipcRenderer.invoke("window-open", root, focus),

  // The Bedrock folder: where vaults live, where the sheet opens, the top of the search.
  // `baseRef` is a path the way a `ref::` line writes it — relative to that folder when
  // under it, absolute otherwise.
  baseGet: () => ipcRenderer.invoke("base-get"),
  baseSet: (folder) => ipcRenderer.invoke("base-set", folder),
  baseRef: (full) => ipcRenderer.invoke("base-ref", full),
  // Something moved: repoint every `ref::` in the system of vaults that aimed at `from` (or
  // inside it) to `to`. `onRefsChanged` is the other end, in the windows whose files changed.
  refsRetarget: (from, to, scopeRoot) => ipcRenderer.invoke("refs-retarget", from, to, scopeRoot),
  onRefsChanged: (fn) => ipcRenderer.on("refs-changed", (_e, roots) => fn(roots)),
  onGoto: (fn) => ipcRenderer.on("goto", (_e, focus) => fn(focus)),

  // Sessions run by the CLI, in the person's own terminal. `claudeCliStatus` is what the
  // settings window gates the mode on; starting one hands it over and returns its id.
  claudeCliStatus: () => ipcRenderer.invoke("claude-cli-status"),
  claudeCliStart: (folder, resume, title) => ipcRenderer.invoke("claude-cli-start", folder, resume, title),
  claudeAccount: () => ipcRenderer.invoke("claude-account"),
});
