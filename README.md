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

Or install it as a Claude Code plugin and run `/switchboard` from inside any session:

```
/plugin marketplace add itssarthak/claudecode-switchboard
/plugin install switchboard
```

`/switchboard` starts the server and opens the page, `/switchboard report` prints the weekly
budget, `/switchboard patterns` prints your usage patterns. One server serves every session —
running the command again in a second session just reopens the same page.

## What it shows

Sessions are read from `~/.claude/sessions/*.json` and grouped by working directory,
sorted by tokens burned.

**Per tile**
- Status — `busy` / `idle` / `unknown` / `stale`, colour-coded, with the legend up top,
  followed by the session **kind** — `interactive` for a terminal tab, `bg` for one started
  with `claude --bg`.
  Liveness is a real `kill(pid, 0)` check, not the `status` field, which is only written
  on busy↔idle transitions and never at all by SDK sessions.
- What it's doing — the last real user prompt, the last assistant reply, and for busy
  sessions the tool call in flight (`⚙ Bash · 2s ago`).
- Context in play, as a bar against the 200k or 1M window. A trailing `?` means the
  window is assumed rather than known — see [Which window](#which-window).
- Tokens: 5-minute burn rate and lifetime total, with output / input / cache read /
  cache write / thinking, turn counts and top tools behind a `▸ breakdown` toggle.
- Model, reasoning effort, and git branch. Those first two come from the last assistant
  reply, so a session that has newer input but has not replied yet is tagged `as of 3h ago`
  — a `/model` change you just made will not show until it next replies.
- A **`waiting 5m`** bubble once a session has been quiet long enough that Claude Code has
  notified you, or a red **`stalled 5m`** when it is busy while writing nothing and burning
  nothing. See [Waiting vs stalled](#waiting-vs-stalled).

**Up top**
- Account-wide totals for today, rolled up from every transcript touched in the last
  `DAYS` days (default 7).
- **Live plan usage** — your actual 5-hour and weekly limits as percentages, with reset
  times. See [Plan usage](#plan-usage) for how this works.
- **Derived weekly budget** — what 100% is *in tokens*, how much is left, your run rate per
  day, and whether you'll run dry before the reset. See [Weekly budget](#weekly-budget).

**Two sections below the tiles**
- **Tokens spent** — per day for the last 30, and per quota week, from the persistent ledger.
- **How you use Claude Code** — prompts by local hour and weekday, the tools you reach for
  most, models and reasoning effort, average prompt length, how often you interrupt a turn,
  and how many sessions you typically run at once. `node claude-sessions.js --patterns`
  prints the same thing, `--patterns 30` windows it, and `/patterns` returns JSON.

**Interactions**
- Click a tile to focus that session's terminal tab.
- Hover a tile for a **`talk`** button, bottom-right, to chat with that session — the composer shows the last
  24 turns and stays open after you send, so the reply lands in front of you. Enter sends, Esc
  closes, shift+Enter is a newline. See [Messaging a session](#messaging-a-session).
- Hover a tile for a `compact` button — click once to arm, again within 6s to send `/compact`.
- Hover for a `kill` button — sends SIGTERM after a confirmation prompt.
- When one session messages another, an envelope flies between the two tiles and opens into
  the message summary — the one the sending agent wrote in its own `SendMessage` call, not a
  generated one. It stays up for a computed reading time, pauses while you hover, and has a
  close button.

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

## Files it writes

Everything lands in `~/.switchboard/` — nothing is written near the repo.

| File | |
|---|---|
| `ledger.json` | Cumulative tokens per local calendar day. Values only ratchet up. |
| `samples.jsonl` | A row every 5 minutes pairing token totals with your plan percentage. ~26 KB/day, trimmed to 120 days. |
| `quota-cache.json` | The last plan-usage response, so restarts don't re-hit the API. **Contains no credentials** — just the usage payload. |
| `patterns.json` | Per-day prompt counts by hour and weekday, tool/model/effort tallies, prompt lengths, interruption counts. No prompt text is stored. |

Delete the directory at any time; it rebuilds. You lose the day-by-day history, which cannot
be reconstructed once transcripts age past the rollup window.

## Weekly budget

Anthropic reports a percentage, never a token count. Pairing the reported percentage with
measured tokens gives you the missing number:

```
node claude-sessions.js --report
```

```
quota week  21 Aug 1:30pm  ->  28 Aug 1:30pm   (Asia/Calcutta)
  reported   71% used
  measured   3270.9M tokens burned
  => 100% is 4606.9M tokens
  remaining  1336.0M
  run rate   731.5M/day  ->  5120.8M by reset (111% of implied)
  hits 100%  27 Aug, 8:38 pm
```

The same numbers appear live on the dashboard, and `/log` returns the whole thing as JSON
including the per-day and per-week tables.

**This is a yardstick, not a budget Anthropic would recognise.** It's raw token volume, and
cache reads are the overwhelming majority of that — the real limit is near-certainly weighted
by model and token type. It's useful because it's *consistent*: the same measurement week over
week tells you whether you're trending over. It is not a number to quote at anyone.

Two things degrade it: days recorded before you first ran the tool are only as complete as the
7-day rollup could still see (marked `partial`), and a week with no sample from its start is
summed from whole calendar days rather than measured precisely (`exact: false`). Both correct
themselves once it has been running a full week.

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

## Which window

Nothing on disk records a session's context window. Transcripts log the resolved model name
with the `[1m]` suffix stripped — `claude-opus-5` whether it is the 200k or the 1M variant —
and `~/.claude/sessions/*.json` carries no model at all. Two things are knowable:

- more than 200k of context in play **can only be** a 1M window, so that case is shown plainly;
- otherwise the `model` in your settings says what sessions start as, and that is shown with a
  `?`. A `/model` switch made inside a running session is invisible.

## Messaging a session

`talk` types your text into that session's prompt and presses Enter, over the same AppleScript
path as `/compact`. It is the real prompt, so the session answers exactly as if you had typed
it in the terminal — and it queues if the session is mid-turn.

The composer shows the **last 24 turns**, refreshed every 2s, and stays open after you send so
you can watch the reply arrive. It follows the bottom only if you are already there, so
scrolling back to read doesn't yank you forward. The tail comes from `/thread?pid=` rather than
riding the 2s poll — 24 turns × 1500 chars across every session would be megabytes a minute.
Streaming rewrites the same assistant message repeatedly, so entries are matched on message id
and replaced rather than appended.

It is the transcript, not a separate log: messages you send in the terminal show up here too.
Tool calls are not shown, only prose.

This is genuinely "type into my terminal over HTTP", which is why it is a separate endpoint
from `/send` and why the server binds to loopback only. What guards it:

- POST and same-origin only, like every other acting endpoint.
- The pid must be live and in the session registry, so a dead tab sitting at a shell prompt
  can't be typed into.
- Control characters are stripped, not escaped — a newline would submit early and type the
  rest as a second prompt, and ESC sequences would drive the TUI. 2000 character cap.
- The text reaches the AppleScript literal with `\` and `"` escaped, the only two ways out of
  it. `--selftest` asserts this, including an attempted `"; do shell script "…` break-out.
- The prompt rides in the request body, never the query string, so it stays out of any log.

Cursor and VS Code sessions can't be messaged, for the same reason they can't be focused.

**Background sessions can't be messaged either.** A session started with `claude --bg` runs
under a pty-host with no terminal tab — `ps` reports its tty as `??`, so there is nothing to
type into. Its `talk` button is disabled and says so; reach it with `claude attach <id>`, or
`claude agents --json` to list them (the rows carrying an `id` are the background ones).

## Waiting vs stalled

Claude Code fires *"Claude is waiting for your input"* not when a session goes idle, but once
it has been quiet for `messageIdleNotifThresholdMs` — default **60 seconds**, and read from
your `~/.claude/settings.json` if you have set it. The `waiting` bubble uses the same
threshold, so it appears exactly when the notification does. Under an hour it pulses gently,
to separate the session that just pinged you from the eleven idle since last night.

`stalled` is a heuristic, not a reported state. A permission prompt happens **mid-turn**, so
a blocked session still reports `busy`, and Claude Code writes no blocked state anywhere on
disk — a pending `tool_use` is not flushed to the transcript until it resolves. What is
observable is a session that is busy while writing nothing and burning no tokens. That is
almost always a permission prompt, but it cannot be distinguished from a hang or a genuinely
slow tool, so the badge says `stalled` rather than claiming to know which.

## Security

**This dashboard exposes the text of your prompts.** Tiles show the last user message and
last assistant reply for every session, `/thread` serves the last 24 turns of any session in
full, and `/api` additionally carries the summaries and first ~700 characters of messages
sessions send each other. That is real conversation content,
not just counters. Treat the port like your terminal.

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
  else. The target pid must be live and present in the session registry, and its tty must
  match `^ttys?\d+$`.
- `/talk` **is** the general "type into my terminal" endpoint, deliberately kept separate so
  the two can be reasoned about apart. Same pid and tty checks, plus control-character
  stripping, a length cap, and AppleScript literal escaping. See
  [Messaging a session](#messaging-a-session).
- `/api` and `/log` are read-only and send no `Access-Control-Allow-Origin`, so a foreign page
  can issue the request but cannot read the response.
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
- `--selftest` covers token accounting and the `/talk` sanitiser. The AppleScript and quota
  paths are verified by hand.

## Files

| File | |
|---|---|
| `claude-sessions.js` | Server: registry scan, transcript parser, rollup, focus/send, quota. |
| `claude-sessions.html` | The whole UI. Vanilla JS, no build. |
| `claude-sessions.sh` | A `jq` one-liner that dumps the same session table to a terminal. |

## Endpoints

| | |
|---|---|
| `GET /` | The dashboard. |
| `GET /api` | Everything the page polls, every 2s. |
| `GET /log` | Daily and weekly usage tables plus the derived budget. |
| `GET /patterns` | How you use Claude Code — hours, weekdays, tools, models, prompt stats. |
| `POST /focus?pid=` | Raise that session's terminal tab. |
| `POST /send?pid=&cmd=` | Run an allowlisted slash command. |
| `POST /talk?pid=` | Type the request body into that session's prompt. |
| `GET /thread?pid=` | The last 24 turns of that session, for the composer. |
| `POST /kill?pid=` | SIGTERM that session. |

## License

MIT — see [LICENSE](LICENSE).
