# bedrock

A markdown vault whose graph is the place you actually work, not a picture of it.

## Demo

![Demo](bedrock_demo.gif)

## Installation

macOS, and a `bedrock` command you can run from anywhere:

```bash
git clone https://github.com/Novelty-Labs-Stuhi/bedrock.git
cd bedrock
npm install
npm install -g .
```

`npm install` fetches the dependencies and builds the app. `npm install -g .` puts
`bedrock` on your `PATH` — it links this checkout rather than copying it, so leave
the clone where it is, and after a `git pull` the next `bedrock` rebuilds whatever
changed.

## Usage

```bash
bedrock
```

From any directory. The window opens detached, so the terminal stays free and
closing it does not take the app down with it.

- `bedrock` — start it, building first if the sources moved on
- `bedrock stop` — quit the app (⌘Q in the window does the same)
- `bedrock restart` — stop, then start
- `bedrock status` — whether it is running
- `bedrock build` — build once, with the output shown
- `bedrock dev` — vite dev server on `:5183`, for working on the app itself

## Features

Toggle in Settings:

- **Stickies** — loose text pinned to the canvas
- **Todos** — checklist stickies that can point an arrow at a note
- **Git** — a commit button that snapshots the vault (desktop app)
- **Gemini** — conversation notes: rectangles that open the chat in the browser
