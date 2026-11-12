#!/bin/sh
# SessionStart hook (in ~/.claude/settings.json, added by `tiny-hq setup` with your yes): if this
# project is a room in your office, hand the session its name tag. Tags live in the office's own
# folder (~/.tiny-hq/tags/<project folder, as Claude Code names it>.md),
# never in the project: a repo could ship its own .claude/office.md and steer
# every session started in it. A session inside a
# worktree (<project>/.claude/worktrees/<name>) gets the project's tag. Prints
# nothing anywhere else.
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
case "$dir" in */.claude/worktrees/*) dir="${dir%%/.claude/worktrees/*}" ;; esac
key=$(printf '%s' "$dir" | LC_ALL=C sed 's/[^a-zA-Z0-9]/-/g')
tag="${CM_DATA_DIR:-$HOME/.tiny-hq}/tags/$key.md"
[ -f "$tag" ] || exit 0
head -c 2000 "$tag"
exit 0
