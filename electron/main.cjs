// Standalone desktop shell. Serves the built app over a custom `app://` scheme
// rather than file:// — a real origin is what makes localStorage and the File
// System Access API ("Open folder…") work.

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, safeStorage, session, shell } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DIST = path.join(__dirname, "..", "dist");
// Packaged builds carry the icon in the bundle; this covers running from the repo.
const DEV_ICON = path.join(__dirname, "..", "build", "icon.png");

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
    ...(process.platform !== "darwin" && !app.isPackaged ? { icon: DEV_ICON } : {}),
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

/*
 * The standard menus, plus File > New Window: one bedrock window per project. A new
 * window comes up on the local vault like a first launch does — "Open folder…" then
 * points it at whichever project it is for, and each folder keeps its own arrangement,
 * settings and integrations (they live in the vault, not the window).
 */
function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
      {
        label: "File",
        submenu: [
          { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => createWindow() },
          { role: process.platform === "darwin" ? "close" : "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
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
 * Files and folders on this machine. The renderer names nothing itself: the OS's own
 * picker chooses (its New Folder button covers creating one), and the OS's own opener
 * opens — the default app for a file, Finder/Explorer for a folder. Both dialogs and
 * both openers behave the same on macOS and Windows, which is the whole point of
 * going through the shell for this.
 */
ipcMain.handle("fs-pick", async (event, kind) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties:
      kind === "folder"
        ? // `createDirectory` puts the New Folder button in the macOS sheet; Windows'
          // folder picker has one of its own without being asked.
          ["openDirectory", "createDirectory"]
        : ["openFile"],
  });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});

/**
 * "opened", "missing", or whatever the OS said went wrong (shell.openPath resolves
 * with an error STRING, empty on success — it never rejects). Missing is its own
 * answer because the renderer's response to it is different: offer to re-pick.
 */
ipcMain.handle("fs-open", async (_event, target) => {
  const expanded = String(target).replace(/^~(?=$|\/)/, os.homedir());
  if (!fs.existsSync(expanded)) return "missing";
  const error = await shell.openPath(expanded);
  return error ? error : "opened";
});

/*
 * A webpage on the graph. The renderer hands over an address and gets back what a
 * bookmark needs to draw itself: the page's own <title>, and the biggest icon the
 * site offers, as data.
 *
 * It happens here rather than in the renderer for two reasons. The app's origin is
 * `app://`, and a page fetched from there is a cross-origin read every site is free
 * to refuse — the shell has no origin to be refused for. And only here can the answer
 * be KEPT: a graph of thirty links must not re-scrape thirty sites at every launch.
 * The cache is in userData, deliberately NOT in the vault: the git button snapshots
 * the vault wholesale, and a folder of other people's logos is not something anybody
 * meant to commit.
 */
const WEB_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0.0.0 Safari/537.36";
/** Enough of the HTML to be well past </head>, which is all this reads. */
const PAGE_LIMIT = 512 * 1024;
const ICON_LIMIT = 2 * 1024 * 1024;
const WEB_TIMEOUT = 9000;
/** How long a scraped icon is trusted before the site is asked again. */
const ICON_TTL = 14 * 24 * 60 * 60 * 1000;
/** Pages remembered; the least recently looked up fall off the end. */
const ICON_KEEP = 300;

const iconFile = () => path.join(app.getPath("userData"), "webicons.json");

function readIcons() {
  try {
    const stored = JSON.parse(fs.readFileSync(iconFile(), "utf8"));
    return stored && typeof stored.pages === "object" && stored.pages ? stored.pages : {};
  } catch {
    return {}; // nothing scraped yet, or a cache somebody broke — both mean "ask the site"
  }
}

function writeIcons(pages) {
  const kept = Object.entries(pages)
    .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
    .slice(0, ICON_KEEP);
  try {
    fs.mkdirSync(path.dirname(iconFile()), { recursive: true });
    fs.writeFileSync(iconFile(), JSON.stringify({ version: 1, pages: Object.fromEntries(kept) }));
  } catch {
    /* an unwritable cache costs a re-fetch and nothing else */
  }
}

/** One GET, capped and with a deadline — a site that hangs must not hang the node. */
async function fetchBytes(url, limit) {
  const response = await net.fetch(url, {
    headers: { "user-agent": WEB_UA, accept: "*/*" },
    signal: AbortSignal.timeout(WEB_TIMEOUT),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  return {
    bytes: body.subarray(0, limit),
    url: response.url || url, // where the redirects actually landed — relative hrefs hang off this
    type: (response.headers.get("content-type") || "").toLowerCase(),
  };
}

/** One attribute out of one tag, in any of the three quoting styles HTML allows. */
function attr(tag, name) {
  const found = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return found ? (found[1] ?? found[2] ?? found[3] ?? "") : null;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Titles come entity-encoded far too often for "&amp;" to be left standing in a node label. */
const decodeEntities = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] !== "#") return ENTITIES[body.toLowerCase()] ?? whole;
    const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

function pageTitle(html) {
  const found = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return found ? decodeEntities(found[1]).replace(/\s+/g, " ").trim().slice(0, 90) : "";
}

/**
 * How big a candidate CLAIMS to be, from its `sizes` attribute or from the size baked
 * into its file name. Only a claim — it decides what is worth fetching, and the bytes
 * decide what actually wins.
 */
function sizeHint(sizes, href) {
  if (/\.svg(?:[?#]|$)/i.test(href)) return 9000; // scalable: nothing raster beats it
  if (sizes && /^\s*any\s*$/i.test(sizes)) return 9000;
  let best = 0;
  for (const found of String(sizes || "").matchAll(/(\d+)\s*[x×]\s*(\d+)/gi)) {
    best = Math.max(best, Number(found[1]));
  }
  if (best) return best;
  const named = /(\d{2,4})x\1/.exec(href); // apple-touch-icon-180x180.png
  return named ? Number(named[1]) : 0;
}

/** Every icon the page offers, best claim first — plus the two every site has anyway. */
async function iconCandidates(html, base) {
  const found = new Map();
  const add = (href, hint) => {
    if (!href) return;
    let absolute;
    try {
      absolute = new URL(href, base).toString();
    } catch {
      return;
    }
    if (!/^https?:/i.test(absolute)) return; // data: and friends are not worth the round trip
    found.set(absolute, Math.max(found.get(absolute) ?? 0, hint));
  };

  let manifest = null;
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, "rel") || "").toLowerCase();
    const href = attr(tag, "href");
    if (/\bmanifest\b/.test(rel)) {
      manifest = href;
      continue;
    }
    // `mask-icon` is deliberately not among these: Safari's pinned-tab icon is a
    // one-colour silhouette meant to be tinted by the browser, and taken at face
    // value it puts a black blob where the site's actual mark should be.
    if (!/\b(?:icon|apple-touch-icon|apple-touch-icon-precomposed|fluid-icon)\b/.test(rel)) {
      continue;
    }
    add(href, sizeHint(attr(tag, "sizes"), href || ""));
  }
  // The web app manifest is where the big ones live — 192 and 512 square, drawn for
  // exactly this job: the site standing on somebody else's screen as an icon.
  if (manifest) {
    try {
      const body = await fetchBytes(new URL(manifest, base).toString(), PAGE_LIMIT);
      for (const icon of JSON.parse(body.bytes.toString("utf8")).icons ?? []) {
        add(new URL(icon.src, body.url).toString(), sizeHint(icon.sizes, icon.src || ""));
      }
    } catch {
      /* no manifest, or nonsense in it — the <link> icons stand on their own */
    }
  }
  // The conventions, for the many sites that declare nothing at all.
  add(new URL("/favicon.ico", base).toString(), 0);
  add(new URL("/apple-touch-icon.png", base).toString(), 180);

  return [...found]
    .map(([url, hint]) => ({ url, hint }))
    .sort((a, b) => b.hint - a.hint)
    .slice(0, 6);
}

/**
 * What the bytes ACTUALLY are. Servers hand back an HTML error page under a 200 and an
 * image content-type often enough that the header cannot be believed; the magic bytes
 * can. Anything unrecognised is not an icon as far as this is concerned.
 */
function imageType(bytes) {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.toString("latin1", 0, 3) === "GIF") return "image/gif";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
  const head = bytes.toString("utf8", 0, 400).trim().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  return null;
}

/**
 * The width the bytes really have, read off the header — "best resolution" decided by
 * measurement rather than by what the page claimed. Unmeasurable is 0, which loses to
 * anything measurable and falls back to the claim.
 */
function imageWidth(bytes, type) {
  try {
    if (type === "image/svg+xml") return 9000; // draws sharp at whatever size the node is
    if (type === "image/png") return bytes.readUInt32BE(16);
    if (type === "image/gif") return bytes.readUInt16LE(6);
    if (type === "image/x-icon") {
      // An .ico is a directory of images; the one that matters is its biggest. A width
      // byte of 0 means 256 — the format has nowhere else to put a number that big.
      let best = 0;
      const count = bytes.readUInt16LE(4);
      for (let i = 0; i < count && 6 + i * 16 < bytes.length; i++) best = Math.max(best, bytes[6 + i * 16] || 256);
      return best;
    }
    if (type === "image/webp") {
      const chunk = bytes.toString("latin1", 12, 16);
      if (chunk === "VP8X") return bytes.readUIntLE(24, 3) + 1;
      if (chunk === "VP8 ") return bytes.readUInt16LE(26) & 0x3fff;
      if (chunk === "VP8L") return (bytes.readUInt32LE(21) & 0x3fff) + 1;
      return 0;
    }
    if (type === "image/jpeg") {
      for (let at = 2; at + 9 < bytes.length; ) {
        if (bytes[at] !== 0xff) {
          at++;
          continue;
        }
        const marker = bytes[at + 1];
        // Every SOF marker carries the dimensions; the four in the gaps do not.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return bytes.readUInt16BE(at + 7);
        }
        at += 2 + bytes.readUInt16BE(at + 2);
      }
    }
  } catch {
    /* a truncated or lying header is simply not measurable */
  }
  return 0;
}

async function scrapePage(target) {
  let html = "";
  let base = target;
  try {
    const page = await fetchBytes(target, PAGE_LIMIT);
    base = page.url;
    if (!page.type || /html|xml/.test(page.type)) html = page.bytes.toString("utf8");
  } catch {
    /* a page that will not be read still has an origin worth guessing at */
  }
  const candidates = await iconCandidates(html, base);
  // All at once: six small GETs against one host, and the slowest of them is the wait
  // rather than the sum. Every one of them is allowed to fail on its own.
  const fetched = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const got = await fetchBytes(candidate.url, ICON_LIMIT);
        const type = imageType(got.bytes);
        if (!type) return null;
        return { bytes: got.bytes, type, width: imageWidth(got.bytes, type) || candidate.hint };
      } catch {
        return null;
      }
    }),
  );
  const best = fetched.filter(Boolean).sort((a, b) => b.width - a.width)[0];
  return {
    url: base,
    title: pageTitle(html),
    icon: best ? `data:${best.type};base64,${best.bytes.toString("base64")}` : "",
  };
}

ipcMain.handle("web-page", async (_event, rawUrl) => {
  const target = String(rawUrl || "").trim();
  if (!/^https?:\/\//i.test(target)) throw new Error("that is not a web address");
  const pages = readIcons();
  const known = pages[target];
  const remembered = known && { url: known.url || target, title: known.title || "", icon: known.icon || "" };
  if (remembered && Date.now() - (known.at ?? 0) < ICON_TTL) return remembered;

  const found = await scrapePage(target);
  // A site that is down (or has just started refusing us) must not cost the node the
  // icon it has been wearing all along: nothing found leaves the old answer standing.
  if (!found.icon && !found.title && remembered) return remembered;
  if (found.icon || found.title) {
    pages[target] = { ...found, at: Date.now() };
    writeIcons(pages);
  }
  return found;
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

/*
 * Claude Code, in the Claude app's own UI. The app registers `claude://`, and two of its
 * deep links are the whole integration: `code/new` opens a fresh session scoped to a
 * folder, with a prompt already in the composer, and `resume` reopens one by id. No
 * window to own, no session to launder — `shell.openExternal` is the entire launcher.
 *
 * The id is the app's to mint, so the shell WATCHES for it, as the Gemini window watches
 * for a conversation URL. Every session, desktop or CLI, writes its transcript to
 * `~/.claude/projects/<slug>/<uuid>.jsonl` from its first message onwards — so the first
 * transcript to appear for OUR folder after the link opened is this session, and its
 * filename is the id. Nobody copies anything.
 */

const projectsDir = () => path.join(os.homedir(), ".claude", "projects");

/** How long the shell keeps waiting for a session's first message. */
const CLAUDE_WATCH_MS = 15 * 60 * 1000;
const CLAUDE_POLL_MS = 500;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A folder as Claude Code will record it: `~` expanded, and every symlink resolved. The
 * resolution is the load-bearing half — Claude Code files a session under the REAL path, so
 * a vault reached through a link (`/tmp`, a symlinked home, a folder under one) would file
 * its transcript somewhere the watch below was not looking, and no id would ever come back.
 */
function realFolder(folder) {
  const expanded = String(folder).replace(/^~(?=$|\/)/, os.homedir());
  try {
    return fs.realpathSync(expanded);
  } catch {
    return expanded; // not there; the caller reports that in its own words
  }
}

/** Every transcript on this machine, newest touched first. */
function transcripts() {
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsDir(), { withFileTypes: true });
  } catch {
    return []; // Claude Code has never run here
  }
  const out = [];
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsDir(), entry.name);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      try {
        out.push({ file, id: name.slice(0, -".jsonl".length), at: fs.statSync(file).mtimeMs });
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * The folder a session ran in, read out of its transcript — the head of the file carries
 * `cwd`. Read rather than decoded from the directory name, because that encoding turns
 * `/`, `.`, `_` and spaces all into `-` and cannot be reversed. Only the head is read;
 * transcripts run to megabytes.
 */
function headLines(file, bytes = 64 * 1024) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      return buffer
        .subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0))
        .toString("utf8")
        .split("\n");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function transcriptCwd(file) {
  for (const line of headLines(file)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.cwd === "string" && entry.cwd) return entry.cwd;
    } catch {
      /* the read cut a line in half, or a transcript still being written */
    }
  }
  return null;
}

/*
 * The folder Claude Code last worked in. The newest TRANSCRIPT's own `cwd`, not the
 * newest directory: appending to a transcript does not touch the folder it sits in, so
 * directory timestamps answer a different question. A folder that has since been moved
 * away is skipped rather than handed back for the Claude app to choke on.
 */
ipcMain.handle("claude-folder", () => {
  for (const session of transcripts().slice(0, 40)) {
    const cwd = transcriptCwd(session.file);
    try {
      if (cwd && fs.statSync(cwd).isDirectory()) return cwd;
    } catch {
      /* that folder is gone; try the session before it */
    }
  }
  return null;
});

/**
 * The folders Claude Code has worked in lately, most recent first — what a session note
 * offers to choose from. "The last one" on its own is a bad guess: the most recent folder
 * is whatever anything else happened to touch, which is rarely the one this note is about.
 */
ipcMain.handle("claude-folders", (_event, limit = 8) => {
  const out = [];
  const seen = new Set();
  for (const session of transcripts().slice(0, 120)) {
    if (out.length >= limit) break;
    const cwd = transcriptCwd(session.file);
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    try {
      if (fs.statSync(cwd).isDirectory()) out.push(cwd);
    } catch {
      /* moved away since */
    }
  }
  return out;
});

/** When a session's first turn was, from the head of its transcript. */
function firstTurnAt(file) {
  for (const line of headLines(file)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if ((entry.type === "assistant" || entry.type === "user") && entry.timestamp) {
      return Date.parse(entry.timestamp) || 0;
    }
  }
  return 0;
}

/**
 * The transcripts that could belong to `dir`. Claude Code files them under a directory
 * named for the folder, so that one directory is the fast path — but the name is a lossy
 * encoding, so a miss falls back to reading every transcript's `cwd`. Either way the caller
 * checks `cwd` itself before believing anything.
 */
function transcriptsFor(dir) {
  const slug = path.join(projectsDir(), dir.replace(/[^A-Za-z0-9]/g, "-"));
  let names = [];
  try {
    names = fs.readdirSync(slug);
  } catch {
    return transcripts(); // no such directory — sweep the lot and match on cwd
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(slug, name);
    try {
      out.push({ file, id: name.slice(0, -".jsonl".length), at: fs.statSync(file).mtimeMs });
    } catch {
      /* vanished mid-walk */
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Enough about a session to recognise it in a list: where it ran, what was first said in it,
 * and the title the app gave it. Titles are rewritten as a session goes on and land at the
 * END of the transcript, so they come from the tail while the folder and the opening line
 * come from the head.
 */
function sessionSummary(session) {
  let cwd = null;
  let first = "";
  for (const line of headLines(session.file)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;
    if (!first && entry.type === "user" && entry.timestamp) {
      const content = entry.message && entry.message.content;
      if (typeof content === "string") first = content;
      else if (Array.isArray(content)) {
        first = content
          .filter((part) => part && part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join(" ");
      }
    }
    if (cwd && first) break;
  }
  let custom = "";
  let derived = "";
  for (const line of tailLines(session.file, 32 * 1024)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") custom = entry.customTitle;
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") derived = entry.aiTitle;
  }
  return {
    id: session.id,
    folder: cwd ?? "",
    title: (custom || derived || first).replace(/\s+/g, " ").trim().slice(0, 70),
    at: session.at,
  };
}

/*
 * The sessions on this machine, most recently touched first. This is what "plug in a session"
 * chooses from — and it is the only way to point a note at a session that is certain, since
 * nothing is sent on a note's behalf for the guessing below to match on. Choosing beats
 * inferring whenever somebody is there to choose.
 */
ipcMain.handle("claude-sessions", (_event, limit = 14) => {
  const out = [];
  for (const session of transcripts()) {
    if (out.length >= limit) break;
    const summary = sessionSummary(session);
    if (!summary.folder) continue; // not a transcript we can say anything useful about
    out.push(summary);
  }
  return out;
});

/** How long after opening the link a new session in that folder could still be ours. */
const ADOPT_WINDOW_MS = 2 * 60 * 60 * 1000;

/*
 * The session a note is waiting for, found on disk instead of caught in flight — which is
 * what makes catching the id survive everything the watch below cannot: clicking the node
 * twice, reloading the window, quitting the app while a session was being started.
 *
 * Nothing is sent to Claude on the note's behalf, so there is no fingerprint to match on:
 * the only evidence is that a session appeared in this folder shortly after the note asked
 * for one. So this REFUSES TO GUESS. One candidate in the window is the answer; two or more
 * and it returns them without choosing, because binding a note to somebody else's session is
 * far worse than leaving it unbound — a wrong id looks exactly as healthy as a right one.
 */
ipcMain.handle("claude-adopt", (_event, folder, since) => {
  const dir = realFolder(folder);
  const from = Date.parse(String(since));
  if (!Number.isFinite(from)) return { id: null, candidates: [] };
  const candidates = [];
  for (const session of transcriptsFor(dir)) {
    if (transcriptCwd(session.file) !== dir) continue;
    const at = firstTurnAt(session.file);
    if (!at || at < from || at > from + ADOPT_WINDOW_MS) continue;
    candidates.push({ id: session.id, at });
  }
  candidates.sort((a, b) => a.at - b.at);
  const ids = candidates.map((c) => c.id);
  return { id: ids.length === 1 ? ids[0] : null, candidates: ids };
});

/** One watch per folder: starting another session there abandons the older wait. */
const claudeWatch = new Map();

/**
 * Resolves with the id of the session the Claude app just opened, or null if nothing was
 * ever sent in it (the counterpart of closing the Gemini window before chatting). A
 * session exists on disk only from its first message, so this waits for a transcript that
 * was not there when the link opened AND ran in our folder; the filename is the id.
 */
function watchForSession(dir, before) {
  claudeWatch.get(dir)?.(null); // an older wait on this folder is moot now
  return new Promise((resolve) => {
    const started = Date.now();
    const settle = (id) => {
      clearInterval(timer);
      if (claudeWatch.get(dir) === settle) claudeWatch.delete(dir);
      resolve(id);
    };
    const timer = setInterval(() => {
      for (const session of transcriptsFor(dir)) {
        if (before.has(session.file)) continue;
        if (transcriptCwd(session.file) === dir) {
          settle(session.id);
          return;
        }
      }
      if (Date.now() - started > CLAUDE_WATCH_MS) settle(null);
    }, CLAUDE_POLL_MS);
    claudeWatch.set(dir, settle);
  });
}

/*
 * Opens a session in the folder, and NOTHING ELSE — no prompt, no title, nothing put in
 * Claude's mouth on the note's behalf. The composer is left empty for whoever asked for it.
 * (`code/new` does take a `q`, and using it would give adoption an exact fingerprint to
 * match on; that is a cost paid in the wrong currency.)
 */
ipcMain.handle("claude-start", async (_event, folder) => {
  const dir = realFolder(folder);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`${dir} is not a folder on this machine`);
  }
  const link = new URL("claude://code/new");
  link.searchParams.set("folder", dir);
  // Snapshot BEFORE the link opens, or the session we are about to start could be
  // mistaken for one that was already there.
  const before = new Set(transcripts().map((session) => session.file));
  await shell.openExternal(link.toString());
  return watchForSession(dir, before);
});

/** Where the Claude app keeps its own record of every session it shows. */
const appSessionsDir = () => path.join(app.getPath("appData"), "Claude", "claude-code-sessions");

/**
 * The Claude app's OWN id for a session, found by the transcript it points at.
 *
 * The app keys its sessions by an id it mints itself and records the transcript's id beside
 * it as `cliSessionId` — so the transcript id has to be translated before the app can be
 * pointed anywhere. Among the records for one transcript (an import leaves a second,
 * hollow one behind), the one with the newest activity is the session as the user knows it.
 */
/** Walks every session record the Claude app keeps, calling `fn` on each. */
function eachAppRecord(fn) {
  const root = appSessionsDir();
  let accounts = [];
  try {
    accounts = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // the app has never kept a session here
  }
  for (const account of accounts) {
    if (!account.isDirectory()) continue;
    const accountDir = path.join(root, account.name);
    let spaces = [];
    try {
      spaces = fs.readdirSync(accountDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const space of spaces) {
      if (!space.isDirectory()) continue;
      const spaceDir = path.join(accountDir, space.name);
      let files = [];
      try {
        files = fs.readdirSync(spaceDir);
      } catch {
        continue;
      }
      for (const name of files) {
        if (!name.endsWith(".json")) continue;
        let record;
        try {
          record = JSON.parse(fs.readFileSync(path.join(spaceDir, name), "utf8"));
        } catch {
          continue;
        }
        fn(record);
      }
    }
  }
}

function appSessionId(id) {
  let best = null;
  eachAppRecord((record) => {
    if (record.cliSessionId !== id || record.isArchived) return;
    if (typeof record.sessionId !== "string") return;
    const at = Number(record.lastActivityAt) || 0;
    if (!best || at > best.at) best = { sessionId: record.sessionId, at };
  });
  return best && best.sessionId;
}

/**
 * When the Claude app last had each session on its own screen — `lastFocusedAt`, the
 * stamp the app writes on a record whenever its view comes up. This is how the graph
 * learns that a finished turn HAS been read even though it was read in the app rather
 * than through a node: the note's `seen::` only moves when the graph does the opening.
 */
function appFocus(wanted) {
  const out = new Map();
  eachAppRecord((record) => {
    const id = record.cliSessionId;
    if (typeof id !== "string" || !wanted.has(id)) return;
    const at = Number(record.lastFocusedAt) || 0;
    if (at > (out.get(id) || 0)) out.set(id, at);
  });
  return out;
}

/*
 * Opens a session in the Claude app — THE session, not a copy.
 *
 * `claude://claude.ai/claude-code-desktop/<app id>` loads that path in the app's window and
 * the web app routes it to the session view. It is the one deep link that reaches an
 * existing local session (`resume` imports a duplicate; `epitaxy` links are dropped; the
 * `code` host only admits remote ids) — found by elimination, then proven twice over with
 * the focus stamp the app writes on the record when its view comes up: once on a live
 * session, once on one that had sat untouched for over an hour.
 *
 * A session the app has never seen — born in a terminal, no record — cannot be navigated
 * to; importing is the app's own door for those, and it is taken exactly once, since from
 * then on the session has a record.
 */
ipcMain.handle("claude-open", async (_event, session) => {
  const id = String(session);
  if (!SESSION_ID.test(id)) throw new Error(`${id} is not a session id`);
  const record = appSessionId(id);
  if (record) {
    await shell.openExternal(`claude://claude.ai/claude-code-desktop/${encodeURIComponent(record)}`);
    return "opened";
  }
  await shell.openExternal(`claude://resume?session=${id}`);
  return "imported";
});

/*
 * What a session is DOING, read off the tail of its transcript. Claude Code appends one
 * JSON line per turn, so the last line with a timestamp on it says who spoke last — and
 * that is the whole state machine:
 *
 *   assistant, ending in a tool_use   a tool is running, OR its permission prompt is
 *                                     sitting there unanswered. Both are the same line in
 *                                     the file, and only the clock tells them apart: fresh
 *                                     is work, gone quiet is a question.
 *   user                              a prompt (or a tool's result) just landed, so Claude
 *                                     has the floor — until minutes pass, which means the
 *                                     session was interrupted rather than answered.
 *   assistant, ending in text         the turn is over. There is something to read.
 *
 * The Claude app is never asked anything: a transcript on disk is the one account of a
 * session that is true whether the app is running, backgrounded, or shut.
 */

/** Tools that always hand the floor to a person, however fresh the line is. */
const HUMAN_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

/** Longer than this without a result and a tool_use is a prompt nobody has answered. */
const TOOL_GRACE_MS = 25 * 1000;
/** A turn Claude never came back from: interrupted, or the app was quit under it. */
const STALE_MS = 5 * 60 * 1000;

/** The last bytes of a file, whole lines only — transcripts run to megabytes. */
function tailLines(file, bytes = 96 * 1024) {
  try {
    const { size } = fs.statSync(file);
    const from = Math.max(0, size - bytes);
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(bytes, size));
      const read = fs.readSync(fd, buffer, 0, buffer.length, from);
      const text = buffer.subarray(0, read).toString("utf8");
      // A read that started mid-file almost certainly started mid-line: drop that one.
      return (from > 0 ? text.slice(text.indexOf("\n") + 1) : text).split("\n");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

/** Who spoke last: the final line carrying a timestamp, titles and bookkeeping skipped. */
function lastTurn(file) {
  const lines = tailLines(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // a line still being written
    }
    if ((entry.type === "assistant" || entry.type === "user") && entry.timestamp) return entry;
  }
  return null;
}

function sessionState(file) {
  const turn = lastTurn(file);
  if (!turn) return { state: "idle", at: 0 };
  const at = Date.parse(turn.timestamp) || 0;
  const age = Date.now() - at;
  const content = turn.message && turn.message.content;
  const parts = Array.isArray(content) ? content : [];
  const last = parts[parts.length - 1];
  if (turn.type === "assistant" && last && last.type === "tool_use") {
    if (HUMAN_TOOLS.has(last.name)) return { state: "waiting", at };
    return { state: age > TOOL_GRACE_MS ? "waiting" : "running", at };
  }
  if (turn.type === "assistant") return { state: "done", at };
  return { state: age > STALE_MS ? "idle" : "running", at };
}

/**
 * The state of each session asked about, keyed by id: `{ state, at, focus }`, where `at`
 * is when its last turn was and `focus` is when the Claude app last showed it (0 if
 * never). Whether "done" is worth a badge is the renderer's call — between the note's
 * own `seen::` and `focus`, it knows how much of the session has been looked at.
 */
ipcMain.handle("claude-status", (_event, ids) => {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
  const out = {};
  if (!wanted.size) return out;
  const focus = appFocus(wanted);
  for (const session of transcripts()) {
    if (!wanted.has(session.id) || out[session.id]) continue;
    out[session.id] = { ...sessionState(session.file), focus: focus.get(session.id) || 0 };
  }
  return out;
});

app.whenReady().then(() => {
  protocol.handle("app", serve);
  if (process.platform === "darwin" && !app.isPackaged && fs.existsSync(DEV_ICON)) {
    app.dock.setIcon(DEV_ICON);
  }
  // Session-wide user agent for the gemini partition: every request — first page,
  // redirects, sign-in popups — reads as plain Chrome, or Google blocks the login.
  const gemini = session.fromPartition(GEMINI_PARTITION);
  gemini.setUserAgent(
    gemini
      .getUserAgent()
      .replace(/\sElectron\/\S+/, "")
      .replace(new RegExp(`\\s${app.getName()}/\\S+`), ""),
  );
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closing the LAST window quits, so "off" stays unambiguous however many projects were up.
app.on("window-all-closed", () => app.quit());
