// Small markdown renderer — enough for note reading, no dependency.
// [[wikilinks]] become <a data-link="…"> so the app can route clicks itself.

import { parseLinks } from "./links";
import { basename, isImage } from "./vault";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Image embeds. The src is emitted as `data-vault-src`, NOT `src`: an attachment lives inside the
 * vault (localStorage or a picked folder), so it has no URL until something reads its bytes —
 * `hydrateImages` in ``images.ts`` does that after the HTML is in the DOM. Both spellings are
 * accepted: Obsidian's `![[screenshots/x.png]]` and markdown's `![alt](screenshots/x.png)`.
 * A remote `http(s)` src is left as a normal `src` — nothing to resolve.
 */
function images(html: string): string {
  html = html.replace(/!\[\[([^\][|]+)(?:\|([^\][]*))?\]\]/g, (match, target: string, alt?: string) => {
    const src = target.trim();
    if (!isImage(src)) return match; // a note transclusion, not an image — leave it alone
    return `<img class="embed" data-vault-src="${src}" alt="${(alt ?? basename(src)).trim()}" />`;
  });
  return html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => {
    if (/^(https?:|data:)/i.test(src)) return `<img class="embed" src="${src}" alt="${alt}" />`;
    let path = src;
    try {
      path = decodeURIComponent(src);
    } catch {
      /* a stray % in the path — use it verbatim */
    }
    return `<img class="embed" data-vault-src="${path}" alt="${alt}" />`;
  });
}

function inline(text: string): string {
  let html = images(escapeHtml(text));
  html = html.replace(/\[\[([^\][|]+)(?:\|([^\][]*))?\]\]/g, (_m, target: string, alias?: string) => {
    const t = escapeHtml(target.trim());
    return `<a class="wikilink" data-link="${t}">${escapeHtml((alias ?? target).trim())}</a>`;
  });
  // A named connection (`built with:: [[Target]]`) reads as the relation followed by the link,
  // not as raw `::` syntax. Only a name that sits at the start of the line counts — same rule the
  // parser uses, so what the graph labels an edge with is exactly what the note shows.
  html = html.replace(
    /(^|<br\s*\/?>)([\s]*(?:[-*+>]\s*)?)([^:<\n][^:<\n]{0,58}?)\s*::\s*(?=<a class="wikilink")/g,
    (_m, start: string, marker: string, name: string) =>
      `${start}${marker}<span class="rel">${name}</span> `,
  );
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  html = html.replace(
    /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );
  return html;
}

/** Renders markdown to HTML. Block-level: headings, lists, quotes, fenced code. */
export function renderMarkdown(text: string): string {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  let list: "ul" | "ol" | null = null;
  let fence: string[] | null = null;

  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const openList = (kind: "ul" | "ol") => {
    if (list !== kind) {
      closeList();
      out.push(`<${kind}>`);
      list = kind;
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (fence) {
        out.push(`<pre><code>${escapeHtml(fence.join("\n"))}</code></pre>`);
        fence = null;
      } else {
        closeList();
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      openList("ul");
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      openList("ol");
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (fence) out.push(`<pre><code>${escapeHtml(fence.join("\n"))}</code></pre>`);
  return out.join("\n");
}

/** Distinct link targets in a document — used for the graph and backlinks. */
export function linkTargets(text: string): string[] {
  return [...new Set(parseLinks(text).map((l) => l.target))];
}
