/**
 * The plaque in the bottom-left corner when there is a newer Bedrock. It comes up as soon
 * as the shell finds one — "downloading", with how far it has got — and turns into the one
 * moment there is something to do: restart now, or not. "Later" folds the plaque away for
 * this version and the update installs itself when the app next quits anyway, so declining
 * costs nothing and the plaque never has to nag. Above the vault picker, which is what a
 * window opens on, so a launch is where it is seen.
 *
 * Anchored to the window, not the sidebar: the sidebar folds to a rail and is gone in
 * graph mode, and a plaque that moved with it would be a plaque that vanished with it.
 */
export function mountUpdates(host: HTMLElement): void {
  const bridge = window.bedrock;
  if (!bridge) return; // a browser tab updates by reload

  /** The version whose plaque was closed with "Later" — shown again only for a newer one. */
  let declined: string | null = null;

  const show = (info: UpdateInfo | null): void => {
    if (!info || info.version === declined) {
      host.classList.remove("open");
      return;
    }
    const version = escapeHtml(info.version);
    host.dataset.version = info.version;
    host.classList.add("open");
    if (!info.ready) {
      host.innerHTML =
        `<span class="update-dot"></span>` +
        `<span class="update-word">Bedrock ${version} is downloading… ${info.percent}%</span>`;
      return;
    }
    // Ready: built once, so a click on Restart now is not undone by a repeat of the message.
    if (host.dataset.ready === info.version) return;
    host.dataset.ready = info.version;
    host.innerHTML =
      `<span class="update-dot ready"></span>` +
      `<span class="update-word">Bedrock ${version} is ready</span>` +
      `<button type="button" class="update-go">Restart now</button>` +
      `<button type="button" class="update-later" title="It installs when Bedrock next quits">Later</button>`;
  };

  host.addEventListener("click", (event) => {
    const hit = (event.target as HTMLElement).closest("button");
    if (!hit) return;
    if (hit.classList.contains("update-go")) {
      hit.disabled = true;
      hit.textContent = "Restarting…";
      void bridge.updateInstall().then((went) => {
        if (went) return;
        // The shell has nothing to install after all — the state moved on under the plaque.
        host.classList.remove("open");
      });
      return;
    }
    declined = host.dataset.version ?? null;
    host.classList.remove("open");
  });

  bridge.onUpdateState(show);
  // This window may have opened after the update was found and the message went out.
  void bridge.updateStatus().then(show).catch(() => undefined);
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
