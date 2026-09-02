# switchboard

A local dashboard for every Claude Code session on this Mac. Two files, Node stdlib, no build.

## Log your work

**After any meaningful change, append an entry to [WORKLOG.md](WORKLOG.md).** This applies to
agents and humans alike, and it is not optional — it is the first thing to read here and the last
thing to write.

`git log` already records *what* changed. WORKLOG.md records **why**, how you verified it, and
what you tried that didn't work. Most of the wrong turns in this repo were repeats of something
already ruled out, so the "Rejected" line matters as much as the rest.

Write an entry when you fixed something non-obvious, made a call that could reasonably have gone
the other way, or learned something about Claude Code's internals. Skip it for typos.

## House rules

- **Zero dependencies.** Two files and Node's stdlib. Don't add a package for what thirty lines
  can do, and don't add a build step.
- **Nothing in a scrolling flex column may shrink.** Children default to `flex-shrink: 1`, which
  squashes the shortest items when the column overflows — a 27px line rendered at 11px and looked
  like a blank strip. Set `flex: none`, and check `scrollHeight > offsetHeight`, not just that an
  element "is visible".
- **Never let a selector reach into message content.** `#talklog .m i`, `.q`, `.what .q` — three
  separate bugs where a broad descendant selector styled text a user or agent wrote. Scope rules
  for chrome to a class the chrome owns (`i.hd`), never to a bare tag inside a content block.
- **Nothing here is public API.** The `~/.claude` layout, transcript record shapes, the peer
  socket path, the usage endpoint — all internal and liable to change. Parse defensively: skip
  records you don't understand so the failure mode is missing data, never a crash.
- **Verify by running it.** Reasoning about the code is how most of the mistakes in WORKLOG.md
  happened. Start the server, open the page, look at it — in dark mode too.
- **`tick()` rebuilds every tile every 2 seconds.** Anything the user is mid-interaction with
  must live outside `#groups`, or its state must live outside the DOM. This has bitten twice.
- **Bump `version` in both `.claude-plugin/plugin.json` and `package.json`** for anything worth
  shipping. `claude plugin update` compares versions, not commits, so without a bump installed
  copies keep serving old code.
- **A green `--selftest` does not mean the server runs.** It exits early, so it cannot catch a
  load-order or module-level error. Start the server and curl `/api` before you commit.
- **`node claude-sessions.js --selftest` must pass** before you commit. It covers token
  accounting and the `/talk` sanitiser.

## Security

This dashboard serves the text of your prompts. Treat the port like your terminal.

- Binds to **loopback only**. `HOST=0.0.0.0` publishes prompts, working directories and session
  names with no authentication.
- `/focus`, `/send`, `/talk` and `/kill` are **POST + same-origin only** — any web page you visit
  can otherwise reach a localhost port.
- `/talk` is the general "type into my terminal" endpoint. Control characters stripped, 2000 char
  cap, AppleScript literal escaped, body not query string. If you touch it, extend the
  `--selftest` assertions.
- `/kill` sends **SIGTERM, never SIGKILL**, only to a pid that is live *and* in the registry.
- Every subprocess call uses `execFileSync` with an argument array. **No shell.**
- The Keychain OAuth token is used for one request. Never log it, write it, or serve it.
