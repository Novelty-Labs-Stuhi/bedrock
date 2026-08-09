// What the renderer may ask the shell to do: run a git snapshot in the vault's
// folder, open a Gemini chat in a window the shell watches for the minted
// conversation URL, open a Claude Code session in the Claude app and wait for the
// id it mints, read a webpage's title and icon off the site itself, and talk to
// Linear. Everything else goes through web APIs on purpose.
//
// Note what is NOT here: any way to read the Linear key back. The renderer can
// connect, ask whether it is connected, forget, and make calls — the key itself
// never crosses into page context.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bedrock", {
  gitCommit: (root) => ipcRenderer.invoke("git-commit", root),
  pickPath: (kind) => ipcRenderer.invoke("fs-pick", kind),
  openPath: (target) => ipcRenderer.invoke("fs-open", target),
  geminiChat: (url) => ipcRenderer.invoke("gemini-chat", url),
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
});
