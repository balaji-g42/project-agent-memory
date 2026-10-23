const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const JSON_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);

const STATE_DIR = path.join(os.homedir(), ".claude", "state");
const STATE_PREFIX = "pam-";
const MAX_BLOCKS = 2;
const CONTEXT_TIMEOUT_MS = 20000;
const RECALL_TIMEOUT_MS = 8000;
const INDEX_TIMEOUT_MS = 600000;
const MIN_RECALL_PROMPT = 12;
const MAX_CONTEXT_CHARS = 6000;

const COMMIT_WINDOW_S = 120;

const CONFIG_FILE = path.join(os.homedir(), "mcp", "project-agent-memory", "config.json");
const MEMORY_TOOLS = /^mcp__(plugin_project-agent-memory_)?pam__memory_(create|update)$/;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CODE_GRAPH_TOOL = /^mcp__(plugin_project-agent-memory_)?pam__code_graph$/;

function readConfigFile() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function setting(file, key) {
  const fromEnv = process.env[key];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv;
  const fromFile = file[key];
  if (fromFile === undefined || fromFile === null || String(fromFile).trim() === "") return undefined;
  return String(fromFile);
}

function hostOf(url) {
  try {
    return new URL(url).host || "an unknown host";
  } catch {
    return "an unknown host";
  }
}

function memorySetup() {
  const file = readConfigFile();
  const mode = (setting(file, "MODE") || (process.env.CLAUDE_PLUGIN_ROOT ? "plugin" : "mcp")).toLowerCase();
  const prefix = mode === "plugin" ? "mcp__plugin_pam_mem__" : "mcp__mem__";
  const backend =
    (setting(file, "MEMORY_BACKEND") || "qdrant").toLowerCase() === "postgres"
      ? `pgvector via pREST at ${hostOf(setting(file, "PREST_URL"))}`
      : `Qdrant at ${hostOf(setting(file, "QDRANT_URL") || "http://localhost:6333")}`;
  return { mode, prefix, backend };
}

function isVault() {
  return (setting(readConfigFile(), "MODE") || "").toLowerCase() === "vault";
}

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function vaultRoot() {
  const configured = setting(readConfigFile(), "VAULT_PATH") || process.env.CLAUDE_VAULT;
  if (configured && configured.trim()) return path.resolve(expandHome(configured.trim()));
  return path.join(os.homedir(), ".claude", "vault");
}

function projectDir(name) {
  return path.join(vaultRoot(), "projects", name);
}

function notePath(name, filename) {
  return path.join(projectDir(name), filename);
}

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

function samePathCase(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function isVaultPath(p) {
  if (!p) return false;
  try {
    const root = samePathCase(vaultRoot());
    const abs = samePathCase(path.resolve(p));
    return abs === root || abs.startsWith(root + path.sep) || abs.startsWith(root + "/");
  } catch {
    return false;
  }
}

function matchIn(file, regex) {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    const m = text.match(regex);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function fromJsonName(root, file) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    return typeof data.name === "string" && data.name ? data.name : null;
  } catch {
    return null;
  }
}

function projectName(cwd) {
  const root = path.normalize(cwd);
  return (
    matchIn(path.join(root, "pyproject.toml"), /^\s*name\s*=\s*["']([^"']+)["']/m) ||
    matchIn(path.join(root, "setup.py"), /name\s*=\s*["']([^"']+)["']/) ||
    matchIn(path.join(root, "setup.cfg"), /^\s*name\s*=\s*(.+)$/m) ||
    fromJsonName(root, "package.json") ||
    matchIn(path.join(root, "pubspec.yaml"), /^name:\s*(\S+)/m) ||
    path.basename(root) ||
    "default"
  );
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const MEMORY_RULES = (name, { mode, prefix, backend }) =>
  `PERSISTENT MEMORY: this project's long-term memory is the project-agent-memory server ` +
  `(${backend}, ${mode} mode), exposed as ${prefix}* tools (memory_create, memory_read, ` +
  `memory_update, memory_delete, memory_context, memory_graph, memory_admin, code_graph).

project_name:  '${name}' (case-sensitive; ask before using a different one)

Valid memory_type values: productContext, activeContext, systemPatterns, decisionLog, progress,
contextHistory, customData, knowledgeLink (graph edges written by memory_graph, not created
directly).

Project context is loaded below and relevant memories are recalled into each prompt
automatically; call memory_read only when you need more than the recall shows.

RULES:
  1. As things settle, not batched at the end: memory_create the decision, progress line or
     pattern. Mistakes: a decisionLog entry now, and the rule as a systemPatterns entry.
  2. Focus changed: memory_context with active_context to patch it.
  3. Finding code: code_graph op=query (symbol, callers, callees) before Grep or Glob.
  4. If the memory tools are unavailable: say so in one line and continue without persistence.

These tools are deferred - fetch each tool's schema with ToolSearch before the first call this
session, then use the parameter names it returns. Keep writes small: one idea per entry. A
progress entry is five lines max - commit id, scope, verification, push status, what is still
open. Incident detail belongs in a systemPatterns entry, never in progress.

Today is ${today()}. Convert relative dates to absolute before writing them.`;

const VAULT_RULES = (vault, pdir, name) =>
  `PERSISTENT MEMORY: this machine's long-term memory is a plain-Markdown Obsidian vault on ` +
  `disk (project-agent-memory, vault mode). There is no memory MCP server here - the pam ` +
  `memory tools do not exist. You read and write memory with the Read, Write, Edit and Glob tools.

Vault root:    ${vault}
This project:  ${pdir}
project_name:  '${name}' (case-sensitive; ask before using a different one)

Notes in the project folder, each one a memory_type:
  Product Context.md  - what this project is, stack, constraints. Rarely changes.
  Active Context.md   - current focus and next steps. Overwrite freely.
  System Patterns.md  - rules future code must follow, one line each,
                        SYMPTOM -> CAUSE -> FIX so a search on the symptom matches.
  Decision Log.md     - a choice plus its rationale. Newest entry on top.
  Progress.md         - completed or blocked work with commit ids. Newest on top.
  Custom Data/*.md    - verbatim documents, one file each.

MEMORY-FIRST RULES - mandatory, not advisory:
  1. Active Context and System Patterns are injected below - you already have them.
     Read Product Context.md, Decision Log.md or Progress.md when the task needs them.
  2. Before any task: Grep the project folder for past decisions, progress, patterns and
     previous bugs. Search the symptom in the words the user would type, not a tidy summary.
     Do not plan from a cold start.
  3. Mistakes: append to Decision Log.md or Progress.md immediately, and promote the rule
     into System Patterns.md.
  4. Debugging: Grep the vault for a similar past issue before proposing a fix.
  5. Continuous sync: write back as things settle - do not batch it to the end.
  6. If the vault folder is missing, create it and say so in one line.

WRITE FORMAT - the vault is read in Obsidian, so keep it Obsidian-shaped:
  - Append new entries under a '## YYYY-MM-DD - <short title>' heading, newest first.
  - Link related notes with [[Wikilinks]]; a link to a note that does not exist yet is fine.
  - Tag entries inline with #decision #progress #pattern #bug as appropriate.
  - Bullets, one idea per line. No prose paragraphs, no code dumps.
  - Progress entries are five lines max: commit id, scope, verification, push status,
    what is still open. Incident detail belongs in System Patterns.md, never in Progress.
  - Never rewrite or reflow existing entries; only append, or fix an entry proven wrong.

Today is ${today()}. Convert relative dates to absolute before writing them.`;

const SEEDS = {
  "Product Context.md":
    "What this project is, its stack, and the constraints that are not obvious from the code.\n",
  "Active Context.md":
    "Current focus and next steps. Overwrite this note freely - it is a snapshot, not a log.\n",
  "System Patterns.md": "Rules future code must follow. One line each, `SYMPTOM -> CAUSE -> FIX`.\n",
  "Decision Log.md": "Choices and their rationale. Newest entry on top.\n",
  "Progress.md": "Completed and blocked work, with commit ids. Newest entry on top.\n",
};

function ensureProjectNotes(name) {
  const folder = projectDir(name);
  try {
    fs.mkdirSync(path.join(folder, "Custom Data"), { recursive: true });
  } catch {
    return false;
  }
  for (const [filename, blurb] of Object.entries(SEEDS)) {
    const p = path.join(folder, filename);
    if (fs.existsSync(p)) continue;
    const title = filename.replace(/\.md$/, "");
    const body =
      `---\nproject: ${name}\ntype: ${title.toLowerCase().replace(/ /g, "-")}\n` +
      `tags: [claude-memory]\n---\n\n# ${name} - ${title}\n\n${blurb}`;
    try {
      fs.writeFileSync(p, body, "utf8");
    } catch {}
  }
  return true;
}

function stripFrontmatter(text) {
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end !== -1) return text.slice(end + 4).trim();
  }
  return text;
}

function loadVaultContext(name) {
  const parts = [];
  for (const filename of ["Active Context.md", "System Patterns.md"]) {
    const body = stripFrontmatter(readFileSafe(notePath(name, filename)));
    if (body) parts.push(`--- ${filename} ---\n${body}`);
  }
  let text = parts.join("\n\n");
  if (text.length > MAX_CONTEXT_CHARS) {
    text = text.slice(0, MAX_CONTEXT_CHARS) + "\n[truncated - read the note directly for the rest]";
  }
  return text;
}

function sentinelPath(payload) {
  const session = payload.session_id || "default";
  const safe = session.replace(/[^A-Za-z0-9_-]/g, "");
  return path.join(STATE_DIR, `${STATE_PREFIX}pending-commit-${safe}.json`);
}

function loggedPath(payload) {
  return sentinelPath(payload).replace("pending-commit-", "logged-commit-");
}

function readSentinel(payload) {
  try {
    return JSON.parse(fs.readFileSync(sentinelPath(payload), "utf8"));
  } catch {
    return null;
  }
}

function writeSentinel(payload, data) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(sentinelPath(payload), JSON.stringify(data), "utf8");
  } catch {}
}

function readLoggedSha(payload) {
  try {
    return fs.readFileSync(loggedPath(payload), "utf8").trim();
  } catch {
    return "";
  }
}

function clearSentinel(payload) {
  const pending = readSentinel(payload);
  if (pending) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(loggedPath(payload), pending.sha || "", "utf8");
    } catch {}
  }
  try {
    fs.unlinkSync(sentinelPath(payload));
  } catch {}
}

function emit(event, value) {
  if (!value) return;
  if (typeof value === "object") {
    process.stdout.write(JSON.stringify(value));
    return;
  }
  if (JSON_EVENTS.has(event)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: value },
      })
    );
  } else {
    process.stdout.write(value);
  }
}

function git(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function safeName(name) {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function statePath(file) {
  return path.join(STATE_DIR, `${STATE_PREFIX}${file}`);
}

function pamVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    if (pkg.name === "project-agent-memory" && pkg.publishedVersion) return pkg.publishedVersion;
  } catch {}
  return setting(readConfigFile(), "PAM_VERSION");
}

function runCli(args, input, timeout) {
  const local = path.join(__dirname, "..", "dist", "cli.js");
  const hasLocal = fs.existsSync(local);
  const version = hasLocal ? null : pamVersion();
  if (!hasLocal && !version) return "";
  const [command, prefix, shell] = hasLocal
    ? [process.execPath, [local], false]
    : ["npx", ["-y", "-p", `project-agent-memory@${version}`, "project-agent-memory-cli"], process.platform === "win32"];
  try {
    return execFileSync(command, [...prefix, ...args], {
      encoding: "utf8",
      input: input || "",
      timeout,
      cwd: hasLocal ? undefined : os.homedir(),
      shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function writeCodeStats(name, stats) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(statePath(`codegraph-${safeName(name)}.json`), JSON.stringify(stats), "utf8");
  } catch {}
}

function readCodeStats(name) {
  try {
    return JSON.parse(fs.readFileSync(statePath(`codegraph-${safeName(name)}.json`), "utf8"));
  } catch {
    return null;
  }
}

function onSessionStart(payload) {
  const cwd = payload.cwd || process.cwd();
  const name = projectName(cwd);
  if (isVault()) {
    ensureProjectNotes(name);
    const loaded = loadVaultContext(name);
    const rules = VAULT_RULES(vaultRoot(), projectDir(name), name);
    return loaded ? `${rules}\n\nCURRENT MEMORY FOR THIS PROJECT:\n\n${loaded}` : rules;
  }
  let context = "";
  try {
    const loaded = JSON.parse(runCli(["context", name], "", CONTEXT_TIMEOUT_MS));
    writeCodeStats(name, loaded.code);
    const code = loaded.code.indexed
      ? `Code graph: ${loaded.code.nodes} nodes indexed; it re-indexes after each Edit/Write.`
      : "Code graph: not indexed.";
    context = `\n\n${code}\n\nLOADED CONTEXT:\n${loaded.text}`;
  } catch {
    context = "\n\nLOADED CONTEXT: unavailable - call memory_context for this project.";
  }
  return MEMORY_RULES(name, memorySetup()) + context;
}

function onUserPromptSubmit(payload) {
  const prompt = String(payload.prompt || "").trim();
  if (prompt.length < MIN_RECALL_PROMPT || isVault()) return "";
  return runCli(["recall", projectName(payload.cwd || process.cwd())], prompt, RECALL_TIMEOUT_MS);
}

function onPreToolUse(payload) {
  if (isVault()) return "";
  if (fs.existsSync(codeGraphUsedPath(payload))) return "";
  const name = projectName(payload.cwd || process.cwd());
  const stats = readCodeStats(name);
  if (!stats || !stats.indexed) {
    const nudged = statePath(`nudged-${safeName(payload.session_id || "default")}`);
    if (fs.existsSync(nudged)) return "";
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(nudged, "", "utf8");
    } catch {}
    return (
      `The code graph for ${name} is not indexed. Run code_graph op=index now; Grep/Glob are ` +
      "allowed until it finishes, then code_graph op=query comes first."
    );
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "Call code_graph op=query first (op=index if it reports not indexed). Grep/Glob unlock " +
        "for the rest of this session after a code_graph op=query; then use them for literal " +
        "strings, config values and non-code files.",
    },
  };
}

function codeGraphUsedPath(payload) {
  return statePath(`codegraph-used-${safeName(payload.session_id || "default")}`);
}

function reindex(name, cwd) {
  const lock = statePath(`codegraph-lock-${safeName(name)}`);
  const dirty = `${lock}.dirty`;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch {
    let fresh = false;
    try {
      fresh = Date.now() - fs.statSync(lock).mtimeMs < INDEX_TIMEOUT_MS;
    } catch {}
    if (fresh) {
      try {
        fs.writeFileSync(dirty, "", "utf8");
      } catch {}
      return;
    }
    try {
      fs.writeFileSync(lock, String(process.pid), "utf8");
    } catch {}
  }
  try {
    do {
      try {
        fs.unlinkSync(dirty);
      } catch {}
      const result = runCli(["index", name, cwd], "", INDEX_TIMEOUT_MS);
      if (result) {
        try {
          writeCodeStats(name, { indexed: true, nodes: JSON.parse(result).nodes });
        } catch {}
      }
    } while (fs.existsSync(dirty));
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {}
  }
}

function onPostToolUse(payload) {
  const tool = payload.tool_name || "";
  const input = payload.tool_input || {};
  const vault = isVault();

  if (CODE_GRAPH_TOOL.test(tool)) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (input.op === "query") fs.writeFileSync(codeGraphUsedPath(payload), "", "utf8");
    } catch {}
    if (input.op === "index" && input.project_name) writeCodeStats(input.project_name, { indexed: true });
    return "";
  }

  if (EDIT_TOOLS.has(tool) && vault) {
    if (isVaultPath(input.file_path || input.notebook_path || "")) clearSentinel(payload);
    return "";
  }

  if (EDIT_TOOLS.has(tool)) {
    const cwd = payload.cwd || process.cwd();
    const name = projectName(cwd);
    const stats = readCodeStats(name);
    if (stats && stats.indexed) reindex(name, cwd);
    return "";
  }

  if (MEMORY_TOOLS.test(tool)) {
    clearSentinel(payload);
    return "";
  }

  if (tool !== "Bash" && tool !== "PowerShell") return "";

  const command = (input.command || "").toLowerCase();
  if ((!command.includes("git commit") && !command.includes("git merge")) || command.includes("--dry-run")) {
    return "";
  }

  const cwd = payload.cwd || process.cwd();
  const moved = git(cwd, ["reflog", "-1", "--date=unix", "--format=%gd"]).match(/\{(\d+)\}/);
  if (!moved || Date.now() / 1000 - Number(moved[1]) > COMMIT_WINDOW_S) return "";
  const head = git(cwd, ["log", "-1", "--format=%H%n%s"]);
  if (!head) return "";

  const lines = head.split("\n");
  const sha = lines[0].slice(0, 7);
  const subject = lines[1] || "";
  const files = git(cwd, ["show", "--stat", "--format=", "HEAD"]);
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const unpushed = branch ? git(cwd, ["log", "--oneline", "@{u}..HEAD"]) : "";
  if (sha === readLoggedSha(payload)) return "";

  const name = projectName(cwd);
  if (vault) ensureProjectNotes(name);
  writeSentinel(payload, { sha, subject, project: name, blocks: 0 });

  let context = vault
    ? `MANDATORY, NOT ADVISORY: commit ${sha} "${subject}" just landed on '${branch}' in project ` +
      `'${name}'. You may NOT end this turn until it is recorded in the memory vault. A Stop hook ` +
      `will block you if you try. Do it now, before any further tool call or reply, by editing ` +
      `the notes in ${projectDir(name)}:\n` +
      `  - Progress.md: prepend a '## ${today()} - ${subject}' section - five lines max: commit ` +
      `id, scope, verification, push status, what is still open.\n` +
      `  - Decision Log.md: only for a design choice not obvious from the diff.\n` +
      `  - System Patterns.md: only if the commit establishes a rule future code must follow, ` +
      `written as SYMPTOM -> CAUSE -> FIX.\n` +
      `  - Active Context.md: drop what is now committed and refresh the next steps.\n` +
      `A single Progress.md entry is the normal case.\n\nCommit stat:\n${files}\n`
    :
    `MANDATORY, NOT ADVISORY: commit ${sha} "${subject}" just landed on '${branch}' in project ` +
    `'${name}'. You may NOT end this turn until it is recorded in memory. A Stop hook will block ` +
    `you if you try. Do it now, before any further tool call or reply, by calling memory_create ` +
    `for project_name '${name}':\n` +
    `  - memory_type "progress": five lines max - commit id, scope, verification, push status, ` +
    `what is still open.\n` +
    `  - memory_type "decisionLog": only for a design choice not obvious from the diff.\n` +
    `  - memory_type "systemPatterns": only if the commit establishes a rule future code must ` +
    `follow, written as SYMPTOM -> CAUSE -> FIX.\n` +
    `  - memory_context with active_context: drop what is now committed and refresh next steps.\n` +
    `A single progress entry is the normal case.\n\nCommit stat:\n${files}\n`;

  if (unpushed) context += `\nUnpushed commits on this branch:\n${unpushed}\n`;
  return context;
}

function onStop(payload) {
  const pending = readSentinel(payload);
  if (!pending) return "";

  const blocks = Number(pending.blocks || 0);
  const { sha = "", subject = "", project = "" } = pending;

  const vault = isVault();

  if (blocks >= MAX_BLOCKS) {
    clearSentinel(payload);
    if (vault) {
      return {
        systemMessage:
          `Commit ${sha} was never logged to the memory vault after ${MAX_BLOCKS} attempts. ` +
          "Releasing the turn - log it manually or check whether the vault path is writable.",
      };
    }
    return {
      systemMessage:
        `Commit ${sha} was never logged to memory after ${MAX_BLOCKS} attempts. Releasing the ` +
        "turn - log it manually or check whether the memory MCP server is reachable.",
    };
  }

  pending.blocks = blocks + 1;
  writeSentinel(payload, pending);

  if (vault) {
    return {
      decision: "block",
      reason:
        `BLOCKED: commit ${sha} "${subject}" is not recorded in the memory vault. You were told ` +
        `to log it and did not. Edit ${notePath(project, "Progress.md")} now - five lines max: ` +
        "the commit id and subject, the files it touched, what it fixes, how it was verified, " +
        "and whether it is pushed. Prepend it as a new dated section, do not rewrite existing " +
        "entries. This block clears automatically once the write succeeds. If the vault path is " +
        "not writable, say so in one line and stop again.",
    };
  }

  return {
    decision: "block",
    reason:
      `BLOCKED: commit ${sha} "${subject}" is not recorded in memory. You were told to log it ` +
      `and did not. Call memory_create now for project_name '${project}', memory_type ` +
      `"progress" - five lines max: the commit id and subject, the files it touched, what it ` +
      "fixes, how it was verified, and whether it is pushed. This block clears automatically " +
      "once the call succeeds. If the memory MCP server is unreachable, say so in one line and " +
      "stop again.",
  };
}

const HANDLERS = {
  SessionStart: onSessionStart,
  UserPromptSubmit: onUserPromptSubmit,
  PreToolUse: onPreToolUse,
  PostToolUse: onPostToolUse,
  Stop: onStop,
};

function main(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const handler = HANDLERS[payload.hook_event_name || ""];
  if (handler) emit(payload.hook_event_name, handler(payload));
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (buffer += chunk));
process.stdin.on("end", () => main(buffer));
