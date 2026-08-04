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

/**
 * Pick one of a few known answers, or type your own — the shape of a question that has
 * usual answers without being limited to them. Resolves to the chosen string, or null if
 * it was dismissed.
 */
export function askChoice(
  message: string,
  choices: string[],
  typeLabel = "Somewhere else…",
  typePrompt = message,
  typeInitial?: string,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const box = overlay();
    box.classList.add("open");
    box.innerHTML =
      `<div class="dialog-card">` +
      `<div class="dialog-title"></div>` +
      `<div class="dialog-choices"></div>` +
      `<div class="dialog-row"><button class="dialog-cancel">Cancel</button></div>` +
      `</div>`;
    box.querySelector<HTMLElement>(".dialog-title")!.textContent = message;
    const list = box.querySelector<HTMLElement>(".dialog-choices")!;
    for (const choice of choices) {
      const button = document.createElement("button");
      button.className = "dialog-choice";
      button.textContent = choice;
      button.onclick = () => {
        close();
        resolve(choice);
      };
      list.appendChild(button);
    }
    const other = document.createElement("button");
    other.className = "dialog-choice other";
    other.textContent = typeLabel;
    other.onclick = () => {
      close();
      // Chained rather than nested: the typed answer IS the answer to this question.
      void askText(typePrompt, typeInitial ?? choices[0] ?? "", "Use this").then(resolve);
    };
    list.appendChild(other);
    const done = (): void => {
      close();
      resolve(null);
    };
    box.querySelector<HTMLElement>(".dialog-cancel")!.onclick = done;
    box.onmousedown = (event) => {
      if (event.target === box) done();
    };
    box.onkeydown = (event) => {
      event.stopPropagation();
      if (event.key === "Escape") done();
    };
    list.querySelector<HTMLButtonElement>(".dialog-choice")?.focus();
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
