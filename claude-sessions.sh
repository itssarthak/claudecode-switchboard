#!/bin/sh
# State of all Claude Code sessions: ~/.claude/sessions/<pid>.json is the live registry.
# A session is alive if its pid is; dead pids = stale files.
for f in "$HOME"/.claude/sessions/*.json; do
  pid=$(basename "$f" .json)
  kill -0 "$pid" 2>/dev/null && alive=live || alive=stale
  jq -r --arg a "$alive" '[$a,(.status//"?"),(.pid|tostring),.name,.cwd,(.sessionId)]|@tsv' "$f"
done | sort | column -t -s "$(printf '\t')"
