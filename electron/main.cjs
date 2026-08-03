// Standalone desktop shell. Serves the built app over a custom `app://` scheme
// rather than file:// — a real origin is what makes localStorage and the File
// System Access API ("Open folder…") work.

const { app, BrowserWindow, ipcMain, protocol, net, safeStorage, session, shell } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // http(s) links in notes belong in the real browser, not in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  void win.loadURL("app://-/");
}

/** Runs one git command in `cwd`; a non-zero exit rejects with whatever git said. */
const git = (cwd, ...args) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout.trim());
    });
  });

/*
 * The whole git integration: stage everything, commit. First use in a folder that is
 * not a repository initialises one — "turn git on" should not require a terminal.
 */
ipcMain.handle("git-commit", async (_event, root) => {
  const dir = String(root).replace(/^~(?=$|\/)/, os.homedir());
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`${dir} is not a folder on this machine`);
  }
  const fresh = await git(dir, "rev-parse", "--is-inside-work-tree").then(
    () => false,
    () => true,
  );
  if (fresh) await git(dir, "init");
  await git(dir, "add", "-A");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  try {
    await git(dir, "commit", "-m", `vault snapshot ${stamp}`);
  } catch (err) {
    if (/nothing to commit/i.test(err.message)) {
      return fresh ? "initialised the repository — nothing to commit yet" : "nothing to commit";
    }
    throw err;
  }
  return `committed ${await git(dir, "log", "-1", "--format=%h — %s")}`;
});

/*
 * Linear. The renderer never sees the API key: it hands over a query, the shell adds
 * the Authorization header. The key is encrypted with the OS keychain (safeStorage)
 * into the app's own userData folder — deliberately NOT the vault, which the git
 * button snapshots wholesale; a token in `.notes/` would be committed and pushed.
 */
const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const keyFile = () => path.join(app.getPath("userData"), "linear.json");

function readAccount() {
  try {
    const stored = JSON.parse(fs.readFileSync(keyFile(), "utf8"));
    if (typeof stored.key !== "string") return null;
    const key = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(Buffer.from(stored.key, "base64"))
      : Buffer.from(stored.key, "base64").toString("utf8");
    return { key, user: typeof stored.user === "string" ? stored.user : "" };
  } catch {
    return null; // never connected, or the keychain refused — both mean "not connected"
  }
}

/** One GraphQL call with whatever key is stored. Throws what Linear said, verbatim. */
async function linearFetch(key, query, variables) {
  const response = await net.fetch(LINEAR_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: key },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  });
  if (!response.ok) {
    throw new Error(response.status === 401 ? "Linear refused the key" : `Linear said ${response.status}`);
  }
  const body = await response.json();
  if (body.errors?.length) throw new Error(String(body.errors[0]?.message || "Linear rejected the request"));
  return body.data;
}

/**
 * Pasting a key is the whole setup: it is proved against Linear before being kept, so a
 * typo is told about at once rather than at the first tick that fails to land.
 */
ipcMain.handle("linear-connect", async (_event, rawKey) => {
  const key = String(rawKey || "").trim();
  if (!key) throw new Error("no key given");
  const data = await linearFetch(key, `query{viewer{name}}`);
  const user = String(data?.viewer?.name || "");
  const stored = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(key).toString("base64")
    : Buffer.from(key, "utf8").toString("base64");
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), JSON.stringify({ version: 1, key: stored, user }), { mode: 0o600 });
  return { user };
});

ipcMain.handle("linear-status", () => {
  const account = readAccount();
  return account ? { connected: true, user: account.user } : { connected: false, user: "" };
});

ipcMain.handle("linear-forget", () => {
  try {
    fs.rmSync(keyFile());
  } catch {
    /* nothing stored */
  }
  return true;
});

ipcMain.handle("linear-call", async (_event, query, variables) => {
  const account = readAccount();
  if (!account) throw new Error("Linear is not connected");
  return linearFetch(account.key, String(query), variables);
});

/*
 * A Gemini chat in a window the app OWNS, so nobody has to copy anything: Google
 * assigns the conversation its URL (gemini.google.com/app/<id>) after the first
 * message, this window sees that navigation happen, and the promise resolves with
 * the link — the renderer writes it straight into the note. The window stays open;
 * closing it before a conversation starts resolves null.
 *
 * Signing in happens ONCE: the chats live in their own persistent session
 * (`persist:gemini`), so the cookies Google sets during that first login survive
 * every restart. Chrome's own cookie jar cannot be borrowed — it is encrypted per
 * user via the OS keychain — so making this session trustworthy is the whole game:
 * the user agent must not confess to Electron anywhere (Google refuses "insecure
 * browsers"), including on the sign-in POPUPS, which must also stay in this session
 * or the cookies they set land in the wrong jar and the login never takes.
 */
const GEMINI_CONVO = /^https:\/\/gemini\.google\.com\/(?:app|share)\/[\w-]+/;
const GEMINI_PARTITION = "persist:gemini";
const GOOGLE_RE = /^https:\/\/([\w-]+\.)*google\.com\//;

ipcMain.handle("gemini-chat", (_event, url) => {
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    title: "Gemini",
    autoHideMenuBar: true,
    backgroundColor: "#1e1e1e",
    webPreferences: { partition: GEMINI_PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  // Google's sign-in flow opens popups; they must be real windows IN THIS SESSION
  // for the login cookies to land where the chat lives. Anything else goes to the
  // system browser, exactly like links in notes do.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (GOOGLE_RE.test(target)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { partition: GEMINI_PARTITION, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    if (/^https?:/.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  void win.loadURL(String(url));
  return new Promise((resolve) => {
    let settled = false;
    const check = (target) => {
      if (settled) return;
      const match = GEMINI_CONVO.exec(target || "");
      if (match) {
        settled = true;
        resolve(match[0]);
      }
    };
    win.webContents.on("did-navigate", (_e, target) => check(target));
    win.webContents.on("did-navigate-in-page", (_e, target) => check(target));
    win.on("closed", () => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
  });
});

app.whenReady().then(() => {
  protocol.handle("app", serve);
  // Session-wide user agent for the gemini partition: every request — first page,
  // redirects, sign-in popups — reads as plain Chrome, or Google blocks the login.
  const gemini = session.fromPartition(GEMINI_PARTITION);
  gemini.setUserAgent(
    gemini
      .getUserAgent()
      .replace(/\sElectron\/\S+/, "")
      .replace(new RegExp(`\\s${app.getName()}/\\S+`), ""),
  );
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Single-window app: closing the window quits, so "off" is unambiguous.
app.on("window-all-closed", () => app.quit());
