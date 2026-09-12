/**
 * The plaque in the corner when a newer Bedrock has been downloaded. Nothing shows for
 * the check or the download — the shell does both on its own — only for the one moment
 * there is something to do: restart now, or not. "Later" folds the plaque away for this
 * version and the update installs itself when the app next quits anyway, so declining
 * costs nothing and the plaque never has to nag.
 *
 * Anchored to the window, not the sidebar: the sidebar folds to a rail and is gone in
 * graph mode, and a plaque that moved with it would be a plaque that vanished with it.
 */
export function mountUpdates(host: HTMLElement): void {
  const bridge = window.bedrock;
  if (!bridge) return; // a browser tab updates by reload

  /** The version whose plaque was closed with "Later" — shown again only for a newer one. */
  let declined: string | null = null;

  const show = (info: UpdateInfo): void => {
    if (!info || info.version === declined) return;
    host.innerHTML =
      `<span class="update-word">Bedrock ${escapeHtml(info.version)} is ready</span>` +
      `<button type="button" class="update-go">Restart now</button>` +
      `<button type="button" class="update-later" title="It installs when Bedrock next quits">Later</button>`;
    host.dataset.version = info.version;
    host.classList.add("open");
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

  bridge.onUpdateReady(show);
  // This window may have opened after the download finished and the message went out.
  void bridge.updateStatus().then((info) => info && show(info)).catch(() => undefined);
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
