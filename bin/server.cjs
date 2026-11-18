#!/usr/bin/env node
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { publishedVersion: version } = require(path.join(__dirname, "..", "package.json"));

const marker = path.join(process.env.CLAUDE_PLUGIN_DATA || os.homedir(), ".pam-npm-version");
let seen = "";
try { seen = fs.readFileSync(marker, "utf8").trim(); } catch {}
if (seen !== version) {
  spawnSync("npm", ["cache", "clean", "--force"], {
    cwd: os.homedir(),
    stdio: "ignore",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  try { fs.writeFileSync(marker, version); } catch {}
}

const child = spawn("npx", ["-y", `project-agent-memory@${version}`], {
  cwd: os.homedir(),
  stdio: "inherit",
  shell: process.platform === "win32",
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(`Could not start project-agent-memory@${version}: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
