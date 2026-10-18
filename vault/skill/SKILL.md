---
name: vault-memory
description: Read and write the on-disk Obsidian memory vault that replaces the memory MCP on this machine. Use when the user asks to remember something, recall a past decision, log progress, record a pattern, run a memory sync, or when starting work on a project and past context is needed.
---

# Vault memory

Long-term memory on this machine is a plain-Markdown Obsidian vault. There is no memory MCP
server — the `pam` memory tools do not exist here. Use Read, Write, Edit, Glob and Grep.

Vault root: the path the SessionStart hook reports. It resolves `VAULT_PATH` (env, then
`~/mcp/project-agent-memory/config.json`), then legacy `$CLAUDE_VAULT`, then `~/.claude/vault`.
Project folder: `<vault>/projects/<project_name>/`.

`project_name` comes from the workspace root metadata file — `pyproject.toml` `[project].name`,
`setup.py` `name=`, `package.json` `name`, `pubspec.yaml` `name` — else the folder name. It is
case-sensitive. Ask before using a name not derived from the working directory.

## Notes and what belongs in each

| Note | Holds | Write mode |
|---|---|---|
| `Product Context.md` | What the project is, stack, constraints not derivable from code | Rare edits |
| `Active Context.md` | Current focus, next steps | Overwrite freely |
| `System Patterns.md` | Rules future code must follow | Append one line |
| `Decision Log.md` | A choice plus its rationale | Prepend dated section |
| `Progress.md` | Completed/blocked work with commit ids | Prepend dated section |
| `Custom Data/<slug>.md` | Verbatim documents | One file each |

## Reading

The SessionStart hook already injected `Active Context.md` and `System Patterns.md` — do not
re-read them at the start of a session.

Before acting on a bug, flake, timeout or an unfamiliar module, search first:

```
Grep(pattern="<the symptom in the user's own words>", path="<vault>/projects/<project>")
```

Search the symptom, not a tidy summary. `Glob("<vault>/projects/*/System Patterns.md")` when a
rule might have been learned on another project.

## Writing

Append or prepend. Never reflow or rewrite an existing entry; only fix one proven wrong.

Progress entry — five lines maximum:

```markdown
## 2026-09-09 - Fix briefing webhook fallback

- `746bb45` on `dev-balaji` — pushed
- Scope: `lib/app/data/network/network_module.dart`
- Fixes: v2 webhook 502 left the briefing silent
- Verified: second cold launch on device, briefing spoke
- Open: retry budget still hardcoded #progress [[System Patterns]]
```

Pattern entry — one line, so a search on the symptom matches:

```markdown
- Briefing silent after webhook 502 -> fallback path never invoked on non-timeout errors -> catch DioException by type, not by timeout #pattern
```

Decision entry:

```markdown
## 2026-09-09 - Kitten TTS for the briefing, OS voices for settings

- Chose: two engines rather than one
- Why: sherpa_onnx gives consistent voice offline; OS voices needed for the picker UI
- Rejected: flutter_tts only — voice differs per device #decision [[Product Context]]
```

## Format rules

- YAML frontmatter on every note: `project`, `type`, `tags: [claude-memory]`.
- Dated `## YYYY-MM-DD - <title>` headings, newest first.
- `[[Wikilinks]]` between notes; a link to a note that does not exist yet is fine.
- Inline tags `#decision` `#progress` `#pattern` `#bug`.
- Bullets, one idea per line. No prose paragraphs, no code dumps.
- Absolute dates only.

## Memory sync

On "Sync Memory" / "Memory Sync": halt, review the session for new decisions, progress, patterns
and context changes, write them into the notes, confirm in one line, resume.

## Vault git sync

If the vault is a git repo, `vault-sync.ps1` / `vault-sync.sh` next to this SKILL.md commits and
pushes it. Pass the vault root as the first argument; without it the script falls back to
`$CLAUDE_VAULT`, then `~/.claude/vault`. Run it when the user asks to sync, or at the end of a
long session.
