// What the renderer may ask the shell to do: run a git snapshot in the vault's
// folder, and open a Gemini chat in a window the shell watches for the minted
// conversation URL. Everything else the app does goes through web APIs on purpose.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bedrock", {
  gitCommit: (root) => ipcRenderer.invoke("git-commit", root),
  geminiChat: (url) => ipcRenderer.invoke("gemini-chat", url),
});
