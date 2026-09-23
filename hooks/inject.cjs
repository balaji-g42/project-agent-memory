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

const MEMORY_TOOLS = new Set(["mcp__memory__memory_create", "mcp__memory__memory_update"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

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

const MEMORY_RULES = (name) =>
  `PERSISTENT MEMORY: this project's long-term memory is the project-agent-memory server, exposed ` +
  `as mcp__memory__* tools (memory_create, memory_read, memory_update, memory_delete, ` +
  `memory_context, memory_graph, memory_admin, code_graph).

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

function runCli(args, input, timeout) {
  const local = path.join(__dirname, "..", "dist", "cli.js");
  const [command, prefix, shell] = fs.existsSync(local)
    ? [process.execPath, [local], false]
    : ["npx", ["-y", "-p", "project-agent-memory@latest", "project-agent-memory-cli"], process.platform === "win32"];
  try {
    return execFileSync(command, [...prefix, ...args], {
      encoding: "utf8",
      input: input || "",
      timeout,
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
  let context = "";
  try {
    const loaded = JSON.parse(runCli(["context", name], "", CONTEXT_TIMEOUT_MS));
    writeCodeStats(name, loaded.code);
    const code = loaded.code.indexed
      ? `Code graph: ${loaded.code.nodes} nodes indexed; it re-indexes after each Edit/Write.`
      : `Code graph: not indexed. Offer to run code_graph op=index with root '${cwd}' (needs graphify: pipx install graphifyy).`;
    context = `\n\n${code}\n\nLOADED CONTEXT:\n${loaded.text}`;
  } catch {
    context = "\n\nLOADED CONTEXT: unavailable - call memory_context for this project.";
  }
  return MEMORY_RULES(name) + context;
}

function onUserPromptSubmit(payload) {
  const prompt = String(payload.prompt || "").trim();
  if (prompt.length < MIN_RECALL_PROMPT) return "";
  return runCli(["recall", projectName(payload.cwd || process.cwd())], prompt, RECALL_TIMEOUT_MS);
}

function onPreToolUse(payload) {
  const stats = readCodeStats(projectName(payload.cwd || process.cwd()));
  if (!stats || !stats.indexed) return "";
  const nudged = statePath(`nudged-${safeName(payload.session_id || "default")}`);
  if (fs.existsSync(nudged)) return "";
  try {
    fs.writeFileSync(nudged, "", "utf8");
  } catch {}
  return (
    `The code graph is indexed (${stats.nodes} nodes). For finding a symbol, its callers or ` +
    "its dependencies, code_graph op=query is cheaper than Grep/Glob. Grep is fine for literal " +
    "strings, config values and non-code files."
  );
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

  if (EDIT_TOOLS.has(tool)) {
    const cwd = payload.cwd || process.cwd();
    const name = projectName(cwd);
    const stats = readCodeStats(name);
    if (stats && stats.indexed) reindex(name, cwd);
    return "";
  }

  if (MEMORY_TOOLS.has(tool)) {
    clearSentinel(payload);
    return "";
  }

  if (tool !== "Bash" && tool !== "PowerShell") return "";

  const command = (input.command || "").toLowerCase();
  if ((!command.includes("git commit") && !command.includes("git merge")) || command.includes("--dry-run")) {
    return "";
  }

  const cwd = payload.cwd || process.cwd();
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
  writeSentinel(payload, { sha, subject, project: name, blocks: 0 });

  let context =
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

  if (blocks >= MAX_BLOCKS) {
    clearSentinel(payload);
    return {
      systemMessage:
        `Commit ${sha} was never logged to memory after ${MAX_BLOCKS} attempts. Releasing the ` +
        "turn - log it manually or check whether the memory MCP server is reachable.",
    };
  }

  pending.blocks = blocks + 1;
  writeSentinel(payload, pending);

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
