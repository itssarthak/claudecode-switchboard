# switchboard

A local dashboard for every Claude Code session running on your Mac — what each one is
working on, how many tokens it has burned, how much of your plan is left, and which
sessions are messaging each other.

Not affiliated with Anthropic.

No dependencies, no build step, no telemetry. Two files and Node's stdlib.

```
node claude-sessions.js
# http://localhost:7823
```

## What it shows

Sessions are read from `~/.claude/sessions/*.json` and grouped by working directory,
sorted by tokens burned.

**Per tile**
- Status — `busy` / `idle` / `unknown` / `stale`, colour-coded, with the legend up top.
  Liveness is a real `kill(pid, 0)` check, not the `status` field, which is only written
  on busy↔idle transitions and never at all by SDK sessions.
- What it's doing — the last real user prompt, the last assistant reply, and for busy
  sessions the tool call in flight (`⚙ Bash · 2s ago`).
- Context in play, as a bar against the 200k or 1M window.
- Tokens: 5-minute burn rate and lifetime total, with output / input / cache read /
  cache write / thinking, turn counts and top tools behind a `▸ breakdown` toggle.
- Model, reasoning effort, and git branch.

**Up top**
- Account-wide totals for today, rolled up from every transcript touched in the last
  `DAYS` days (default 7).
- **Live plan usage** — your actual 5-hour and weekly limits as percentages, with reset
  times. See [Plan usage](#plan-usage) for how this works.

**Interactions**
- Click a tile to focus that session's terminal tab.
- Hover a tile for a `compact` button — click once to arm, again to send `/compact`.
- Hover for a `kill` button — sends SIGTERM after a confirmation prompt.
- When one session messages another, an envelope flies between the two tiles.

## Requirements

- **macOS.** Terminal focus and `/compact` use AppleScript, plan usage reads the
  Keychain, and the process walk uses BSD `ps` flags. The tiles, token accounting and
  message animation would port to Linux; those three features would not.
- **Node 18+** (for built-in `fetch`).
- Claude Code, obviously. Nothing needs to be configured in it.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `7823` | Walks upward if taken. |
| `HOST` | `127.0.0.1` | See [Security](#security) before changing this. |
| `DAYS` | `7` | How far back the account-wide rollup reads transcripts. |

## How the data refreshes

- The page polls `/api` every **2 seconds**. Everything on a tile is at most that stale.
- Transcripts are parsed **incrementally** — each poll reads only the bytes the file grew
  by, keeping a byte offset, a trailing partial-line buffer, and a set of seen message
  ids. A file that shrinks is re-read from scratch.
- The account-wide rollup runs in the **background** every 60s, 3 files per tick via
  `setImmediate`, so a multi-gigabyte transcript corpus never blocks the event loop.
- Plan usage is fetched at most **once a minute**, in the background. `/api` serves the
  last known value and never blocks on the network.

**Streaming writes each assistant message to the transcript more than once**, so every
usage record is deduplicated on `message.id`. Summing naively roughly doubles every
number. This is the one piece of logic with a test:

```
node claude-sessions.js --selftest ~/.claude/projects/<slug>/<session>.jsonl
```

It asserts that incremental parsing matches a one-shot parse and that polling the same
file twice doesn't double-count.

## Plan usage

The percentages `/usage` shows are **not stored anywhere on disk** — not in
`~/.claude.json`, and `~/.claude/stats-cache.json` is transcript-derived and goes stale.
There is no `claude usage` subcommand.

They come from `GET https://api.anthropic.com/api/oauth/usage`, authenticated with the
OAuth token Claude Code keeps in your login Keychain. So this tool runs:

```
security find-generic-password -s "Claude Code-credentials" -w
```

**macOS will prompt you the first time.** The token is used for that one request and
nothing else: it is never logged, never written to disk, and never included in `/api`
output. If it has expired you'll see "token expired" on the bar — run any `claude`
command to refresh it. This tool does not attempt to refresh tokens itself.

If you'd rather not grant Keychain access, deny it. Everything except the plan-usage bars
works without it.

## Security

**This dashboard exposes the text of your prompts.** Tiles show the last user message and
last assistant reply for every session. Treat the port like your terminal.

- It binds to **loopback only**. Setting `HOST=0.0.0.0` publishes your prompts, working
  directories and session names to everyone on your network, with no authentication of
  any kind. Don't.
- `/focus`, `/send` and `/kill` are **POST-only and reject cross-origin requests**, because
  any web page you visit can issue requests to a localhost port. Without this, an `<img>`
  tag on any site could trigger `/compact` — or `/kill` — on your sessions.
- `/kill` sends **SIGTERM, never SIGKILL**, and only to a pid that is currently live *and*
  present in the session registry. It cannot signal arbitrary processes: `pid 1` and
  anything else Claude Code doesn't own is refused. The UI asks for confirmation first.
- `/send` accepts an **allowlist** — `compact`, `context`, `cost`, `status` — and nothing
  else. It is not a general "type into my terminal" endpoint. The target pid must be live
  and present in the session registry, and its tty must match `^ttys?\d+$`.
- Every subprocess call uses `execFileSync` with an argument array. No shell.

There is no authentication. The security model is entirely "loopback, and same-origin for
anything that acts".

## Limitations

- **Built on undocumented internals** — the `~/.claude` layout, the transcript record
  shapes, the `uds:/tmp/cc-socks/<pid>.sock` sender string, the usage endpoint. None of
  this is public API and a Claude Code update may break it. Parsers skip records they
  don't understand, so the failure mode is missing data rather than a crash.
- **Cursor and VS Code integrated terminals can only be raised, not focused or typed
  into** — they aren't AppleScript-addressable. Clicking such a tile activates the app and
  tells you which tty to look for; the compact button returns a clear error rather than
  half-working. Terminal.app and iTerm2 support both. Ghostty, WezTerm, Alacritty and
  kitty fall back to activate-only and are untested.
- **Memory grows.** The parser keeps every message id it has seen, per file, for the life
  of the process — about 70 MB after a full pass over ~300 transcripts, and unbounded over
  weeks. Restart it occasionally.
- **Cross-session envelopes lag by up to ~2s** and only appear once the message lands in
  the receiving session's transcript. It's a view, not a wire tap.
- **No cost estimates.** Token counts are volume, not dollars; prices aren't on disk and
  guessing them would be worse than omitting them.
- AppleScript blocks the event loop for up to 5s on a focus or send.
- `--selftest` covers token accounting only. The AppleScript and quota paths are verified
  by hand.

## Files

| File | |
|---|---|
| `claude-sessions.js` | Server: registry scan, transcript parser, rollup, focus/send, quota. |
| `claude-sessions.html` | The whole UI. Vanilla JS, no build. |
| `claude-sessions.sh` | A `jq` one-liner that dumps the same session table to a terminal. |

## License

MIT — see [LICENSE](LICENSE).
