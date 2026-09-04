// Standalone desktop shell. Serves the built app over a custom `app://` scheme
// rather than file:// — a real origin is what makes localStorage and the File
// System Access API ("Open folder…") work.

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, safeStorage, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// The app menu, the About item and the alerts all say whatever the app is called, and
// run from the repo that is "Electron" — the name belongs to the binary until something
// claims it. Said here rather than left to the packaged build, so `electron .` is Bedrock
// too. Must be before `ready`: the menu is built from the name once.
app.setName("Bedrock");

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

/** One Bedrock window's options — the first one's, and every one the app opens of itself. */
const windowOptions = () => ({
  width: 1280,
  height: 820,
  minWidth: 720,
  minHeight: 460,
  title: "Bedrock",
  backgroundColor: "#1e1e1e",
  ...(process.platform !== "darwin" && !app.isPackaged ? { icon: DEV_ICON } : {}),
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    preload: path.join(__dirname, "preload.cjs"),
  },
});

/**
 * What a `window.open` from the renderer is allowed to do. http(s) links in notes belong
 * in the real browser, not in this window. The app's own address is the one thing it may
 * open a window of: a vault node opens its vault in a second Bedrock window, and hands it
 * the folder over `postMessage` — which is why the renderer has to open it itself rather
 * than ask the shell to (the handle can only travel between two windows that know each
 * other).
 */
function openHandler({ url }) {
  if (/^https?:/.test(url)) {
    void shell.openExternal(url);
    return { action: "deny" };
  }
  if (url.startsWith("app://-/")) {
    return { action: "allow", overrideBrowserWindowOptions: windowOptions() };
  }
  return { action: "deny" };
}

function createWindow() {
  const win = new BrowserWindow(windowOptions());
  win.webContents.setWindowOpenHandler(openHandler);
  // A window the renderer opened is a Bedrock window too, and gets the same rules.
  win.webContents.on("did-create-window", (child) => child.webContents.setWindowOpenHandler(openHandler));
  void win.loadURL("app://-/");
}

/*
 * WHICH VAULT IS IN WHICH WINDOW.
 *
 * Only the renderer knows: a window's address carries `?root=` when it was opened for a
 * folder, but File > Open Vault… changes the vault without changing the address, and a
 * handle-backed vault has no path at all. So each window says what it has open (see
 * `window-root`) and this is the answer to "is that vault already on screen somewhere".
 *
 * What it is for: opening the vault behind a node used to mean a new window every time,
 * even when that vault was already open in one — and on a Mac, a new window opened from a
 * full-screen one lands on its own space, which throws the person out of what they were
 * looking at. With this the renderer can raise the window that already has it, or open the
 * vault in place.
 */
const vaultRoots = new Map(); // webContents id -> the absolute folder that window has open

const normalRoot = (root) => (typeof root === "string" && root ? path.resolve(root) : null);

ipcMain.handle("window-root", (event, root) => {
  const id = event.sender.id;
  const at = normalRoot(root);
  if (at) vaultRoots.set(id, at);
  else vaultRoots.delete(id);
  // A window that has gone takes its claim with it, or a closed vault goes on looking open.
  event.sender.once("destroyed", () => vaultRoots.delete(id));
  return true;
});

ipcMain.handle("window-state", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return {
    // macOS native full screen, and the same flag on Windows/Linux. `isMaximized` is NOT
    // this: a maximised window still opens a second window beside it, which is fine.
    fullScreen: !!win && win.isFullScreen(),
    windows: BrowserWindow.getAllWindows().map((other) => ({
      id: other.webContents.id,
      root: vaultRoots.get(other.webContents.id) ?? null,
      self: !!win && other.id === win.id,
    })),
  };
});

/**
 * Brings one window forward, and optionally tells it which note to land on — the same
 * thing `?focus=` does for a window being opened. False when that window has gone in the
 * meantime, which the caller answers by opening the vault the ordinary way.
 */
ipcMain.handle("window-show", (event, id, focus) => {
  const target = BrowserWindow.getAllWindows().find((win) => win.webContents.id === id);
  if (!target || target.isDestroyed()) return false;
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  if (focus) target.webContents.send("goto", focus);
  return true;
});

/*
 * The standard menus, plus File > New Window: one bedrock window per project. A new
 * window comes up on the local vault like a first launch does — "Open folder…" then
 * points it at whichever project it is for, and each folder keeps its own arrangement,
 * settings and integrations (they live in the vault, not the window).
 */
function buildMenu() {
  // The renderer's chrome is gone — the graph is the whole window — so what used to be
  // sidebar buttons lives up here: Settings under the app's own name (⌘, as every Mac
  // app), and the vault opener under File.
  const tell = (what) => (_item, win) => {
    const target = win || BrowserWindow.getFocusedWindow();
    if (target) target.webContents.send("menu", what);
  };
  const settingsItem = { label: "Settings…", accelerator: "CmdOrCtrl+,", click: tell("settings") };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin"
        ? [
            {
              label: app.name,
              submenu: [
                { role: "about" },
                { type: "separator" },
                settingsItem,
                { type: "separator" },
                { role: "services" },
                { type: "separator" },
                { role: "hide" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit" },
              ],
            },
          ]
        : []),
      {
        label: "File",
        submenu: [
          { label: "Open Vault…", accelerator: "CmdOrCtrl+O", click: tell("open-vault") },
          { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => createWindow() },
          ...(process.platform === "darwin" ? [] : [{ type: "separator" }, settingsItem]),
          { type: "separator" },
          { role: process.platform === "darwin" ? "close" : "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

/*
 * The environment a git command runs in. Two things a GUI app gets wrong on its own:
 *
 * PATH — a process launched by the OS never sourced a shell profile, so a git that lives in
 * Homebrew's bin is simply not findable. `loginPath()` is the same answer the terminal has.
 *
 * Prompting — git asking "Username for https://github.com:" on a process with no terminal
 * waits forever with nothing on screen to answer, which is the worst possible failure: the
 * button never comes back. Turning every prompt off turns each of those hangs into an error
 * we can show. `BatchMode=yes` does the same for ssh's host-key and passphrase questions.
 */
const gitEnv = () => {
  const env = { ...process.env, PATH: loginPath(), GIT_TERMINAL_PROMPT: "0" };
  // A graphical askpass would pop its own dialog behind the app instead of failing.
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  env.GIT_SSH_COMMAND = `${process.env.GIT_SSH_COMMAND || "ssh"} -o BatchMode=yes`;
  return env;
};

/** Runs one git command in `cwd`; a non-zero exit rejects with whatever git said. */
const git = (cwd, ...args) =>
  new Promise((resolve, reject) => {
    const options = { cwd, env: gitEnv(), timeout: 120000, maxBuffer: 8 * 1024 * 1024 };
    execFile("git", args, options, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.trim());
      if (err.code === "ENOENT") return reject(new Error("git is not installed on this machine"));
      if (err.killed) return reject(new Error("git gave up after two minutes — is the network there?"));
      reject(new Error((stderr || stdout || err.message).trim()));
    });
  });

/** Vault paths are typed by hand, so `~` is a real thing that arrives here. */
const vaultDir = (root) => {
  const dir = String(root || "").replace(/^~(?=$|\/)/, os.homedir());
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`${dir || "(nowhere)"} is not a folder on this machine`);
  }
  return dir;
};

/** Whether a git command succeeds at all, for the several questions shaped that way. */
const gitOk = (cwd, ...args) => git(cwd, ...args).then(() => true, () => false);

/*
 * Whether git's idea of the repository root is this very folder.
 *
 * Two traps, both of which would have us commit somebody else's repository. A vault sitting
 * inside a bigger checkout answers `--show-toplevel` with the checkout's root, not its own,
 * so the paths must be compared rather than the question merely being asked. And on macOS
 * `/tmp` and `/var` are symlinks, so a typed path and git's answer can name the same folder
 * in different words — `realpath` is what makes those compare equal.
 */
const sameDir = (a, b) => {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
};

/** The repository whose root is exactly `dir`, or null if this folder is not one. */
const ownRepo = async (dir) => {
  const top = await git(dir, "rev-parse", "--show-toplevel").catch(() => null);
  return top && sameDir(top, dir) ? top : null;
};

/*
 * Everything the settings page can say about the vault's repository, asked of git rather
 * than remembered. All of it is read-only and none of it throws for the ordinary "there is
 * no repository here yet" answers — a page that cannot render because the vault is not a
 * repo would be reporting the one state it most needs to report.
 */
ipcMain.handle("git-status", async (_event, root) => {
  const dir = vaultDir(root);
  const blank = {
    installed: true,
    repo: false,
    branch: null,
    changes: 0,
    lastCommit: null,
    origin: null,
    identity: null,
    upstream: false,
    ahead: 0,
    behind: 0,
  };
  // `--version` is the cheapest question there is, and the only one worth asking first.
  try {
    await git(dir, "--version");
  } catch (err) {
    if (/not installed/.test(err.message)) return { ...blank, installed: false };
    throw err;
  }
  if (!(await ownRepo(dir))) return blank;

  const [name, email, origin, porcelain, branch] = await Promise.all([
    git(dir, "config", "user.name").catch(() => ""),
    git(dir, "config", "user.email").catch(() => ""),
    git(dir, "remote", "get-url", "origin").catch(() => ""),
    git(dir, "status", "--porcelain").catch(() => ""),
    // `--show-current` rather than `rev-parse`, which on a repo with no commits yet fails
    // and prints the word HEAD, so its answer cannot be told from a detached one.
    git(dir, "branch", "--show-current").catch(() => ""),
  ]);
  const born = await gitOk(dir, "rev-parse", "--verify", "HEAD");
  const lastCommit = born ? await git(dir, "log", "-1", "--format=%h — %s").catch(() => null) : null;
  // `left...right` counts each side's own commits: behind first, then ahead.
  const counts = born
    ? await git(dir, "rev-list", "--left-right", "--count", "@{upstream}...HEAD").catch(() => null)
    : null;
  const [behind, ahead] = (counts || "").split(/\s+/).map(Number);

  return {
    installed: true,
    repo: true,
    branch: branch || null,
    changes: porcelain ? porcelain.split("\n").filter(Boolean).length : 0,
    lastCommit,
    origin: origin || null,
    identity: name && email ? `${name} <${email}>` : null,
    upstream: counts !== null,
    ahead: ahead || 0,
    behind: behind || 0,
  };
});

/*
 * The whole git integration: stage everything, commit. First use in a folder that is
 * not a repository initialises one — "turn git on" should not require a terminal.
 */
ipcMain.handle("git-commit", async (_event, root) => {
  const dir = vaultDir(root);
  const fresh = !(await ownRepo(dir));
  if (fresh) await git(dir, "init");
  // Asked before staging, because git's own answer to this is four paragraphs of advice
  // about a machine-wide setting, and by then it has already stashed everything in place.
  const [name, email] = await Promise.all([
    git(dir, "config", "user.name").catch(() => ""),
    git(dir, "config", "user.email").catch(() => ""),
  ]);
  if (!name || !email) {
    throw new Error(
      "git does not know who you are on this machine — run " +
        `git config --global user.${!name ? "name" : "email"} "…" once, then commit`,
    );
  }
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
 * Push what has been committed to a GitHub remote. The URL is a choice the vault made and
 * hands in; who you are and the token or key that lets you in are the machine's own git's
 * business, exactly as they are for a commit — so there is nothing secret here, and a
 * machine that cannot reach GitHub fails with git's own words rather than ours.
 *
 * `origin` is set to whatever URL came in (added the first time, repointed after that), so
 * changing the remote in settings just works. The push is `-u … HEAD`, which names the
 * branch after itself upstream and covers the empty-repo first push without a special case.
 */
ipcMain.handle("git-push", async (_event, root, remote) => {
  const dir = vaultDir(root);
  const url = String(remote || "").trim();
  if (!url) throw new Error("no remote set — add a GitHub URL first");
  if (!(await ownRepo(dir))) throw new Error("no repository here yet — commit before pushing");
  // A repository with no commits has nothing to push, and git's own words for it
  // ("src refspec HEAD does not match any") say nothing about what to do instead.
  if (!(await gitOk(dir, "rev-parse", "--verify", "HEAD"))) {
    throw new Error("nothing committed yet — commit before pushing");
  }
  const hasOrigin = await gitOk(dir, "remote", "get-url", "origin");
  await git(dir, "remote", hasOrigin ? "set-url" : "add", "origin", url);
  const branch = await git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  try {
    await git(dir, "push", "-u", "origin", "HEAD");
  } catch (err) {
    throw new Error(pushAdvice(err.message));
  }
  return `pushed ${branch} to ${url}`;
});

/*
 * Git's push failures are the ones a person is least equipped to act on: the remote's
 * refusal arrives as a wall of hints about refspecs and credential helpers. These three
 * cover everything seen in practice from a vault — the repo already has a commit in it,
 * the credentials are not on this machine, or the URL is wrong — and each says the thing
 * to actually do. Anything else is handed on in git's own words, which is the right
 * default: better an unfamiliar message than a wrong friendly one.
 */
function pushAdvice(message) {
  if (/\bnon-fast-forward\b|\brejected\b|fetch first/i.test(message)) {
    return "the remote has commits this vault does not — press Pull first, then push";
  }
  return remoteAdvice(message);
}

/** The two ways any remote command fails that are about the machine, not the branch. */
function remoteAdvice(message) {
  if (/could not read (Username|Password)|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)|BatchMode|Host key verification/i.test(message)) {
    return (
      "this machine's git cannot authenticate to the remote. Set it up once outside " +
      "Bedrock — an ssh key (ssh-keygen, then add it on GitHub) or gh auth login — and " +
      "it works from here on. No token is kept in the vault."
    );
  }
  if (/Repository not found|does not appear to be a git repository|not found|Could not resolve host/i.test(message)) {
    return "the remote refused that URL — check the repository exists and that your git account can write to it";
  }
  return message;
}

/*
 * Bring the remote's commits down. This exists because without it the loop does not close:
 * a repository made on GitHub with a README, or a vault edited from a second machine, leaves
 * push refused forever and the only way out is a terminal.
 *
 * Rebase rather than merge, so a vault's history stays a line of snapshots rather than a
 * braid. Two guards make it safe to press without thinking, which is the whole point:
 *
 *  - Uncommitted work is refused up front. Rebase would demand that anyway, and its own way
 *    of saying so ("cannot pull with rebase: You have unstaged changes") reads as a fault.
 *  - A rebase that stops on a conflict is aborted. Leaving a notes vault mid-rebase — files
 *    full of conflict markers, HEAD detached, no terminal in sight — is far worse than not
 *    having pulled, so this either lands cleanly or leaves the vault exactly as it was.
 */
ipcMain.handle("git-pull", async (_event, root, remote) => {
  const dir = vaultDir(root);
  const url = String(remote || "").trim();
  if (!url) throw new Error("no remote set — add a GitHub URL first");
  if (!(await ownRepo(dir))) throw new Error("no repository here yet — commit before pulling");
  if (await git(dir, "status", "--porcelain")) {
    throw new Error("there is uncommitted work in the vault — commit it first, then pull");
  }
  const hasOrigin = await gitOk(dir, "remote", "get-url", "origin");
  await git(dir, "remote", hasOrigin ? "set-url" : "add", "origin", url);
  try {
    await git(dir, "fetch", "origin");
  } catch (err) {
    throw new Error(remoteAdvice(err.message));
  }
  const branch = (await git(dir, "branch", "--show-current").catch(() => "")) || "HEAD";
  // A remote that has never heard of this branch has nothing to send, and git's way of
  // saying so ("couldn't find remote ref main") sounds like a fault rather than an answer.
  if (!(await gitOk(dir, "rev-parse", "--verify", `refs/remotes/origin/${branch}`))) {
    return `the remote has no ${branch} yet — push to create it`;
  }
  const before = await git(dir, "rev-parse", "HEAD").catch(() => null);
  try {
    await git(dir, "pull", "--rebase", "origin", branch);
  } catch (err) {
    await git(dir, "rebase", "--abort").catch(() => {});
    if (/conflict/i.test(err.message)) {
      throw new Error(
        "the remote's version of some notes clashes with this vault's. Nothing here was " +
          `changed — sort it out in a terminal (git pull --rebase origin ${branch})`,
      );
    }
    if (/would be overwritten/i.test(err.message)) {
      throw new Error(
        "the remote has files this vault also has, uncommitted — commit them first, then " +
          "pull, so git has two versions to reconcile rather than one to overwrite",
      );
    }
    throw new Error(remoteAdvice(err.message));
  }
  const after = await git(dir, "rev-parse", "HEAD").catch(() => null);
  return before === after
    ? "already up to date with the remote"
    : `pulled the remote's ${branch} in — now at ${await git(dir, "log", "-1", "--format=%h — %s")}`;
});

/*
 * Files and folders on this machine. The renderer names nothing itself: the OS's own
 * picker chooses (its New Folder button covers creating one), and the OS's own opener
 * opens — the default app for a file, Finder/Explorer for a folder. Both dialogs and
 * both openers behave the same on macOS and Windows, which is the whole point of
 * going through the shell for this.
 */
/** Paths are typed by hand and remembered, so `~` is a real thing that arrives here. */
const expandHome = (p) => String(p).replace(/^~(?=$|\/)/, os.homedir());

ipcMain.handle("fs-pick", async (event, kind, options = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    properties:
      kind === "folder"
        ? // `createDirectory` puts the New Folder button in the macOS sheet; Windows'
          // folder picker has one of its own without being asked.
          ["openDirectory", "createDirectory"]
        : ["openFile"],
    // Where the sheet opens: a vault's own folder, so the folders above it are one step
    // up — which is the one direction the renderer's folder handle can never look.
    ...(options.defaultPath ? { defaultPath: expandHome(options.defaultPath) } : {}),
    ...(options.filters ? { filters: options.filters } : {}),
    ...(options.title ? { title: options.title } : {}),
    ...(options.message ? { message: options.message } : {}),
  });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});

/**
 * A vault by its PATH — how a window opened from a reference reaches a vault the folder
 * picker never handed it: a parent, a sibling, any folder on the disk. The same operations
 * the renderer's own folder vault does over its handle, done here over the disk. `root` is
 * absolute; paths are "/"-relative to it, and nothing outside it is ever touched.
 */
const VAULT_IMAGES = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
ipcMain.handle("vault-fs", async (_event, root, op, rel, arg) => {
  const base = path.resolve(expandHome(root));
  const at = (p) => {
    const full = path.resolve(base, ...String(p ?? "").split("/").filter(Boolean));
    if (full !== base && !full.startsWith(base + path.sep)) throw new Error(`${p} is outside the vault`);
    return full;
  };
  const posix = (p) => path.relative(base, p).split(path.sep).join("/");
  switch (op) {
    case "scan": {
      // One walk, both listings, as the folder vault does: notes and folders for the app,
      // images for the embeds, the app's own dot-folders for neither.
      const entries = [];
      const assets = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            entries.push({ path: posix(full), kind: "dir" });
            walk(full);
          } else if (/\.md$/i.test(entry.name)) entries.push({ path: posix(full), kind: "file" });
          else if (VAULT_IMAGES.test(entry.name)) assets.push(posix(full));
        }
      };
      walk(base);
      return { entries, assets };
    }
    case "list": {
      // Markdown directly in one folder, hidden folders included — `.notes/edges/`.
      const dir = at(rel);
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
          .map((entry) => posix(path.join(dir, entry.name)));
      } catch {
        return [];
      }
    }
    case "exists":
      return fs.existsSync(at(rel));
    case "read":
      return fs.readFileSync(at(rel), "utf8");
    case "read-many": {
      // The whole graph's worth of notes in one round trip. One that cannot be read — a
      // symlink to nowhere, a permission — comes back null rather than failing the rest.
      const out = {};
      for (const one of arg) {
        try {
          out[one] = fs.readFileSync(at(one), "utf8");
        } catch {
          out[one] = null;
        }
      }
      return out;
    }
    case "write": {
      const file = at(rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, String(arg ?? ""));
      return true;
    }
    case "mkdir":
      fs.mkdirSync(at(rel), { recursive: true });
      return true;
    case "create": {
      const file = at(rel);
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, String(arg ?? ""));
      }
      return true;
    }
    case "remove":
      fs.rmSync(at(rel), { recursive: arg === "dir", force: true });
      return true;
    case "rename": {
      const to = at(arg);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(at(rel), to);
      return true;
    }
    case "read-bin":
      try {
        return new Uint8Array(fs.readFileSync(at(rel)));
      } catch {
        return null;
      }
    case "write-bin": {
      const file = at(rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(arg));
      return true;
    }
    default:
      throw new Error(`unknown vault operation ${op}`);
  }
});

/**
 * A vault is a folder Bedrock has kept its own state in: a `.notes/` folder — the
 * arrangement lands there the first time the graph is touched, the config only once a
 * setting is changed, so the folder is the test and not either file.
 */
const isVaultDir = (dir) => {
  try {
    return fs.statSync(path.join(dir, ".notes")).isDirectory();
  } catch {
    return false;
  }
};



/**
 * What a note anywhere on this disk is, before anything is made of it: its name, its
 * `type::` line, the nearest vault above it, and where it sits inside `root` when it does.
 * Asked after the OS dialog has answered with a path. Looking UP the folders is the one
 * thing a folder handle cannot do, and this is where it happens instead. Null when the
 * file is not there or cannot be read.
 */
ipcMain.handle("note-peek", async (_event, target, root) => {
  const file = path.resolve(expandHome(target)); // a `..` written into a note is not carried any further
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const type = /^type::[ \t]*([\w-]+)[ \t]*$/im.exec(text)?.[1].toLowerCase() ?? null;
  // Up, folder by folder, to the nearest one that is a vault; the disk's own root ends it.
  let vault = null;
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (isVaultDir(dir)) {
      vault = dir;
      break;
    }
    if (path.dirname(dir) === dir) break;
  }
  // Inside the root asked about, or not — through real paths, so a symlinked folder and
  // the folder it stands for count as the same place ("/tmp" is one, see `sameDir`).
  let relative = null;
  if (root) {
    const real = (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    const rel = path.relative(real(expandHome(root)), real(file));
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) relative = rel.split(path.sep).join("/");
  }
  return { name: path.basename(file).replace(/\.md$/i, ""), type, vault, relative };
});

/**
 * The search index: every note in the whole system of vaults `root` is part of, by name
 * and place. Up first, parent by parent, for as long as each parent is a vault itself —
 * the last one that is, is the top of the system. Then down from the top: every folder
 * that is not the app's own, every markdown file. Names only, nothing read: twenty
 * thousand notes walk in about twenty milliseconds, so the index is made fresh each time
 * it is asked for rather than kept anywhere. `relative` is a note's path inside `root`,
 * for the ones that are in it — those are on the asker's own canvas already.
 */
ipcMain.handle("vault-index", async (_event, root) => {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const start = real(expandHome(root));
  let top = start;
  for (let dir = path.dirname(start); isVaultDir(dir) && path.dirname(dir) !== dir; dir = path.dirname(dir)) top = dir;
  const posix = (p) => p.split(path.sep).join("/");
  const notes = [];
  // `nested`: the folder is a vault of its own INSIDE the asker's — its notes are in the
  // asker's files, but not on the asker's canvas, which shows one node for the whole vault.
  const walk = (dir, vault, nested) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a folder that cannot be read has no notes to offer
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const own = isVaultDir(full);
        walk(full, own ? full : vault, nested || (own && full.startsWith(start + path.sep)));
      } else if (/\.md$/i.test(entry.name)) {
        const inside = path.relative(start, full);
        notes.push({
          path: full,
          name: entry.name.replace(/\.md$/i, ""),
          vault,
          place: posix(path.relative(top, dir)),
          relative: inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? posix(inside) : null,
          nested,
        });
      }
    }
  };
  walk(top, isVaultDir(top) ? top : null, false);
  return { top, notes };
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
 * The cache is in userData, deliberately NOT in the vault: a commit snapshots the vault
 * wholesale, and a folder of other people's logos is not something anybody meant to
 * commit.
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
 * Slack. A thread here is a note pointing at a thread there — and a Slack thread is not
 * a thing of its own: it is a message that other messages answer, named by the channel
 * it is in and the timestamp of that first message. So "start a thread" is "post the
 * first message", and the note's name is what gets posted. The bot token is kept the
 * way Linear's key is — sealed with the OS keychain into the app's own folder, never
 * the vault — and the renderer never sees it: it asks for a channel's threads, a
 * thread's first message, or a post, and the shell adds the header.
 */
const SLACK_API = "https://slack.com/api/";
const slackFile = () => path.join(app.getPath("userData"), "slack.json");

function readSlack() {
  try {
    const stored = JSON.parse(fs.readFileSync(slackFile(), "utf8"));
    if (typeof stored.token !== "string") return null;
    return {
      token: unseal(stored.token),
      team: typeof stored.team === "string" ? stored.team : "",
      teamId: typeof stored.teamId === "string" ? stored.teamId : "",
      url: typeof stored.url === "string" ? stored.url : "",
      user: typeof stored.user === "string" ? stored.user : "",
      bot: !!stored.bot,
    };
  } catch {
    return null; // never connected, or the keychain refused — both mean "not connected"
  }
}

/** One Web API call with whatever token is stored. Throws what Slack said, in words. */
async function slackFetch(token, method, args) {
  const response = await net.fetch(SLACK_API + method, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}` },
    body: JSON.stringify(args ?? {}),
  });
  if (!response.ok) throw new Error(`Slack said ${response.status}`);
  const body = await response.json();
  if (!body.ok) throw new Error(slackError(body.error, args));
  return body;
}

/** Slack's error codes are terse; these are the ones a person will actually meet. */
function slackError(code, args) {
  switch (code) {
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "account_inactive":
      return "Slack refused the token";
    case "missing_scope":
      return "the token lacks a scope it needs — chat:write, channels:history, channels:read (and groups:* for private channels)";
    case "not_in_channel":
      return "not in that channel — join it in Slack first (or /invite the app, on a bot token)";
    case "channel_not_found":
      return `Slack knows no channel ${args && args.channel ? args.channel : ""}`.trim();
    case "thread_not_found":
    case "message_not_found":
      return "that message is not in Slack any more";
    case "ratelimited":
      return "Slack is rate-limiting — try again in a moment";
    default:
      return `Slack said ${code || "no"}`;
  }
}

/**
 * The first line of a message, as a person would read it: Slack's own markup — user and
 * channel mentions, `<url|text>` links, escaped &, < and > — taken down to plain words.
 * What a thread is called on the graph is cut from this.
 */
function slackPlain(text) {
  return String(text || "")
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1")
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<!([a-z]+)(?:\^[^|>]*)?(?:\|([^>]*))?>/g, (_m, kind, label) => label || `@${kind}`)
    .replace(/<([^|>]+)\|([^>]*)>/g, "$2")
    .replace(/<((?:https?|mailto):[^>]+)>/g, (_m, url) => {
      try {
        return new URL(url).hostname.replace(/^www\./, "") || url;
      } catch {
        return url;
      }
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** A message's permalink, spelt the way Slack itself spells one, from the team's own URL. */
const slackPermalink = (account, channel, ts) =>
  account.url
    ? `${account.url.replace(/\/$/, "")}/archives/${channel}/p${ts.replace(".", "")}`
    : `https://slack.com/archives/${channel}/p${ts.replace(".", "")}`;

/**
 * A thread as the pointer a note keeps: where it is, what it opened with, and how much
 * has been said under it since.
 */
function slackThreadRow(account, channel, message) {
  const ts = String(message.ts || "");
  return {
    channel,
    ts,
    text: slackPlain(message.text),
    replies: Number(message.reply_count) || 0,
    at: Math.round(parseFloat(ts) * 1000) || 0,
    latest: Math.round(parseFloat(message.latest_reply || ts) * 1000) || 0,
    url: slackPermalink(account, channel, ts),
  };
}

/**
 * Pasting a bot token is the whole setup: it is proved against Slack before being kept,
 * so a typo is told about now rather than at the first post that fails. What comes back
 * is who the token is — the workspace, and the bot's own name.
 */
ipcMain.handle("slack-connect", async (_event, rawToken) => {
  const token = String(rawToken || "").trim();
  if (!token) throw new Error("no token given");
  if (!/^xox[bp]-/.test(token)) throw new Error("that is not a Slack token — one starts with xoxp- (you) or xoxb- (the app)");
  const who = await slackFetch(token, "auth.test", {});
  const account = {
    team: String(who.team || ""),
    teamId: String(who.team_id || ""),
    url: String(who.url || ""),
    user: String(who.user || ""),
    // A user token acts as the person; a bot token as the app. Slack tells them apart by
    // prefix, and the settings page says which it is, because the difference is whose
    // name the first message goes out under.
    bot: token.startsWith("xoxb-"),
  };
  fs.mkdirSync(path.dirname(slackFile()), { recursive: true });
  fs.writeFileSync(slackFile(), JSON.stringify({ version: 1, token: seal(token), ...account }), { mode: 0o600 });
  return account;
});

ipcMain.handle("slack-status", () => {
  const account = readSlack();
  return account
    ? { connected: true, team: account.team, user: account.user, bot: account.bot }
    : { connected: false, team: "", user: "", bot: false };
});

ipcMain.handle("slack-forget", () => {
  try {
    fs.rmSync(slackFile());
  } catch {
    /* nothing stored */
  }
  return true;
});

/** The channels the token can see — public and private — the ones the app is in first. */
ipcMain.handle("slack-channels", async () => {
  const account = readSlack();
  if (!account) throw new Error("Slack is not connected");
  const found = [];
  let cursor = "";
  do {
    const page = await slackFetch(account.token, "conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    for (const channel of page.channels || []) {
      found.push({
        id: String(channel.id),
        name: String(channel.name || channel.id),
        member: !!channel.is_member,
        private: !!channel.is_private,
      });
    }
    cursor = String((page.response_metadata && page.response_metadata.next_cursor) || "");
  } while (cursor && found.length < 1000);
  found.sort((a, b) => Number(b.member) - Number(a.member) || a.name.localeCompare(b.name));
  return found;
});

/**
 * The threads going in a channel: its recent messages that have been answered, newest
 * first. A message nobody has replied to is not a thread yet — it is offered under the
 * paste-a-link door instead, where any message can be the start of one.
 */
ipcMain.handle("slack-threads", async (_event, rawChannel, rawLimit) => {
  const account = readSlack();
  if (!account) throw new Error("Slack is not connected");
  const channel = String(rawChannel || "");
  if (!/^[CG][A-Z0-9]+$/.test(channel)) throw new Error("no channel chosen — Settings → Integrations → Slack");
  const limit = Math.max(1, Math.min(Number(rawLimit) || 30, 100));
  const page = await slackFetch(account.token, "conversations.history", { channel, limit: 200 });
  return (page.messages || [])
    .filter((message) => Number(message.reply_count) > 0 && !message.subtype)
    .slice(0, limit)
    .map((message) => slackThreadRow(account, channel, message));
});

/** One thread, by the pair that names it — what a pasted link comes down to. */
ipcMain.handle("slack-thread", async (_event, rawChannel, rawTs) => {
  const account = readSlack();
  if (!account) throw new Error("Slack is not connected");
  const channel = String(rawChannel || "");
  const ts = String(rawTs || "");
  if (!/^[CGD][A-Z0-9]+$/.test(channel) || !/^\d+\.\d+$/.test(ts)) throw new Error("that is not a Slack message link");
  const page = await slackFetch(account.token, "conversations.replies", { channel, ts, limit: 1 });
  const parent = (page.messages || [])[0];
  if (!parent) throw new Error("that message is not in Slack any more");
  return slackThreadRow(account, channel, parent);
});

/**
 * Starts a thread: posts its first message. There is no other way to make one — a thread
 * IS a message with answers — so what the note is called is what goes to the channel, and
 * the timestamp Slack mints for it is the thread's name from then on.
 */
ipcMain.handle("slack-post", async (_event, rawChannel, rawText) => {
  const account = readSlack();
  if (!account) throw new Error("Slack is not connected");
  const channel = String(rawChannel || "");
  const text = String(rawText || "").trim();
  if (!/^[CG][A-Z0-9]+$/.test(channel)) throw new Error("no channel chosen — Settings → Integrations → Slack");
  if (!text) throw new Error("nothing to post");
  const posted = await slackFetch(account.token, "chat.postMessage", { channel, text, unfurl_links: false });
  return slackThreadRow(account, channel, { ...(posted.message || {}), ts: posted.ts, text, reply_count: 0 });
});

/**
 * Opens THE thread. The Slack app answers `slack://` directly, thread view and all; the
 * https permalink is the fallback for a Mac without it, and lands in the browser, which
 * hands it to Slack's web client (or the app, if it turns out to be there after all).
 */
ipcMain.handle("slack-open", async (_event, rawUrl) => {
  const url = String(rawUrl || "");
  const link = parseSlackLink(url);
  if (!link) return false;
  const account = readSlack();
  const team = account && account.teamId;
  if (team && fs.existsSync("/Applications/Slack.app")) {
    try {
      await shell.openExternal(
        `slack://channel?team=${team}&id=${link.channel}&message=${link.ts}&thread_ts=${link.ts}`,
      );
      return true;
    } catch {
      /* no handler for slack:// after all — the browser then */
    }
  }
  void shell.openExternal(url);
  return true;
});

/**
 * What a Slack permalink names — `…/archives/C0123ABCD/p1693000000123456`, with a
 * `thread_ts` alongside when the link was copied from a reply rather than the message
 * that started the thread. The thread's own timestamp wins, so a link to any reply
 * attaches the whole thread.
 */
function parseSlackLink(text) {
  let url;
  try {
    url = new URL(String(text || "").trim());
  } catch {
    return null;
  }
  if (!/(^|\.)slack\.com$/.test(url.hostname)) return null;
  const m = /\/archives\/([CGD][A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(url.pathname);
  if (!m) return null;
  const thread = url.searchParams.get("thread_ts");
  return { channel: m[1], ts: thread && /^\d+\.\d+$/.test(thread) ? thread : `${m[2]}.${m[3]}` };
}

/* --------------------------------------- running things in the person's terminal --- */
/*
 * Both agent integrations work the same way: Bedrock finds a CLI, gets a session an id, and
 * hands that id to the terminal the person already uses. It owns none of what happens next,
 * which is the point — the agent is not this app's child process, so it outlives the app
 * without anything clever, and the person keeps the terminal they have already set up.
 */

/**
 * The PATH a terminal would have. A GUI app on macOS inherits a bare launchd environment,
 * so neither `agy` nor `claude` (both ~/.local/bin) is on it — asking the login
 * shell is the only way to find what the user would find. Read once and kept: it changes
 * when a shell profile does, which is not during a run.
 */
let loginPathCache = null;
function loginPath() {
  if (loginPathCache) return loginPathCache;
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    loginPathCache = require("node:child_process")
      .execFileSync(shell, ["-lic", "printf %s \"$PATH\""], { encoding: "utf8", timeout: 5000 })
      .trim();
  } catch {
    loginPathCache = process.env.PATH || "";
  }
  // The app's own guesses, in case a profile never exported them.
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin")];
  const parts = loginPathCache.split(":").filter(Boolean);
  for (const dir of extra) if (!parts.includes(dir)) parts.push(dir);
  loginPathCache = parts.join(":");
  return loginPathCache;
}

/** Where a CLI is, or null when it is not installed. Not cached — it can be installed. */
function binOnPath(name) {
  for (const dir of loginPath().split(":")) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Hands a command to the person's terminal.
 *
 * Through a `.command` file rather than AppleScript on purpose. Driving Terminal with
 * `osascript` is an Apple Events request, which means a "Bedrock wants to control Terminal"
 * consent dialog and an `NSAppleEventsUsageDescription` in a signed build's Info.plist — a
 * lot of ceremony to run one command. `open` on an executable `.command` asks nobody, and it
 * goes to whichever terminal the person actually uses: Terminal, iTerm and Ghostty all
 * register for the type, so this follows their choice rather than overriding it.
 *
 * Nothing is inherited from Bedrock either, which is worth saying out loud: `open` asks
 * LaunchServices to start the terminal, so the session gets the environment the person's own
 * shell profile gives it rather than the one this app happened to be launched with. The
 * scrubbing the minting path has to do by hand is free here.
 *
 * The script is named for the session, so reopening a note rewrites its own file instead of
 * littering, and the title goes in the window so a screen full of terminals can be told apart.
 */
async function handToTerminal({ id, folder, title, bin, args }) {
  const scripts = path.join(app.getPath("userData"), "sessions");
  fs.mkdirSync(scripts, { recursive: true });
  const script = path.join(scripts, `${id}.command`);
  // Single-quoted for the shell, with any quote in a path or title closed and reopened
  // around an escaped one — a vault called "Arsenii's notes" is an ordinary thing to have.
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(
    script,
    `#!/bin/sh\n` +
      `# Written by Bedrock. Rewritten every time this note's node is opened.\n` +
      `printf '\\033]0;%s\\007' ${quote(title)}\n` +
      `cd ${quote(folder)} || exit 1\n` +
      `exec ${quote(bin)} ${args.map(quote).join(" ")}\n`,
    { mode: 0o755 },
  );
  await new Promise((resolve, reject) => {
    execFile("/usr/bin/open", [script], (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout);
    });
  });
  return true;
}

/* -------------------------------------------------- antigravity, in your terminal --- */
/*
 * An Antigravity session, run by the `agy` CLI in the terminal the person already uses.
 *
 * Bedrock owns none of this, and that is the point. It does exactly two things: it gets a
 * conversation its ID, and it hands that ID to a terminal. Everything else — the login,
 * the agent, the transcript, whether the thing is still running — belongs to `agy` and to
 * the store it keeps in `~/.gemini/antigravity-cli`. So there is no window to draw, no pty
 * to babysit, and no session that dies when this app is quit.
 *
 * The ID is the load-bearing part, and `agy` will not take one of ours: `--conversation
 * <unknown-uuid>` warns "not found" and quietly starts a conversation under an ID of its
 * own, which is exactly the silent-wrong-session bug worth avoiding. It does, however,
 * ANNOUNCE the ID: `--output-format stream-json` writes an `init` event as its first line,
 * before any model call, carrying `conversation_id`. So a conversation is minted by
 * starting one, reading that one line, and killing the process — which leaves a real,
 * empty, resumable conversation on disk, costs no tokens, and needs nothing watched for.
 *
 * The note keeps the ID (`conversation::`) and that is the whole binding. Compare the
 * integration this replaced, which had to watch a browser window for a URL Google minted
 * only after the first message: nothing here is scraped, and nothing is guessed.
 */

/** Where `agy` is, or null when it is not installed. */
const agyPath = () => binOnPath("agy");

/** The CLI's own state directory — its conversations, and the proof it has ever run. */
const agyHome = () => path.join(os.homedir(), ".gemini", "antigravity-cli");
const agyConversations = () => path.join(agyHome(), "conversations");

/*
 * Variables that decide WHO an Antigravity session is, and must never be inherited.
 *
 * Minting is the one place Bedrock still runs an agent CLI as its own child, so it is the
 * one place this matters. `agy` run by hand uses the OAuth login the person made with it —
 * their own subscription. But the CLI will prefer an API key when it finds one in the
 * environment, and a GUI app inherits whatever launched it: start Bedrock from a shell that
 * exports `GEMINI_API_KEY` and every conversation minted here would authenticate — and
 * BILL — against that key instead of the login the person thinks they are using.
 *
 * Minting therefore runs with these dropped. The terminal handoff needs no such care: it
 * runs in the person's own shell and so gets the person's own environment by construction.
 */
const AGY_INHERITED_IDENTITY = /^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GOOGLE_GENAI_)/;

function agyEnv() {
  const clean = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!AGY_INHERITED_IDENTITY.test(key)) clean[key] = value;
  }
  return { ...clean, PATH: loginPath() };
}

/**
 * What this integration can do here. There is deliberately no sign-in question: `agy`
 * holds its own OAuth login in the OS keychain, and a session that needs one says so in
 * the terminal it opens in, where it can actually be answered. Bedrock never reads that
 * token, and asking after it would mean touching a secret to display a pill.
 */
ipcMain.handle("agy-status", () => {
  const bin = agyPath();
  return { cli: bin, ran: fs.existsSync(agyHome()), platform: process.platform };
});

/** How long to wait for the CLI to announce a conversation's id before giving up. */
const AGY_MINT_MS = 60000;

/**
 * Mints a conversation and resolves with its id.
 *
 * `--print` needs a prompt, so it gets the note's name — but nothing is ever sent: the
 * process is killed the instant the `init` line arrives, which is before the first model
 * call. The conversation that is left behind is genuinely empty, so the first thing said
 * in it is whatever the person types in their own terminal.
 *
 * `cwd` is how the workspace gets scoped: the CLI reports it back in `init`, and it is the
 * folder the note's own place in the vault says this session is about.
 */
ipcMain.handle("agy-create", (_event, folder, name) => {
  const bin = agyPath();
  if (!bin) throw new Error("the agy CLI is not installed — antigravity.google/docs/cli");
  const dir = realFolder(folder);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`${dir} is not a folder on this machine`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["--print", String(name || "Antigravity session"), "--output-format", "stream-json"], {
      cwd: dir,
      env: agyEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errors = "";
    let settled = false;
    const finish = (err, id) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // SIGTERM first so the CLI can close its database cleanly; SIGKILL only if it hangs.
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      const hard = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2000);
      hard.unref?.();
      if (err) reject(err);
      else resolve(id);
    };
    const timer = setTimeout(
      () => finish(new Error("agy did not report a conversation id — run `agy` once in a terminal first")),
      AGY_MINT_MS,
    );
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const newline = out.indexOf("\n");
      if (newline < 0) return; // the init line has not landed whole yet
      const line = out.slice(0, newline);
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        return finish(new Error(`agy said something unexpected: ${line.slice(0, 200)}`));
      }
      const id = event?.conversation_id;
      if (typeof id === "string" && id) return finish(null, id);
      finish(new Error("agy started but announced no conversation id"));
    });
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.on("error", (err) => finish(err));
    child.on("exit", (code) =>
      finish(new Error((errors.trim() || `agy exited with code ${code}`).slice(-400))),
    );
  });
});

/**
 * Hands a conversation to the person's terminal, and gets out of the way. How that is done
 * — and why it is a `.command` file rather than AppleScript — is `handToTerminal` above.
 */
ipcMain.handle("agy-open", (_event, options) => {
  const id = String(options?.id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("not a conversation id");
  const bin = agyPath();
  if (!bin) throw new Error("the agy CLI is not installed — antigravity.google/docs/cli");
  return handToTerminal({
    id,
    folder: realFolder(options?.folder || os.homedir()),
    title: String(options?.title ?? "Antigravity"),
    bin,
    args: ["--conversation", id],
  });
});

/**
 * The conversations on this machine, most recently touched first — what a note can be
 * plugged into.
 *
 * Two sources, because the CLI keeps two. `conversation_summaries.db` has the titles and
 * is what `agy`'s own resume picker reads, but it does not carry every conversation: one
 * minted in print mode gets a database of its own and no summary row. So the summaries are
 * read first for their names, and then the conversation directory is swept for anything
 * they do not mention, which is listed by its id and its age. A conversation Bedrock
 * minted but never opened is in that second group, and has to be offerable.
 *
 * SELECT only, over an ordinary connection. Not `-readonly`, which cannot be used here: the
 * store is in WAL mode, and a read-only connection is not allowed to create the `-shm` file
 * WAL needs, so it fails outright with "unable to open database file". WAL is built for
 * exactly this instead — one writer and any number of concurrent readers — so a listing
 * taken while a session is mid-turn is safe, and never blocks the session.
 */
ipcMain.handle("agy-conversations", async (_event, limit = 20) => {
  const cap = Math.max(1, Math.min(200, Number(limit) || 20));
  const summaries = new Map();
  const db = path.join(agyHome(), "conversation_summaries.db");
  if (fs.existsSync(db)) {
    const rows = await new Promise((resolve) => {
      execFile(
        "/usr/bin/sqlite3",
        [
          "-json",
          db,
          "select conversation_id, title, preview, step_count, workspace_uris," +
            " strftime('%s', last_modified_time) as at from conversation_summaries" +
            " where killed = 0 order by last_modified_time desc limit 200",
        ],
        { timeout: 5000 },
        (err, stdout) => {
          if (err) return resolve([]); // no sqlite3, or a schema that has moved on
          try {
            resolve(JSON.parse(stdout || "[]"));
          } catch {
            resolve([]);
          }
        },
      );
    });
    for (const row of rows) {
      if (!row?.conversation_id) continue;
      summaries.set(row.conversation_id, {
        id: row.conversation_id,
        title: String(row.title || "").trim(),
        preview: String(row.preview || "").trim(),
        steps: Number(row.step_count) || 0,
        folder: firstWorkspace(row.workspace_uris),
        at: (Number(row.at) || 0) * 1000,
      });
    }
  }
  // Everything with a database of its own, which is the real inventory.
  let files = [];
  try {
    files = fs.readdirSync(agyConversations());
  } catch {
    files = []; // the CLI has never run here
  }
  const out = [];
  for (const name of files) {
    if (!name.endsWith(".db")) continue; // -wal and -shm are the same conversation
    const id = name.slice(0, -".db".length);
    const known = summaries.get(id);
    let at = known?.at ?? 0;
    try {
      at = Math.max(at, fs.statSync(path.join(agyConversations(), name)).mtimeMs);
    } catch {
      /* vanished mid-walk */
    }
    out.push({ id, title: "", preview: "", steps: 0, folder: "", ...known, at });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, cap);
});

/** The first workspace a conversation was opened on, out of the JSON list the CLI keeps. */
function firstWorkspace(raw) {
  try {
    const list = JSON.parse(String(raw || "[]"));
    const first = Array.isArray(list) ? String(list[0] ?? "") : "";
    return first.startsWith("file://") ? decodeURIComponent(first.slice("file://".length)) : first;
  } catch {
    return "";
  }
}

/* ----------------------------------------------------- claude, in your terminal --- */
/*
 * Claude Code, run by the `claude` CLI in the terminal the person already uses — the same
 * shape as the Antigravity integration above, and for the same reasons.
 *
 * This replaced a version that ran the CLI under tmux and drew it into an xterm.js window
 * Bedrock owned. That bought one thing — a session visible inside the app — at the price of
 * a native pty dependency, a second renderer entry point, a tmux install to police, and an
 * attach/detach lifecycle to explain. Handing the session to the terminal costs none of
 * that: the process is not Bedrock's child, so it already outlives the app, and the person
 * gets their own terminal, their own scrollback, their own key bindings.
 *
 * Better still, `claude` will take an id of somebody else's choosing — `--session-id` mints
 * one and `--resume` continues it — so a note knows its session's name before a word is
 * said in it. That is the same guarantee the Antigravity path gets out of reading an `init`
 * event, but for free.
 */

/** Where `claude` is, or null when it is not installed. */
const claudePath = () => binOnPath("claude");

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What this mode needs, so the settings page can refuse it rather than fail at it. There is
 * nothing to install beyond the CLI itself — which is the whole difference from the tmux
 * version, whose prerequisite was something most people had never heard of.
 */
ipcMain.handle("claude-cli-status", () => ({ cli: claudePath(), platform: process.platform }));

/**
 * Starts a session in the person's terminal, and resolves with its id.
 *
 * The id is minted HERE and passed to the CLI, so the note has its session's name
 * immediately and nothing is ever watched for or guessed at. Resuming keeps the id:
 * `--resume` continues the same conversation rather than branching it, so a note's
 * `session::` line stays true across any number of runs. The transcript written either way
 * is the ordinary one, which is what lets the same session be opened in the Claude app
 * afterwards — the two modes are two doors onto one thing.
 */
ipcMain.handle("claude-cli-start", async (_event, folder, resume, title) => {
  const bin = claudePath();
  if (!bin) throw new Error("the claude CLI is not installed — claude.com/product/claude-code");
  const dir = realFolder(folder);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`${dir} is not a folder on this machine`);
  }
  const resuming = SESSION_UUID.test(String(resume ?? ""));
  const id = resuming ? String(resume) : crypto.randomUUID();
  await handToTerminal({
    id,
    folder: dir,
    title: String(title || "Claude"),
    bin,
    args: resuming ? ["--resume", id] : ["--session-id", id],
  });
  return id;
});

/**
 * Who the CLI will run as — read from its own `~/.claude.json`, identity only.
 *
 * Worth surfacing because the CLI and the Claude app keep SEPARATE logins, and nothing
 * otherwise tells you when they have drifted apart: two accounts, two plans, and the only
 * symptom is one of them behaving differently halfway through a session.
 *
 * It reports WHICH account and nothing more. An earlier version of this tried to work out
 * whether that account could pay, by reading a cache key whose name looked like it meant
 * something — it did not, and it said "no subscription" about a premium team seat. What
 * an account is entitled to is the server's to know; guessing at it from local cache
 * files produces confident nonsense. No token is read here and none is returned.
 */
ipcMain.handle("claude-account", () => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    const account = raw.oauthAccount ?? {};
    return {
      email: String(account.emailAddress || ""),
      org: String(account.organizationName || ""),
      // Reported verbatim, not interpreted — it is the account's own word for its plan.
      seat: String(account.seatTier || account.organizationType || ""),
    };
  } catch {
    return { email: "", org: "", seat: "" };
  }
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
 * A session's name, best answer first: the one somebody typed, then the one Claude Code
 * derived, and only then the first thing said in it.
 *
 * That last fallback needs cleaning rather than trusting. A session resumed from a slash
 * command opens with a `<local-command-caveat>` block, so a row taken straight off the
 * first message reads "Caveat: The messages below were generated by…" — which names every
 * such session identically and none of them usefully. Tags of that shape are dropped, and
 * a session with nothing left to say is left unnamed for the caller to fall back on its id.
 */
function sessionTitle(custom, derived, first) {
  if (custom.trim()) return custom.replace(/\s+/g, " ").trim().slice(0, 70);
  if (derived.trim()) return derived.replace(/\s+/g, " ").trim().slice(0, 70);
  const cleaned = first
    .replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/^Caveat:[\s\S]*?(?=\n|$)/, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 70);
}

/**
 * When a session was last worked in, read out of its transcript rather than off the file.
 *
 * The file's mtime is NOT this. Anything that rewrites a file without a session running —
 * a backup restored, a folder synced, an archive unpacked — sets every mtime it touches to
 * the same instant, and on this machine that has already happened twice: of 138 transcripts,
 * 58 share one mtime and 37 share another. Sorting by that puts a hundred sessions in an
 * arbitrary order and buries whichever ones were genuinely recent, which is exactly the
 * "it does not show me the latest sessions" symptom.
 *
 * The last turn's own timestamp cannot be touched by any of that, so it is what is used.
 * Read from the tail, which is a fixed cost per session however many megabytes it runs to.
 */
function lastTurnAt(file) {
  const lines = tailLines(file, 32 * 1024);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.timestamp) {
        const at = Date.parse(entry.timestamp);
        if (at) return at;
      }
    } catch {
      /* a half-written line at the very end of a live session */
    }
  }
  return 0;
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
    title: sessionTitle(custom, derived, first),
    // What "latest" means: the last turn in it, not the last time the file was written.
    at: lastTurnAt(session.file) || session.at,
  };
}

/*
 * The sessions on this machine, most recently touched first. This is what "plug in a session"
 * chooses from — and it is the only way to point a note at a session that is certain, since
 * nothing is sent on a note's behalf for the guessing below to match on. Choosing beats
 * inferring whenever somebody is there to choose.
 */
ipcMain.handle("claude-sessions", (_event, limit = 14) => {
  // Every session is summarised before any is dropped, because the ordering key lives
  // INSIDE the transcript (see `lastTurnAt`) — taking the first N by mtime and sorting
  // those is what hid the recent ones. The cost is a tail read per session, which is
  // flat in the size of a session and is what the status poll already pays.
  const all = [];
  for (const session of transcripts()) {
    const summary = sessionSummary(session);
    if (!summary.folder) continue; // not a transcript we can say anything useful about
    all.push(summary);
  }
  all.sort((a, b) => b.at - a.at);
  return all.slice(0, Math.max(1, Number(limit) || 14));
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

/*
 * Freeform. Apple gives it no API — no scripting dictionary, nothing to link against.
 * What it does give: a URL scheme (`freeform://board?id=<uuid>`) that opens a board,
 * a board index the app keeps beside its own database (Snapshot.plist — every board's
 * uuid, title and last edit, readable), and App Intents (create board, and more) that
 * only the Shortcuts app can reach. So "make a board" is: run a shortcut Bedrock ships
 * as a signed file, then read the index to see which board is new. The boards stay
 * entirely Freeform's own, in iCloud — what crosses into Bedrock is a pointer.
 */
const FREEFORM_APP = "/System/Applications/Freeform.app";
const FREEFORM_SHORTCUT = "New Freeform Board (Bedrock)";
const FREEFORM_SNAPSHOT = path.join(
  os.homedir(),
  "Library/Group Containers/group.com.apple.freeform/Snapshot.plist",
);

/** One command, promised. `input` goes to its stdin, which is how a shortcut takes text. */
const command = (bin, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: 60000 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout)),
    );
    if (input !== undefined) child.stdin.end(input);
  });

/**
 * The index is a binary plist full of dates, which JSON.parse and `plutil -convert json`
 * both refuse — osascript's JavaScript is the one tool always on a Mac that reads it
 * whole. A board can appear in several sections (recents, all, a folder), so the walk
 * keeps whichever sighting was edited last.
 */
const FREEFORM_LIST = `
ObjC.import("Foundation");
const tree = ObjC.deepUnwrap($.NSArray.arrayWithContentsOfFile(${JSON.stringify(FREEFORM_SNAPSHOT)}));
const out = {};
function walk(node) {
  const board = node.item && node.item.board && node.item.board.board;
  if (board && board.boardIdentifier) {
    const id = board.boardIdentifier.storage.boardUUID;
    const at = board.lastEdited instanceof Date ? board.lastEdited.getTime() : 0;
    if (!out[id] || out[id].at < at) out[id] = { title: String(board.title || ""), at, shared: !!board.isShared };
  }
  (node.children || []).forEach(walk);
}
(tree || []).forEach(walk);
JSON.stringify(out);`;

/** Every board Freeform knows of, latest edit first: `{ id, title, at, shared }`. */
async function freeformBoards() {
  const raw = await command("osascript", ["-l", "JavaScript", "-e", FREEFORM_LIST]);
  return Object.entries(JSON.parse(raw || "{}"))
    .map(([id, board]) => ({ id, ...board }))
    .sort((a, b) => b.at - a.at);
}

ipcMain.handle("freeform-status", async () => {
  if (process.platform !== "darwin") return { app: false, shortcut: false };
  let shortcut = false;
  try {
    shortcut = (await command("shortcuts", ["list"])).split("\n").includes(FREEFORM_SHORTCUT);
  } catch {
    /* no shortcuts CLI — an old macOS, which also has no Freeform */
  }
  return { app: fs.existsSync(FREEFORM_APP), shortcut };
});

ipcMain.handle("freeform-boards", async (_event, limit = 40) => {
  try {
    return (await freeformBoards()).slice(0, Math.max(1, Number(limit) || 40));
  } catch {
    return [];
  }
});

ipcMain.handle("freeform-create", async (_event, rawTitle) => {
  const title = String(rawTitle ?? "").trim() || "Untitled";
  const before = new Set((await freeformBoards().catch(() => [])).map((board) => board.id));
  await command("shortcuts", ["run", FREEFORM_SHORTCUT], title);
  // The run resolving means Freeform made the board; the index is written a beat later.
  for (let tries = 0; tries < 20; tries++) {
    const fresh = (await freeformBoards().catch(() => [])).find((board) => !before.has(board.id));
    if (fresh) return fresh;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
});

ipcMain.handle("freeform-open", (_event, id) => {
  const uuid = String(id || "").toUpperCase();
  if (!/^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(uuid)) return false;
  void shell.openExternal(`freeform://board?id=${uuid}`);
  return true;
});

ipcMain.handle("freeform-install", async () => {
  // The signed shortcut ships inside the app's archive, where Shortcuts cannot reach —
  // a copy in the real filesystem is what gets opened. Opening it is Shortcuts' import
  // dialog: one Add Shortcut click, which Apple keeps for the person on purpose.
  const target = path.join(os.tmpdir(), `${FREEFORM_SHORTCUT}.shortcut`);
  fs.copyFileSync(path.join(__dirname, "freeform", `${FREEFORM_SHORTCUT}.shortcut`), target);
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
  return true;
});

/*
 * Apple Notes. Unlike Freeform it has a real scripting dictionary, so there is nothing
 * to install: osascript lists, makes and shows notes directly, and the one gate is the
 * OS's own Automation prompt — a single Allow click, asked by macOS the first time
 * Bedrock speaks to Notes, and remembered from then on. The notes stay Apple's own, in
 * iCloud; what crosses into Bedrock is a pointer — a note's id and name.
 */
const APPLE_NOTES_APP = "/System/Applications/Notes.app";

/** JXA, batched: three Apple events for the whole library, not three per note. */
const NOTES_LIST = `
const Notes = Application("Notes");
const ids = Notes.notes.id();
const names = Notes.notes.name();
const dates = Notes.notes.modificationDate();
// The bin still answers to "every note", and a deleted note must not be offered as a
// thing to link. Matched by the folder's name, which is the only mark it carries.
const gone = {};
for (const account of Notes.accounts()) {
  for (const folder of account.folders()) {
    if (folder.name() !== "Recently Deleted") continue;
    for (const id of folder.notes.id()) gone[id] = true;
  }
}
const out = [];
for (let i = 0; i < ids.length; i++) {
  if (gone[ids[i]]) continue;
  const at = dates[i] instanceof Date ? dates[i].getTime() : 0;
  out.push({ id: String(ids[i]), title: String(names[i] || ""), at });
}
out.sort((a, b) => b.at - a.at);
JSON.stringify(out.slice(0, 200));`;

/** Where new notes land when the vault has not said — Bedrock's own folder in Notes. */
const NOTES_DEFAULT_FOLDER = "Bedrock";

/** The folder and title arrive as argv, never spliced into the script — they are not
    code. The folder is found in the default account, or made there on the spot. */
const NOTES_CREATE = `
function run(argv) {
  const folderName = String(argv[0] || "");
  const title = String(argv[1] || "Untitled");
  const esc = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const Notes = Application("Notes");
  const account = Notes.defaultAccount();
  let target = null;
  for (const folder of account.folders()) {
    if (folder.name() === folderName) { target = folder; break; }
  }
  if (!target) {
    target = Notes.Folder({ name: folderName });
    account.folders.push(target);
  }
  const note = Notes.Note({ body: "<div><h1>" + esc + "</h1></div>" });
  target.notes.push(note);
  return JSON.stringify({ id: String(note.id()), title: String(note.name()), at: Date.now() });
}`;

/** The folders a new note could land in — the default account's own, the bin left out. */
const NOTES_FOLDERS = `
const Notes = Application("Notes");
const names = [];
for (const folder of Notes.defaultAccount().folders()) {
  const name = folder.name();
  if (name !== "Recently Deleted") names.push(name);
}
JSON.stringify(names);`;

const NOTES_SHOW = `
function run(argv) {
  const Notes = Application("Notes");
  const note = Notes.notes.byId(String(argv[0]));
  Notes.show(note);
  Notes.activate();
  return "ok";
}`;

/** What macOS's refusal actually means, said in directions rather than a code. */
function notesError(err) {
  const said = String((err && err.message) || err);
  if (said.includes("-1743") || /not authori[sz]ed/i.test(said)) {
    return new Error(
      "macOS is keeping Bedrock away from Notes — System Settings → Privacy & Security → Automation → Bedrock → Notes",
    );
  }
  return new Error(said.trim() || "Notes did not answer");
}

ipcMain.handle("notes-status", () => ({
  app: process.platform === "darwin" && fs.existsSync(APPLE_NOTES_APP),
}));

ipcMain.handle("notes-list", async (_event, limit = 40) => {
  try {
    const raw = await command("osascript", ["-l", "JavaScript", "-e", NOTES_LIST]);
    return JSON.parse(raw || "[]").slice(0, Math.max(1, Number(limit) || 40));
  } catch (err) {
    throw notesError(err);
  }
});

ipcMain.handle("notes-create", async (_event, rawFolder, rawTitle) => {
  const folder = String(rawFolder ?? "").trim() || NOTES_DEFAULT_FOLDER;
  const title = String(rawTitle ?? "").trim() || "Untitled";
  try {
    const raw = await command("osascript", ["-l", "JavaScript", "-e", NOTES_CREATE, folder, title]);
    return JSON.parse(raw);
  } catch (err) {
    throw notesError(err);
  }
});

ipcMain.handle("notes-folders", async () => {
  try {
    const raw = await command("osascript", ["-l", "JavaScript", "-e", NOTES_FOLDERS]);
    return JSON.parse(raw || "[]");
  } catch (err) {
    throw notesError(err);
  }
});

ipcMain.handle("notes-open", async (_event, rawId) => {
  const id = String(rawId || "");
  if (!id.startsWith("x-coredata://")) return false;
  try {
    await command("osascript", ["-l", "JavaScript", "-e", NOTES_SHOW, id]);
    return true;
  } catch (err) {
    throw notesError(err);
  }
});

/*
 * Notion. Reached over Notion's own MCP server (mcp.notion.com) rather than a REST key:
 * linking is OAuth in the real browser — this shell registers itself as a client, opens
 * the consent page, and catches the code on a loopback port — and every call after that
 * is a JSON-RPC tool call with the Bearer token added here. The renderer never sees a
 * token; like Linear's key it is sealed with the OS keychain (safeStorage) into the
 * app's own userData folder, deliberately NOT the vault the commit button snapshots.
 */
const NOTION_MCP = "https://mcp.notion.com/mcp";
const NOTION_META = "https://mcp.notion.com/.well-known/oauth-authorization-server";
const NOTION_RESOURCE = "https://mcp.notion.com";
const notionFile = () => path.join(app.getPath("userData"), "notion.json");

const seal = (text) =>
  safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(text).toString("base64")
    : Buffer.from(text, "utf8").toString("base64");
const unseal = (stored) =>
  safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(Buffer.from(stored, "base64"))
    : Buffer.from(stored, "base64").toString("utf8");

function readNotion() {
  try {
    const stored = JSON.parse(fs.readFileSync(notionFile(), "utf8"));
    if (typeof stored.access !== "string") return null;
    return {
      access: unseal(stored.access),
      refresh: typeof stored.refresh === "string" && stored.refresh ? unseal(stored.refresh) : "",
      clientId: typeof stored.clientId === "string" ? stored.clientId : "",
      workspace: typeof stored.workspace === "string" ? stored.workspace : "",
    };
  } catch {
    return null; // never linked, or the keychain refused — both mean "not linked"
  }
}

function writeNotion(account) {
  fs.mkdirSync(path.dirname(notionFile()), { recursive: true });
  fs.writeFileSync(
    notionFile(),
    JSON.stringify({
      version: 1,
      access: seal(account.access),
      refresh: account.refresh ? seal(account.refresh) : "",
      clientId: account.clientId,
      workspace: account.workspace,
    }),
    { mode: 0o600 },
  );
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The MCP conversation this run has open: its session id, and a counter for call ids. */
let notionSession = null;
let notionTools = null;
let notionSeq = 1;

/** One JSON-RPC message over. 401 comes back as a coded error, so a refresh can catch it. */
async function mcpPost(access, message, sessionId) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${access}`,
    "mcp-protocol-version": "2025-06-18",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return net.fetch(NOTION_MCP, { method: "POST", headers, body: JSON.stringify(message) });
}

/** The reply, whichever coat it wears — plain JSON, or an SSE stream holding one. */
async function mcpReply(response, id) {
  const text = await response.text();
  let message = null;
  if ((response.headers.get("content-type") || "").includes("text/event-stream")) {
    for (const chunk of text.split("\n\n")) {
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.id === id) message = parsed;
      } catch {
        /* a keep-alive, or a notification mid-stream */
      }
    }
  } else if (text) {
    message = JSON.parse(text);
  }
  if (!message) throw new Error("Notion's MCP server sent nothing back");
  if (message.error) throw new Error(String(message.error.message || "Notion refused the request"));
  return message.result;
}

const authRefused = () => Object.assign(new Error("Notion refused the token"), { code: 401 });

async function mcpInitialize(access) {
  const id = notionSeq++;
  const response = await mcpPost(access, {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "Bedrock", version: app.getVersion() },
    },
  });
  if (response.status === 401) throw authRefused();
  if (!response.ok) throw new Error(`Notion said ${response.status}`);
  const session = response.headers.get("mcp-session-id");
  await mcpReply(response, id);
  await mcpPost(access, { jsonrpc: "2.0", method: "notifications/initialized" }, session).catch(() => {});
  return session;
}

/** A dead token is refreshed once; a dead session is reopened once. Then it throws. */
async function notionCall(method, params) {
  let account = readNotion();
  if (!account) throw new Error("Notion is not linked — Settings → Integrations → Notion");
  for (let attempt = 0; ; attempt++) {
    try {
      if (!notionSession) notionSession = { id: await mcpInitialize(account.access) };
      const id = notionSeq++;
      const response = await mcpPost(account.access, { jsonrpc: "2.0", id, method, params }, notionSession.id);
      if (response.status === 401) throw authRefused();
      if (response.status === 404) {
        // The server let the session go; the next round opens a fresh one.
        notionSession = null;
        if (attempt < 2) continue;
        throw new Error("Notion kept dropping the connection");
      }
      if (!response.ok) throw new Error(`Notion said ${response.status}`);
      return await mcpReply(response, id);
    } catch (err) {
      if (err && err.code === 401 && attempt < 1 && account.refresh) {
        account = await notionRefresh(account);
        notionSession = null;
        continue;
      }
      if (err && err.code === 401) {
        throw new Error("Notion signed this app out — link the workspace again");
      }
      throw err;
    }
  }
}

async function notionRefresh(account) {
  const meta = await (await net.fetch(NOTION_META)).json();
  const response = await net.fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: account.refresh,
      client_id: account.clientId,
      resource: NOTION_RESOURCE,
    }).toString(),
  });
  if (!response.ok) throw new Error("Notion signed this app out — link the workspace again");
  const tokens = await response.json();
  const next = {
    ...account,
    access: String(tokens.access_token || ""),
    refresh: String(tokens.refresh_token || account.refresh),
  };
  writeNotion(next);
  return next;
}

/**
 * Which name a tool answers to today. The server's own list is the authority — Notion
 * has renamed its tools once already, and a hardcoded name would break on the next.
 */
async function notionTool(candidates) {
  if (!notionTools) {
    const listed = await notionCall("tools/list", {});
    notionTools = (listed && listed.tools ? listed.tools : []).map((tool) => String(tool.name));
  }
  for (const name of candidates) if (notionTools.includes(name)) return name;
  const loose = notionTools.find((name) => candidates.some((want) => name.includes(want)));
  if (loose) return loose;
  throw new Error(`Notion's MCP server offers no ${candidates[0]} tool any more`);
}

/**
 * Every page a tool result mentions, however the server chose to say it — structured
 * content, JSON in a text block, markdown links, XML-ish attributes, or bare URLs whose
 * slug still spells the title. Defensive on purpose: the result shape is the server's
 * to change, and a search that returns pages must keep returning pages.
 */
function notionPages(result) {
  const found = new Map();
  const keep = (url, title) => {
    const clean = String(url).replace(/[),.\]"']+$/, "");
    // Two spellings in the wild: the classic www.notion.so/<slug>-<id>, and the newer
    // app.notion.com/p/<id> the MCP server answers with today. Both name the same page.
    if (!/^https:\/\/(www\.notion\.so|app\.notion\.com|notion\.so)\//.test(clean)) return;
    // The id is the 32 hex digits the address ends in — with or without a workspace
    // segment or a slug in front, both of which Notion sometimes writes and sometimes
    // does not. The slug, when there is one, still spells a last-resort title.
    const tail = clean.split(/[?#]/)[0].split("/").pop() || "";
    const match = /([0-9a-f]{32})$/.exec(tail.toLowerCase());
    if (!match) return;
    const id = match[1];
    const fromSlug = tail.length > 33 ? tail.slice(0, -33).replace(/-/g, " ") : "";
    const prior = found.get(id);
    if (!prior || (!prior.title && (title || fromSlug))) {
      found.set(id, { id, title: String(title || fromSlug || prior?.title || ""), url: clean });
    }
  };
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (typeof node.url === "string" && /notion\.(so|com)/.test(node.url)) {
      keep(node.url, node.title || node.name || (node.properties && node.properties.title) || "");
    }
    for (const value of Object.values(node)) if (value && typeof value === "object") walk(value);
  };
  const texts = [];
  if (result && result.structuredContent) walk(result.structuredContent);
  for (const part of (result && result.content) || []) {
    if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
  }
  for (const text of texts) {
    try {
      walk(JSON.parse(text));
      continue;
    } catch {
      /* prose, not JSON — read it as text below */
    }
    for (const link of text.matchAll(/\[([^\]]*)\]\((https:\/\/www\.notion\.so\/[^\s)]+)\)/g)) {
      keep(link[2], link[1]);
    }
    for (const tag of text.matchAll(/title[=:]\s*"([^"]*)"[^>\n]*?url[=:]\s*"(https:\/\/www\.notion\.so\/[^"]+)"/g)) {
      keep(tag[2], tag[1]);
    }
    for (const bare of text.matchAll(/https:\/\/www\.notion\.so\/[^\s)\]"'<>]+/g)) keep(bare[0], "");
  }
  return [...found.values()];
}

/** What a failed tool run said, or null — MCP wraps tool errors in an ordinary result. */
function toolTrouble(result) {
  if (!result || !result.isError) return null;
  const text = ((result.content || []).find((part) => part.type === "text") || {}).text;
  return new Error(String(text || "Notion refused the request").slice(0, 300));
}

/** One connect at a time: a second click while the browser is open joins the first. */
let notionConnecting = null;

async function notionConnect() {
  const meta = await (await net.fetch(NOTION_META)).json();

  // The loopback catcher first, so registration can promise the exact redirect URI.
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const redirect = `http://127.0.0.1:${port}/callback`;

  try {
    const registered = await net.fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Bedrock",
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (!registered.ok) throw new Error(`Notion would not register this app (${registered.status})`);
    const clientId = String((await registered.json()).client_id || "");

    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(16));
    const authUrl = new URL(meta.authorization_endpoint);
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      state,
      code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      resource: NOTION_RESOURCE,
    }).toString();

    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("the browser never came back — try linking again")),
        5 * 60 * 1000,
      );
      server.on("request", (request, response) => {
        const url = new URL(request.url, `http://127.0.0.1:${port}`);
        if (url.pathname !== "/callback") {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<body style='font:15px system-ui;padding:3em;color:#333'>Bedrock is connected to Notion — this tab can close.</body>",
        );
        clearTimeout(timer);
        if (url.searchParams.get("error")) {
          reject(new Error(url.searchParams.get("error_description") || "you said no in the browser"));
        } else if (url.searchParams.get("state") !== state) {
          reject(new Error("the browser came back with somebody else's answer"));
        } else {
          resolve(String(url.searchParams.get("code") || ""));
        }
      });
      void shell.openExternal(authUrl.toString());
    });

    const exchanged = await net.fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect,
        client_id: clientId,
        code_verifier: verifier,
        resource: NOTION_RESOURCE,
      }).toString(),
    });
    if (!exchanged.ok) throw new Error(`Notion would not trade the code for a token (${exchanged.status})`);
    const tokens = await exchanged.json();
    const account = {
      access: String(tokens.access_token || ""),
      refresh: String(tokens.refresh_token || ""),
      clientId,
      // Notion's token responses have always named the workspace they are for; if this
      // one does not, the page says "linked" and no more — decoration, never a failure.
      workspace: String(tokens.workspace_name || ""),
    };
    if (!account.access) throw new Error("Notion sent no token back");
    writeNotion(account);
    notionSession = null;
    notionTools = null;
    return { workspace: account.workspace };
  } finally {
    server.close();
  }
}

ipcMain.handle("notion-connect", () => {
  if (!notionConnecting) {
    notionConnecting = notionConnect().finally(() => {
      notionConnecting = null;
    });
  }
  return notionConnecting;
});

ipcMain.handle("notion-status", () => {
  const account = readNotion();
  return account ? { linked: true, workspace: account.workspace } : { linked: false, workspace: "" };
});

ipcMain.handle("notion-forget", () => {
  try {
    fs.rmSync(notionFile());
  } catch {
    /* nothing stored */
  }
  notionSession = null;
  notionTools = null;
  return true;
});

ipcMain.handle("notion-search", async (_event, rawQuery) => {
  const query = String(rawQuery ?? "").trim();
  // An empty query means "what have I been in lately", and the server has a tool that
  // answers exactly that — searching for nothing answers with nothing.
  const request = query
    ? { tool: await notionTool(["notion-search", "search"]), args: { query } }
    : { tool: await notionTool(["notion-list-recent-pages", "list-recent"]), args: { limit: 40 } };
  const result = await notionCall("tools/call", { name: request.tool, arguments: request.args });
  const trouble = toolTrouble(result);
  if (trouble) throw trouble;
  return notionPages(result).slice(0, 40);
});

ipcMain.handle("notion-create", async (_event, rawTitle) => {
  const title = String(rawTitle ?? "").trim() || "Untitled";
  const tool = await notionTool(["notion-create-pages", "create-pages", "create-page"]);
  const result = await notionCall("tools/call", {
    name: tool,
    arguments: { pages: [{ properties: { title } }] },
  });
  const trouble = toolTrouble(result);
  if (trouble) throw trouble;
  const page = notionPages(result)[0];
  if (!page) throw new Error("Notion answered, but named no page it made");
  return { ...page, title: page.title || title };
});

/*
 * Microsoft Word. A document is a FILE — unlike a board or an Apple note, it lives on
 * the disk, not inside the app — so the pointer a note keeps is a path, and opening is
 * just handing that path to Word. What the app itself is asked for, over the AppleScript
 * dictionary it has carried for decades: making a document and saving it (one Automation
 * Allow click, macOS's, the first time). The recent list costs no launch at all: Word
 * writes it beside its own preferences, in a plist this shell can read directly.
 */
const WORD_APP = "/Applications/Microsoft Word.app";
const WORD_RECENTS = path.join(
  os.homedir(),
  "Library/Containers/com.microsoft.Word/Data/Library/Preferences/com.microsoft.Word.securebookmarks.plist",
);

/** Where new documents land when the vault has not said: made on first use, not before. */
const wordDefaultFolder = () => path.join(os.homedir(), "Documents", "word-bedrock");

/** The same reader Freeform's index gets: osascript's JavaScript, which alone among the
    always-there tools reads a binary plist whole, dates included. */
const WORD_RECENT_LIST = `
ObjC.import("Foundation");
const dict = ObjC.deepUnwrap($.NSDictionary.dictionaryWithContentsOfFile(${JSON.stringify(WORD_RECENTS)})) || {};
const out = [];
for (const key in dict) {
  if (!key.startsWith("file://")) continue;
  const file = decodeURIComponent(key.replace(/^file:\\/\\//, ""));
  if (!/\\.(docx?|docm|rtf)$/i.test(file)) continue;
  const at = dict[key] && dict[key].kLastUsedDateKey instanceof Date ? dict[key].kLastUsedDateKey.getTime() : 0;
  out.push({ path: file, at });
}
out.sort((a, b) => b.at - a.at);
JSON.stringify(out);`;

/** The path arrives as argv, never spliced into the script — a path is not code. No
    file format named on the save: modern Word's default IS .docx. */
const WORD_CREATE = `
on run argv
  set docPath to item 1 of argv
  tell application "Microsoft Word"
    set newDoc to make new document
    save as newDoc file name docPath
    activate
  end tell
end run`;

/** What a refusal actually means, said in directions rather than a code. */
function wordError(err) {
  const said = String((err && err.message) || err);
  if (said.includes("-1743") || /not authori[sz]ed/i.test(said)) {
    return new Error(
      "macOS is keeping Bedrock away from Word — System Settings → Privacy & Security → Automation → Bedrock → Microsoft Word",
    );
  }
  return new Error(said.trim() || "Word did not answer");
}

/** A document's name off its path: the basename, extension shed. */
const docTitle = (file) => path.basename(file).replace(/\.[^.]+$/, "");

ipcMain.handle("word-status", () => ({
  app: process.platform === "darwin" && fs.existsSync(WORD_APP),
}));

ipcMain.handle("word-recent", async (_event, limit = 30) => {
  try {
    const raw = await command("osascript", ["-l", "JavaScript", "-e", WORD_RECENT_LIST]);
    return JSON.parse(raw || "[]")
      .filter((doc) => fs.existsSync(doc.path)) // a recent that moved is not a thing to link
      .slice(0, Math.max(1, Number(limit) || 30))
      .map((doc) => ({ ...doc, title: docTitle(doc.path) }));
  } catch {
    return []; // no Word yet, or an empty container — both mean "nothing to offer"
  }
});

ipcMain.handle("word-create", async (_event, rawFolder, rawTitle) => {
  const folder = String(rawFolder || "").trim() || wordDefaultFolder();
  const title = (String(rawTitle ?? "").trim() || "Untitled").replace(/[/:]/g, "-");
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (err) {
    throw new Error(`that folder cannot be made — ${String(err.message || err)}`);
  }
  let target = path.join(folder, `${title}.docx`);
  for (let n = 2; fs.existsSync(target); n++) target = path.join(folder, `${title} ${n}.docx`);
  try {
    await command("osascript", ["-e", WORD_CREATE, target]);
  } catch (err) {
    throw wordError(err);
  }
  // Word resolving the save is the promise; the file is the proof. Its sandbox can
  // refuse a folder without saying so out loud, and a note must not point at nothing.
  if (!fs.existsSync(target)) {
    throw new Error(
      "Word ran, but no document appeared — its own file-access dialog may be waiting behind a window",
    );
  }
  return { path: target, title: docTitle(target), at: Date.now() };
});

ipcMain.handle("word-open", async (_event, rawPath) => {
  const target = String(rawPath || "");
  if (!path.isAbsolute(target)) return "missing";
  if (!fs.existsSync(target)) return "missing";
  // `open -a` rather than the default-app route: a .docx whose double-click belongs to
  // Pages must still open in Word from a Word node.
  await command("open", ["-a", WORD_APP, target]);
  return "opened";
});

ipcMain.handle("notion-open", (_event, rawUrl) => {
  const url = String(rawUrl || "");
  if (!/^https:\/\/([a-z0-9-]+\.)?notion\.(so|site|com)\//.test(url)) return false;
  // Whatever spelling the note holds, the page's id is what opens it: the classic
  // www.notion.so/<id> address works everywhere, and its notion:// spelling is the
  // deep link the desktop app has answered to for years. An address with no id in it
  // (a published notion.site, say) goes to the browser as it stands.
  const tail = url.split(/[?#]/)[0].split("/").pop() || "";
  const id = (/([0-9a-f]{32})$/.exec(tail.toLowerCase()) || [])[1];
  const hasApp = fs.existsSync("/Applications/Notion.app");
  const target = id
    ? hasApp
      ? `notion://www.notion.so/${id}`
      : `https://www.notion.so/${id}`
    : url;
  void shell.openExternal(target);
  return true;
});

/*
 * Google Tasks. A task note is a pointer at a task in Google Tasks — the checkbox items
 * that show on Google Calendar — and nothing more: the title, the due date and the tick
 * all live with Google. Linking is OAuth in the real browser, the way Notion's is: the
 * consent page opens, the code comes back on a loopback port, PKCE guards the exchange.
 * The client it rides is Bedrock's own — a "Desktop app" client in Bedrock's Google Cloud
 * project. Its id and secret ship inside the app (Google's model for installed apps has
 * them there: they say WHICH app is asking, and every token still needs a person clicking
 * Allow and lands only on that person's machine) but NOT inside the repository: the build
 * writes them to electron/google-client.json from the environment — .env locally, the
 * release workflow's secrets in CI — and that file is gitignored, so a clone carries no
 * client and says so. Anyone who would rather not wear Bedrock's name on the consent
 * screen can store a client of their own; both the tokens and that client are sealed with
 * the OS keychain into the app's folder, never the vault.
 */
const BUILT_CLIENT_FILE = path.join(__dirname, "google-client.json");

/** The client this build was made with, or null for a build made without one. */
function builtGoogleClient() {
  try {
    const stored = JSON.parse(fs.readFileSync(BUILT_CLIENT_FILE, "utf8"));
    if (typeof stored.id !== "string" || !stored.id) return null;
    return { id: stored.id, secret: typeof stored.secret === "string" ? stored.secret : "" };
  } catch {
    return null;
  }
}
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
/** Tasks, plus the address of the account — the settings page says whose tasks these are. */
const GOOGLE_SCOPES = "https://www.googleapis.com/auth/tasks openid email";
const TASKS_API = "https://tasks.googleapis.com/tasks/v1/";
/** Where a click lands when a task carries no address of its own. */
const TASKS_HOME = "https://tasks.google.com/";
const googleFile = () => path.join(app.getPath("userData"), "google.json");
const googleClientFile = () => path.join(app.getPath("userData"), "google-client.json");

/** A client of the person's own, when one has been stored; null rides Bedrock's. */
function readGoogleClient() {
  try {
    const stored = JSON.parse(fs.readFileSync(googleClientFile(), "utf8"));
    if (typeof stored.id !== "string" || !stored.id) return null;
    return { id: stored.id, secret: stored.secret ? unseal(stored.secret) : "" };
  } catch {
    return null;
  }
}
/** The client to ask Google with: the person's own first, else the build's. Throws for neither. */
function googleClient() {
  const client = readGoogleClient() || builtGoogleClient();
  if (!client) {
    throw new Error(
      "this build carries no Google client — Settings → Integrations → Google Tasks → Use my own…, with a client from your own Google Cloud project",
    );
  }
  return client;
}

function readGoogle() {
  try {
    const stored = JSON.parse(fs.readFileSync(googleFile(), "utf8"));
    if (typeof stored.access !== "string") return null;
    return {
      access: unseal(stored.access),
      refresh: typeof stored.refresh === "string" && stored.refresh ? unseal(stored.refresh) : "",
      expires: Number(stored.expires) || 0,
      email: typeof stored.email === "string" ? stored.email : "",
    };
  } catch {
    return null; // never linked, or the keychain refused — both mean "not linked"
  }
}

function writeGoogle(account) {
  fs.mkdirSync(path.dirname(googleFile()), { recursive: true });
  fs.writeFileSync(
    googleFile(),
    JSON.stringify({
      version: 1,
      access: seal(account.access),
      refresh: account.refresh ? seal(account.refresh) : "",
      expires: account.expires,
      email: account.email,
    }),
    { mode: 0o600 },
  );
}

/**
 * The address inside an id_token — read, not verified: it arrived over TLS straight from
 * Google's token endpoint, and all it does here is decorate the settings page.
 */
function emailOf(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString("utf8"));
    return String(payload.email || "");
  } catch {
    return "";
  }
}

/** One round with the token endpoint. Throws Google's own words, with its code alongside. */
async function googleTokens(body) {
  const response = await net.fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const tokens = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(tokens.error_description || tokens.error || `Google said ${response.status}`), {
      code: tokens.error || response.status,
    });
  }
  return tokens;
}

async function googleConnect() {
  const client = googleClient();
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const redirect = `http://127.0.0.1:${port}/callback`;

  try {
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(16));
    const authUrl = new URL(GOOGLE_AUTH);
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.id,
      redirect_uri: redirect,
      scope: GOOGLE_SCOPES,
      state,
      code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      // A refresh token too, so the link outlives the hour — and a consent screen every
      // time, because Google hands a refresh token out only with one actually shown.
      access_type: "offline",
      prompt: "consent",
    }).toString();

    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("the browser never came back — try linking again")),
        5 * 60 * 1000,
      );
      server.on("request", (request, response) => {
        const url = new URL(request.url, `http://127.0.0.1:${port}`);
        if (url.pathname !== "/callback") {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<body style='font:15px system-ui;padding:3em;color:#333'>Bedrock is connected to Google Tasks — this tab can close.</body>",
        );
        clearTimeout(timer);
        if (url.searchParams.get("error")) {
          reject(new Error(url.searchParams.get("error_description") || "you said no in the browser"));
        } else if (url.searchParams.get("state") !== state) {
          reject(new Error("the browser came back with somebody else's answer"));
        } else {
          resolve(String(url.searchParams.get("code") || ""));
        }
      });
      void shell.openExternal(authUrl.toString());
    });

    const tokens = await googleTokens({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      client_id: client.id,
      client_secret: client.secret,
      code_verifier: verifier,
    });
    const account = {
      access: String(tokens.access_token || ""),
      refresh: String(tokens.refresh_token || ""),
      expires: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
      email: emailOf(tokens.id_token),
    };
    if (!account.access) throw new Error("Google sent no token back");
    // Google's consent screen offers each permission as its own checkbox, unticked, and
    // "Continue" with the tasks box left empty hands back a token good for nothing here.
    // Refused now, in words, rather than at the first task that fails.
    if (!String(tokens.scope || "").includes("/auth/tasks")) {
      throw new Error(
        "Google linked the account but without access to tasks — link again and, on Google's screen, tick the box for tasks before you continue",
      );
    }
    writeGoogle(account);
    return { email: account.email };
  } finally {
    server.close();
  }
}

/**
 * A fresh access token off the refresh token. `invalid_grant` is the one answer worth
 * translating: the person revoked Bedrock, or the client is still in Google's "testing"
 * publishing state, where every grant dies after seven days — either way, link again.
 */
async function googleRefresh(account) {
  const client = googleClient();
  let tokens;
  try {
    tokens = await googleTokens({
      grant_type: "refresh_token",
      refresh_token: account.refresh,
      client_id: client.id,
      client_secret: client.secret,
    });
  } catch {
    throw new Error("Google signed this app out — link the account again");
  }
  const next = {
    ...account,
    access: String(tokens.access_token || account.access),
    expires: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
  };
  writeGoogle(next);
  return next;
}

/** Google's errors, in the words a person will actually meet. */
function googleError(status, body) {
  const message = body && body.error && body.error.message ? String(body.error.message) : "";
  if (status === 404) return "that task is not in Google Tasks any more";
  if (status === 403 && /insufficient.*scopes/i.test(message)) {
    return "the link has no access to tasks — link the account again, and tick the box for tasks on Google's screen";
  }
  if (status === 403 && /accessNotConfigured|has not been used|is disabled/i.test(message)) {
    return "the Tasks API is not switched on in this client's Google Cloud project";
  }
  if (status === 429 || (status === 403 && /quota|rate/i.test(message))) return "Google is rate-limiting — try again in a moment";
  return message ? `Google said: ${message}` : `Google said ${status}`;
}

/**
 * One Tasks API call with the stored token, renewed when it has aged out or Google says
 * so. Resolves with the JSON, null for an empty answer; throws Google's words. A 404 is
 * thrown with its code kept, so a status poll can read "gone" off it.
 */
async function tasksFetch(route, init) {
  let account = readGoogle();
  if (!account) throw new Error("Google is not linked — Settings → Integrations → Google Tasks");
  if (account.refresh && account.expires && account.expires - 60 * 1000 < Date.now()) {
    account = await googleRefresh(account);
  }
  for (let attempt = 0; ; attempt++) {
    const response = await net.fetch(TASKS_API + route, {
      ...init,
      headers: { ...((init && init.headers) || {}), authorization: `Bearer ${account.access}`, accept: "application/json" },
    });
    if (response.status === 401 && attempt < 1 && account.refresh) {
      account = await googleRefresh(account);
      continue;
    }
    if (response.status === 401) throw new Error("Google signed this app out — link the account again");
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(googleError(response.status, body)), { code: response.status });
    return body;
  }
}

/** A task as the pointer a note keeps: where it is, what it says, and whether it is done. */
function taskRow(list, task) {
  const stamp = (value) => (value ? Date.parse(String(value)) || 0 : 0);
  return {
    list,
    id: String(task.id || ""),
    title: String(task.title || "").replace(/\s+/g, " ").trim(),
    status: task.status === "completed" ? "completed" : "needsAction",
    due: stamp(task.due),
    completed: stamp(task.completed),
    updated: stamp(task.updated),
    url: String(task.webViewLink || ""),
  };
}

/** Every page of a list's tasks. Capped, because a list nobody ever clears can run long. */
async function allTasks(list, params) {
  const out = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ maxResults: "100", ...params, ...(pageToken ? { pageToken } : {}) });
    const page = (await tasksFetch(`lists/${encodeURIComponent(list)}/tasks?${query}`)) || {};
    for (const task of page.items || []) out.push(task);
    pageToken = String(page.nextPageToken || "");
  } while (pageToken && out.length < 1000);
  return out;
}

let googleConnecting = null;

ipcMain.handle("google-connect", () => {
  if (!googleConnecting) {
    googleConnecting = googleConnect().finally(() => {
      googleConnecting = null;
    });
  }
  return googleConnecting;
});

ipcMain.handle("google-status", () => {
  const account = readGoogle();
  return {
    linked: !!account,
    email: account ? account.email : "",
    ownClient: !!readGoogleClient(),
    builtClient: !!builtGoogleClient(),
  };
});

ipcMain.handle("google-forget", async () => {
  const account = readGoogle();
  // Told to Google too, so the grant leaves the account's "third-party access" list; a
  // revoke that fails changes nothing here — the tokens are gone from this machine anyway.
  if (account) {
    await net
      .fetch(`${GOOGLE_REVOKE}?token=${encodeURIComponent(account.refresh || account.access)}`, { method: "POST" })
      .catch(() => null);
  }
  try {
    fs.rmSync(googleFile());
  } catch {
    /* nothing stored */
  }
  return true;
});

/**
 * A client of the person's own — id and secret from their Google Cloud project — or, with
 * an empty id, back to Bedrock's. Changing clients unlinks: a token belongs to the client
 * that asked for it.
 */
ipcMain.handle("google-client", (_event, rawId, rawSecret) => {
  const id = String(rawId || "").trim();
  const secret = String(rawSecret || "").trim();
  try {
    fs.rmSync(googleFile());
  } catch {
    /* nothing stored */
  }
  if (!id) {
    try {
      fs.rmSync(googleClientFile());
    } catch {
      /* nothing stored */
    }
    return false;
  }
  if (!/\.apps\.googleusercontent\.com$/.test(id)) {
    throw new Error("that is not a Google OAuth client id — one ends in .apps.googleusercontent.com");
  }
  fs.mkdirSync(path.dirname(googleClientFile()), { recursive: true });
  fs.writeFileSync(googleClientFile(), JSON.stringify({ version: 1, id, secret: secret ? seal(secret) : "" }), {
    mode: 0o600,
  });
  return true;
});

/** The account's task lists — "My Tasks" and whatever else was made. */
ipcMain.handle("google-lists", async () => {
  const body = (await tasksFetch("users/@me/lists?maxResults=100")) || {};
  return (body.items || []).map((list) => ({
    id: String(list.id || ""),
    title: String(list.title || "").trim() || "Untitled list",
  }));
});

/** A list's open tasks, in the order Google keeps them — what a note can be attached to. */
ipcMain.handle("google-tasks", async (_event, rawList) => {
  const list = String(rawList || "").trim() || "@default";
  const tasks = await allTasks(list, { showCompleted: "false", showHidden: "false" });
  return tasks.filter((task) => !task.deleted).map((task) => taskRow(list, task));
});

/** Makes a task titled `title` in `list` and resolves with it. */
ipcMain.handle("google-task-create", async (_event, rawList, rawTitle) => {
  const list = String(rawList || "").trim() || "@default";
  const title = String(rawTitle || "").trim() || "Untitled";
  const task = await tasksFetch(`lists/${encodeURIComponent(list)}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!task || !task.id) throw new Error("Google answered, but named no task it made");
  return taskRow(list, task);
});

/**
 * Where each of `refs` (`list/id`) stands now — one read per task, a few at a time. A
 * task Google no longer has comes back null. Trouble with one task is that task's alone
 * and leaves it out of the answer, so one bad row never fails the round for the rest;
 * only a dead login stops the round, because every row would hit it.
 */
ipcMain.handle("google-task-status", async (_event, rawRefs) => {
  const refs = Array.isArray(rawRefs) ? rawRefs.map((ref) => String(ref || "")).filter(Boolean) : [];
  const out = {};
  const lookup = async (ref) => {
    const slash = ref.indexOf("/");
    if (slash <= 0) return;
    const list = ref.slice(0, slash);
    const id = ref.slice(slash + 1);
    try {
      const task = await tasksFetch(`lists/${encodeURIComponent(list)}/tasks/${encodeURIComponent(id)}`);
      out[ref] = task && !task.deleted ? taskRow(list, task) : null;
    } catch (err) {
      if (err && err.code === 404) out[ref] = null;
      else if (/link the account again|not linked/.test(String(err && err.message))) throw err;
    }
  };
  for (let i = 0; i < refs.length; i += 6) await Promise.all(refs.slice(i, i + 6).map(lookup));
  return out;
});

/** Opens THE task in Google Tasks on the web, or the Tasks app itself for one with no address. */
ipcMain.handle("google-open", (_event, rawUrl) => {
  const url = String(rawUrl || "").trim();
  let target = new URL(TASKS_HOME);
  try {
    const parsed = new URL(url);
    if (/(^|\.)google\.com$/.test(parsed.hostname)) target = parsed;
  } catch {
    /* no address on the note — the app's front door then */
  }
  // A browser signed into several Google accounts opens the link under whichever is its
  // default, and a task that lives in another account is simply not found — Tasks then
  // falls back to the overview. Naming the linked account pins the tab to the right one.
  const account = readGoogle();
  if (account && account.email && !target.searchParams.has("authuser")) target.searchParams.set("authuser", account.email);
  void shell.openExternal(target.toString());
  return true;
});

app.whenReady().then(() => {
  protocol.handle("app", serve);
  if (process.platform === "darwin" && !app.isPackaged && fs.existsSync(DEV_ICON)) {
    app.dock.setIcon(DEV_ICON);
  }
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closing the LAST window quits, so "off" stays unambiguous however many projects were up.
app.on("window-all-closed", () => app.quit());
