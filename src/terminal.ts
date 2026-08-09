// The session window: an xterm.js drawing whatever `tmux attach` sends, and sending back
// whatever is typed. That is the whole file, and deliberately so — every decision about
// what a session IS was made before this window opened. It owns no state, saves nothing,
// and closing it detaches rather than ends, because the thing on the other end of the pty
// belongs to tmux rather than to this app.

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
// For the app's colour variables and `.hidden`; this window should look like Bedrock's.
import "./style.css";

/** The app's own colours, so a session looks like it belongs in Bedrock. */
const THEME = {
  background: "#1e1e1e",
  foreground: "#dcddde",
  cursor: "#dcddde",
  cursorAccent: "#1e1e1e",
  selectionBackground: "rgba(249, 36, 17, 0.30)",
  black: "#1e1e1e",
  red: "#f85149",
  green: "#3fb950",
  yellow: "#e3b341",
  blue: "#4c8dff",
  magenta: "#c56cf0",
  cyan: "#2dd4bf",
  white: "#dcddde",
  brightBlack: "#8b949e",
  brightRed: "#ff7b72",
  brightGreen: "#56d364",
  brightYellow: "#f0e2b6",
  brightBlue: "#79b8ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#5ee6d6",
  brightWhite: "#ffffff",
};

const bridge = window.bedrock;
const host = document.getElementById("term")!;
const ended = document.getElementById("term-ended")!;
// The id rides in the hash rather than a query, so it never reaches a server or a log.
const session = decodeURIComponent(location.hash.slice(1));

if (!bridge || !session) {
  ended.textContent = "This window needs the desktop app.";
  ended.classList.remove("hidden");
} else {
  const term = new Terminal({
    theme: THEME,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    // tmux keeps the real scrollback; a second buffer here would only fight it.
    scrollback: 0,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();

  void bridge.termAttach({ id: session, cols: term.cols, rows: term.rows });

  bridge.onTermData((data) => term.write(data));
  bridge.onTermEnded(() => {
    ended.classList.remove("hidden");
    term.blur();
  });
  term.onData((data) => bridge.termInput(data));

  /*
   * tmux sizes a session to its smallest attached client, so the size this window reports
   * is the size the CLI draws for. Debounced through a frame: a drag emits a resize per
   * pixel, and every one of those would be a redraw of the whole TUI.
   */
  let pending = 0;
  const resize = (): void => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      fit.fit();
      bridge.termResize(term.cols, term.rows);
    });
  };
  new ResizeObserver(resize).observe(host);
  window.addEventListener("resize", resize);

  term.focus();
  // A click anywhere in the window belongs to the session, not to the page around it.
  host.addEventListener("mousedown", () => term.focus());
}
