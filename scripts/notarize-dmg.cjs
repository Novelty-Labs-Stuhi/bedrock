// electron-builder afterAllArtifactBuild hook: electron-builder notarizes and staples
// the .app, then wraps it in a .dmg that is itself left unsigned — so Gatekeeper rejects
// the container users actually download ("no usable signature"). Sign, notarize and
// staple the dmg too. Credentials come from .env via the package:mac script.
const { execFileSync } = require("node:child_process");

const IDENTITY = "Developer ID Application: Parasition AB (4Q45TL2D7B)";

module.exports = async ({ artifactPaths }) => {
  const dmgs = artifactPaths.filter((p) => p.endsWith(".dmg"));
  if (dmgs.length === 0) return [];

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    throw new Error("dmg notarization needs APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID — see .env.example");
  }

  for (const dmg of dmgs) {
    execFileSync("codesign", ["--force", "--sign", IDENTITY, "--timestamp", dmg], { stdio: "inherit" });
    execFileSync("xcrun", ["notarytool", "submit", dmg,
      "--apple-id", APPLE_ID, "--password", APPLE_APP_SPECIFIC_PASSWORD,
      "--team-id", APPLE_TEAM_ID, "--wait"], { stdio: "inherit" });
    execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit" });
  }
  return [];
};
