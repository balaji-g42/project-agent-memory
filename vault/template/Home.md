---
tags: [claude-memory]
---

# Claude memory vault

Long-term memory for Claude Code on this machine. Written by Claude with plain file tools, read by
you in Obsidian. Open this folder as an Obsidian vault.

## Layout

- `projects/<project_name>/` — one folder per project, created automatically on session start
  - `Product Context.md` — what the project is, stack, constraints
  - `Active Context.md` — current focus and next steps
  - `System Patterns.md` — rules future code must follow, `SYMPTOM -> CAUSE -> FIX`
  - `Decision Log.md` — choices and their rationale, newest on top
  - `Progress.md` — completed and blocked work with commit ids, newest on top
  - `Custom Data/` — verbatim documents

- `templates/` — Obsidian Templates plugin, one per memory type:
  `Product Context`, `Active Context`, `Pattern Entry`, `Decision Entry`, `Progress Entry`,
  `Custom Data Note`

## Conventions

Frontmatter on every note (`project`, `type`, `tags`), dated `## YYYY-MM-DD - <title>` sections
newest first, `[[Wikilinks]]` between notes, inline `#decision` `#progress` `#pattern` `#bug` tags.

## Useful Obsidian queries

Everything still open, across projects:

````
```query
tag:#progress "Open:"
```
````

All patterns learned:

````
```query
path:"projects" file:"System Patterns"
```
````
