#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const file = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
const latest = execSync(`npm view ${pkg.name} version`, { cwd: os.homedir(), encoding: "utf8" }).trim();
if (!/^\d+\.\d+\.\d+/.test(latest)) throw new Error(`Unexpected npm version output: ${latest}`);

if (pkg.publishedVersion === latest) {
  console.log(`publishedVersion already ${latest}`);
} else {
  console.log(`publishedVersion ${pkg.publishedVersion} -> ${latest}`);
  pkg.publishedVersion = latest;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
}
