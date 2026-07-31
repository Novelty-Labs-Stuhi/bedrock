// Modal confirmation. Electron's renderer throws on window.confirm()'s sibling
// window.prompt() ("prompt() is not supported."), so this app owns its own UI.
// Naming is never modal — see inline.ts (graph) and Sidebar.beginRename (tree).

type Resolve<T> = (value: T) => void;

let host: HTMLElement | null = null;

function overlay(): HTMLElement {
  if (!host) {
    host = document.createElement("div");
    host.id = "dialog";
    document.body.appendChild(host);
  }
  return host;
}

function close(): void {
  if (host) host.innerHTML = "";
  host?.classList.remove("open");
}

/** One-line text prompt. Resolves to null when dismissed or left blank. */
export function askText(message: string, initial = "", okLabel = "OK"): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const done: Resolve<string | null> = (value) => {
      close();
      resolve(value);
    };
    const box = overlay();
    box.classList.add("open");
    box.innerHTML =
      `<div class="dialog-card">` +
      `<div class="dialog-title"></div>` +
      `<input class="dialog-input" type="text" spellcheck="false" />` +
      `<div class="dialog-row">` +
      `<button class="dialog-cancel">Cancel</button>` +
      `<button class="dialog-ok"></button>` +
      `</div></div>`;

    box.querySelector<HTMLElement>(".dialog-title")!.textContent = message;
    const input = box.querySelector<HTMLInputElement>(".dialog-input")!;
    input.value = initial;
    const ok = box.querySelector<HTMLButtonElement>(".dialog-ok")!;
    ok.textContent = okLabel;
    const commit = () => done(input.value.trim() || null);
    ok.onclick = commit;
    box.querySelector<HTMLElement>(".dialog-cancel")!.onclick = () => done(null);
    box.onmousedown = (event) => {
      if (event.target === box) done(null);
    };
    box.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === "Escape") done(null);
      else if (event.key === "Enter") commit();
    };
    input.focus();
    input.select();
  });
}

/** Yes/no confirmation, styled like askText so the app looks of a piece. */
export function askConfirm(message: string, confirmLabel = "Delete"): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const done: Resolve<boolean> = (value) => {
      close();
      resolve(value);
    };
    const box = overlay();
    box.classList.add("open");
    box.innerHTML =
      `<div class="dialog-card">` +
      `<div class="dialog-title"></div>` +
      `<div class="dialog-row">` +
      `<button class="dialog-cancel">Cancel</button>` +
      `<button class="dialog-ok danger"></button>` +
      `</div></div>`;

    box.querySelector<HTMLElement>(".dialog-title")!.textContent = message;
    const ok = box.querySelector<HTMLButtonElement>(".dialog-ok")!;
    ok.textContent = confirmLabel;
    ok.onclick = () => done(true);
    box.querySelector<HTMLElement>(".dialog-cancel")!.onclick = () => done(false);
    box.onmousedown = (event) => {
      if (event.target === box) done(false);
    };
    box.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === "Escape") done(false);
      else if (event.key === "Enter") done(true);
    };
    ok.focus();
  });
}
