---
name: switchboard
description: Use when the user asks to open the switchboard dashboard, see every running Claude Code session, check plan usage or weekly token budget, or review their Claude Code usage patterns. Starts a local dashboard on http://localhost:7823 showing status, token burn and messages for every session on this Mac.
allowed-tools: Bash
---

# switchboard

A local dashboard for every Claude Code session running on this Mac. macOS + Node 18+.

`$1` selects what to do. Default (no argument) is `open`.

## open

Start the server if it isn't already up, then open the page.

1. Already running? `curl -sf -m 2 http://localhost:7823/api > /dev/null && echo up`
   - If `up`, skip to step 3. Nothing else to do — one server serves every session.
2. Start it detached, and read back the URL it printed (the port walks upward if 7823 is taken):
   ```
   nohup node "${CLAUDE_PLUGIN_ROOT}/claude-sessions.js" > /tmp/switchboard.log 2>&1 &
   sleep 3; cat /tmp/switchboard.log
   ```
   If the log shows an error instead of a URL, show it to the user and stop — do not retry.
3. `open <url>` and tell the user the URL in one line.

Do not run the server in the foreground and do not poll it. It is a long-lived process the
user leaves running; it is not something to wait on.

## report

`node "${CLAUDE_PLUGIN_ROOT}/claude-sessions.js" --report`

Prints the derived weekly budget — what 100% is in tokens, what is left, the run rate, and
whether it runs dry before the reset. Show the output as-is; it is already formatted.

**Read the caveat out of the README before interpreting it**: this is raw token volume, and
cache reads dominate it. It is a consistent yardstick week over week, not a number Anthropic
would recognise. Don't present it as an official figure.

## patterns

`node "${CLAUDE_PLUGIN_ROOT}/claude-sessions.js" --patterns [days]`

Prompts by hour and weekday, most-used tools, models, effort, prompt lengths, interrupts and
concurrent sessions. `[days]` defaults to 7. No prompt text is stored or shown.

## Notes

- **The dashboard shows the text of prompts.** It binds to loopback only. If the user asks to
  expose it on the network, tell them what that publishes (prompts, working directories,
  session names, unauthenticated) before doing it.
- Plan-usage bars read the OAuth token from the login Keychain, so macOS prompts on first run.
  Denying it is fine — everything else still works.
- State lives in `~/.switchboard/`. Deleting it loses day-by-day history, nothing else.
