# bedrock

A markdown vault whose graph is the place you actually work, not a picture of it.

---

## Install

You need [Node.js](https://nodejs.org) 18 or newer. Nothing else — no account, no server.

```bash
git clone https://github.com/Novelty-Labs-Stuhi/bedrock.git
cd bedrock
npm install
npm start
```

`npm start` builds the app and opens it. That is the whole install.

It launches on a small built-in demo vault so there is something to look at. To use your
own notes, click **Open folder…** and pick any directory of `.md` files — your existing
Obsidian vault works as-is.

### Run it from anywhere

```bash
echo 'alias bedrock="'"$PWD"'/bin/notes"' >> ~/.zshrc && source ~/.zshrc
```

Then `bedrock` from any directory. It rebuilds only when sources changed and detaches, so
closing the terminal does not close the app.

| command | |
| --- | --- |
| `bedrock` | start it (or focus it if already running) |
| `bedrock stop` | quit |
| `bedrock status` | is it running |
| `bedrock dev` | vite dev server on `:5183`, with hot reload |

---

## Vision

Note-taking tools treat the graph as an afterthought: a read-only constellation you open
once, admire, and close. The notes live in the sidebar; the graph is a poster of them.

bedrock inverts that. **The canvas is the vault.** Where a note sits is information you
authored, as real as the words in it — and it is remembered, so the arrangement you build
over months is still there tomorrow.

That leads to a few positions the app takes seriously:

**Space is content.** Drag a note and it stays where you put it, across restarts. The
solver runs once, on a vault it has never seen; after that nothing rearranges itself
behind your back. The arrangement is cached in the vault's own `.notes/` folder, so it
travels with the notes rather than living in some browser's local storage.

**Structure is drawn, not declared.** You do not create an empty folder and then file
things into it. You draw a rectangle around the notes that belong together and the folder
is made around them — sized and placed exactly as you drew it. Folders are boxes with real
edges; a note inside one stays inside it.

**Everything is a file you own.** Notes are plain markdown with `[[wikilinks]]`. Move or
rename anything and every reference to it is rewritten across the vault. There is no
database, no proprietary format, and no step between what you see and what is on disk.

**The graph carries meaning, not just topology.** A note's size is how many notes point at
it, so hubs are obvious without reading a word. Its colour is its `#tags` — two tags split
the circle in half, three into thirds. Connections can be named (`built with:: [[X]]`) and
the name is written into the markdown, not into app state.

**Nothing is modal.** Naming happens in a field on the node. Linking is a right-drag from
one note to another. Stickies are loose text pinned to the canvas for the thoughts that
are not notes yet.

---

## What it does

- **Notes** — markdown, `[[wikilinks]]`, images by drag/paste, split-pane editing, live
  preview that drops into edit mode when you click the text.
- **Graph** — folders as boxes, notes sized by backlinks and coloured by tags, named
  edges, drag to refile, right-drag to link.
- **Folders by rectangle** — right-click → *New folder*, then drag a box around the notes.
  Shift+drag does the same thing without the menu.
- **Links that survive** — renaming or moving a note rewrites every `[[link]]` pointing at
  it, preserving aliases, `#headings` and relation labels.
- **Stickies** — right-click → *New sticky*. Grows as you type, rescalable, pinned to the
  canvas.
- **Tree** — drag files between folders, right-click for paths, foldable sidebar.
- **Durable layout** — positions and box sizes cached in `.notes/layout.json`.

## Vault layout

Your vault is just a folder of markdown. bedrock adds one hidden directory:

```
your-vault/
  Home.md
  ideas/Graphs.md
  .notes/
    layout.json      graph positions and folder box sizes  (derived — safe to delete)
    stickies.json    sticky text, position and size        (content — not derived)
```

Anything under a dot-prefixed folder is app state and never appears as a note.

## Development

```bash
npm run dev      # vite on :5183, hot reload in the browser
npm run build    # typecheck + bundle to dist/
npm run app      # electron against the current dist/
```

`src/` is plain TypeScript with no framework. The renderer is [cytoscape.js]; the layout
is a solver in `layout.ts` and `apply-layout.ts` rather than a force simulation, so the
same vault always lands the same way.

| file | |
| --- | --- |
| `main.ts` | app shell: panes, tabs, vault wiring |
| `graph.ts` | the canvas — nodes, boxes, stickies, gestures |
| `layout.ts` `apply-layout.ts` | the arrangement solver |
| `frames.ts` | fixed-size folder boxes |
| `vault.ts` | localStorage and File System Access backends |
| `links.ts` | `[[wikilink]]` and `#tag` parsing, link rewriting |
| `spatial.ts` `sticky.ts` | what gets cached in `.notes/` |

[cytoscape.js]: https://js.cytoscape.org
