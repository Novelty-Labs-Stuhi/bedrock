// The one place that loads MathLive.
//
// The library is most of a megabyte and the overwhelming majority of notes hold no formula at
// all, so it is imported on demand and the promise kept: the first `$…$` to reach the screen
// pays for it, every later one is free.
//
// Fonts are the other reason this is a module rather than a bare `import()`. Left alone MathLive
// injects its own `@font-face` rules pointing at a CDN, which is the wrong answer for an app whose
// whole premise is local files — a fraction should still draw with the network off, and on the
// `app://` scheme there is no CDN to reach anyway. Importing the stylesheet here puts the KaTeX
// faces through Vite instead, so they land in `dist/assets` hashed like every other asset, and
// `fontsDirectory = null` is how MathLive is told they are already on the page. The browser still
// fetches each face lazily, the first time something actually needs that glyph.

import "mathlive/fonts.css";
import "mathlive/static.css";

type MathLive = typeof import("mathlive");

let pending: Promise<MathLive> | null = null;
let library: MathLive | null = null;

/** Woken when the library lands, so a formula drawn before it arrived can draw itself again. */
const waiting = new Set<() => void>();

export function loadMathLive(): Promise<MathLive> {
  if (pending) return pending;
  pending = import("mathlive").then((lib) => {
    lib.MathfieldElement.fontsDirectory = null;
    lib.MathfieldElement.soundsDirectory = null;
    library = lib;
    for (const wake of waiting) wake();
    waiting.clear();
    return lib;
  });
  return pending;
}

/** The library, or null while it is still on its way. For paths that cannot wait — `toDOM`. */
export const mathLive = (): MathLive | null => library;

/**
 * A formula as HTML, or null if it cannot be drawn yet. Two quite different reasons come back as
 * the same answer, and both callers want the same thing from it — show the source instead:
 * the library has not loaded, or the LaTeX does not parse, which is the normal state of a
 * formula halfway through being typed rather than an error worth reporting.
 */
export function mathMarkup(latex: string): string | null {
  if (!library) return null;
  try {
    return library.convertLatexToMarkup(latex);
  } catch {
    return null;
  }
}

/** Runs `then` when the library is loaded, starting the load if nobody else has. */
export function whenMathLive(then: () => void): void {
  if (library) return then();
  waiting.add(then);
  void loadMathLive();
}
