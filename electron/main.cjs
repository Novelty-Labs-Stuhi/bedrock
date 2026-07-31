// Standalone desktop shell. Serves the built app over a custom `app://` scheme
// rather than file:// — a real origin is what makes localStorage and the File
// System Access API ("Open folder…") work.

const { app, BrowserWindow, protocol, net, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DIST = path.join(__dirname, "..", "dist");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function serve(request) {
  const { pathname } = new URL(request.url);
  const target = path.join(DIST, pathname === "/" ? "index.html" : decodeURIComponent(pathname));
  // Never let a crafted URL escape the build output.
  if (target !== DIST && !target.startsWith(DIST + path.sep)) {
    return new Response("forbidden", { status: 403 });
  }
  return net.fetch(pathToFileURL(target).toString());
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 460,
    title: "bedrock",
    backgroundColor: "#1e1e1e",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // http(s) links in notes belong in the real browser, not in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  void win.loadURL("app://-/");
}

app.whenReady().then(() => {
  protocol.handle("app", serve);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Single-window app: closing the window quits, so "off" is unambiguous.
app.on("window-all-closed", () => app.quit());
