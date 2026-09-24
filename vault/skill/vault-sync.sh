#!/usr/bin/env bash
set -euo pipefail

vault="${1:-${CLAUDE_VAULT:-$HOME/.claude/vault}}"

if [ ! -d "$vault/.git" ]; then
    echo "Vault at $vault is not a git repo - nothing to sync." >&2
    exit 0
fi

cd "$vault"
git pull --rebase --autostash

if [ -z "$(git status --porcelain)" ]; then
    echo "Vault clean, nothing to push."
    exit 0
fi

git add -A
git commit -m "memory: sync from $(hostname) $(date +%Y-%m-%d\ %H:%M)"
git push
echo "Vault synced."
