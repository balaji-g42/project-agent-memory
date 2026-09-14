---
description: Halt the current task and sync new decisions, progress, patterns and context changes to project-agent-memory.
---

Halt the current task and sync memory for this project.

1. Review this session for anything not yet written down:
   - decisions made and why
   - work completed or blocked, with commit ids and push status
   - rules future code must follow
   - what the current focus and next steps now are
2. Write each via the project-agent-memory tools:
   - decisions and progress -> memory_create (memory_type "decisionLog" / "progress")
   - a rule future code must follow -> memory_create (memory_type "systemPatterns", SYMPTOM -> CAUSE -> FIX)
   - focus/next steps changed -> memory_context with active_context
   - project shape/constraints changed -> memory_context with product_context
3. Skip anything already recorded. Do not duplicate between entries.
4. Confirm in one line what you wrote, then resume the previous task.

If $ARGUMENTS is given, restrict the sync to that topic.
