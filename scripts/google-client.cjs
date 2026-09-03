#!/usr/bin/env node
// Writes electron/google-client.json — the Google OAuth client the app signs in with —
// from GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Runs at the head of `npm run build`.
//
// The file is gitignored on purpose: GitHub's push protection (rightly) refuses a client
// secret in a commit, so the values live in .env locally and in the release workflow's
// secrets in CI, and only the built app carries them. With neither variable set, a file
// already there is left alone (a dev machine that wrote it once), and without one at all
// the build still succeeds — that app just says it has no client, and Settings offers
// the person's own.
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const target = path.join(root, "electron", "google-client.json");

/**
 * .env, read here rather than sourced by the shell: `npm run build` is what everything
 * else calls, and it should find the client without a `set -a; . ./.env` in front of it.
 * A variable already in the environment (CI) wins over the file.
 */
function dotenv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !m[1].startsWith("#")) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch {
    /* no .env — a CI runner, or a clone that never set one up */
  }
  return out;
}

const env = { ...dotenv(), ...process.env };
const id = (env.GOOGLE_CLIENT_ID || "").trim();
const secret = (env.GOOGLE_CLIENT_SECRET || "").trim();

if (id) {
  fs.writeFileSync(target, JSON.stringify({ id, secret }, null, 2) + "\n", { mode: 0o600 });
  console.log(`google-client: wrote ${path.relative(process.cwd(), target)} for ${id}`);
} else if (fs.existsSync(target)) {
  console.log("google-client: GOOGLE_CLIENT_ID not set — keeping the file already there");
} else {
  console.warn("google-client: GOOGLE_CLIENT_ID not set and no file — this build will have no Google client (see .env.example)");
}
