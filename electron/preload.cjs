// What the renderer may ask the shell to do: run a git snapshot in the vault's
// folder, open a Gemini chat in a window the shell watches for the minted
// conversation URL, and talk to Linear. Everything else goes through web APIs
// on purpose.
//
// Note what is NOT here: any way to read the Linear key back. The renderer can
// connect, ask whether it is connected, forget, and make calls — the key itself
// never crosses into page context.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bedrock", {
  gitCommit: (root) => ipcRenderer.invoke("git-commit", root),
  geminiChat: (url) => ipcRenderer.invoke("gemini-chat", url),
  linearConnect: (key) => ipcRenderer.invoke("linear-connect", key),
  linearStatus: () => ipcRenderer.invoke("linear-status"),
  linearForget: () => ipcRenderer.invoke("linear-forget"),
  linearCall: (query, variables) => ipcRenderer.invoke("linear-call", query, variables),
});
