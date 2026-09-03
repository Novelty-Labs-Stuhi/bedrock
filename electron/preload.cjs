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
  pickPath: (kind) => ipcRenderer.invoke("fs-pick", kind),
  openPath: (target) => ipcRenderer.invoke("fs-open", target),
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

  // Sessions run by the CLI, in the person's own terminal. `claudeCliStatus` is what the
  // settings window gates the mode on; starting one hands it over and returns its id.
  claudeCliStatus: () => ipcRenderer.invoke("claude-cli-status"),
  claudeCliStart: (folder, resume, title) => ipcRenderer.invoke("claude-cli-start", folder, resume, title),
  claudeAccount: () => ipcRenderer.invoke("claude-account"),
});
