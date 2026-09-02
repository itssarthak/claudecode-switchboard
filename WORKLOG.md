# Worklog

**If you change anything in this repo, add an entry here.** Humans and agents both. One entry
per meaningful change, newest at the bottom, in the format below. This is not a changelog of
*what* shipped — `git log` already has that. It is the record of **why**, and of what was tried
and rejected, so the next person doesn't repeat a dead end.

An entry is worth writing when you fixed something non-obvious, made a call that could
reasonably have gone the other way, or discovered something about Claude Code's internals that
isn't documented anywhere. Skip it for typos and formatting.

```
## <date> — <short title>  (`<commit>`)
**What:** one or two lines.
**Why:** the reasoning, or the bug's actual cause.
**Verified:** how you know it works. "Looks right" is not verification.
**Rejected:** the approach you didn't take, and why. Omit if there wasn't one.
```

Everything below was written by Claude (Opus 5) working with the repo owner, reconstructed
from the commit history at the point the log was introduced.

---

## 2026-08-25 — First version (`d73fb98`, `49086f3`)

**What:** Zero-dependency Node server plus a single HTML page listing every Claude Code session
on the machine, grouped by working directory and sorted by tokens burned.

**Why:** Sessions are discoverable at `~/.claude/sessions/<pid>.json`, and each one's transcript
at `~/.claude/projects/<slug>/<sessionId>.jsonl`. None of this is public API.

**Verified:** Liveness uses a real `process.kill(pid, 0)` (treating `EPERM` as alive) rather
than the registry's `status` field, which is only written on busy↔idle transitions and never at
all by SDK sessions.

**Rejected:** Summing usage records naively. Streaming writes each assistant message to the
transcript several times, so every total came out roughly doubled. Everything is deduplicated on
`message.id`; this is the one piece of logic with a test (`--selftest`).

## 2026-08-25 — Live plan usage

**What:** The real 5-hour and weekly percentages, from
`GET https://api.anthropic.com/api/oauth/usage`, with the OAuth token read from the login
Keychain.

**Why:** I had told the owner this was unobtainable. That was wrong — the endpoint turned up in
`strings` over the compiled binary. The percentages are not on disk anywhere:
`~/.claude/stats-cache.json` is transcript-derived and goes stale, and there is no
`claude usage` subcommand.

**Verified:** Rate-limited in testing, which is how the 5-minute poll interval, the cross-restart
cache in `~/.switchboard/quota-cache.json`, and the exponential backoff got written. The endpoint
is shared with Claude Code itself — poll it gently.

## 2026-08-26 — Kill button (`f686a70`)

**What:** `POST /kill?pid=`, SIGTERM only, behind a confirmation prompt.

**Why:** A `bridge-session` handoff left an old Harvey process running, showing as a duplicate
card.

**Verified:** The pid must be live *and* present in the session registry, so `pid 1` and anything
Claude Code doesn't own are refused. Never SIGKILL.

## 2026-08-26 — Weekly budget and daily ledger (`1877833`)

**What:** Pair the reported percentage with measured tokens to derive what 100% is *in tokens*,
then a per-day and per-quota-week table.

**Why:** Anthropic reports a percentage and never a count. The pairing is the only way to get a
number you can plan against.

**Verified:** Local-day bucketing had a UTC bug that filed 5.5 hours of every evening under the
wrong day at +05:30. Fixed by offsetting before slicing the ISO string.

**Rejected:** Presenting this as authoritative. It is raw token volume, dominated by cache reads,
and the real limit is near-certainly weighted by model and token type. It is a consistent
yardstick week over week, not a number to quote at anyone — the README says so and so does the
skill.

## 2026-08-26 — Waiting and stalled badges, usage patterns (`60b1f0d`)

**What:** A `waiting` bubble matching Claude Code's own notification, a `stalled` badge, and a
section describing how you use Claude Code.

**Why:** The first implementation fired at the busy→idle flip, which is *not* when Claude Code
notifies you. The binary shows it fires after `messageIdleNotifThresholdMs` of quiet — default
60s, read from settings if set. The badge now uses the same threshold.

**Rejected:** Detecting permission-blocked sessions via an unresolved `tool_use` record. Verified
impossible: 0 of 250 transcripts end with one, because a pending call isn't flushed until it
resolves. `stalled` is a heuristic instead — busy, writing nothing, burning nothing — and the
badge says `stalled` rather than claiming to know why.

## 2026-08-27 — Context window and stale config (`142f847`)

**What:** Show whether a session's window is 200k or 1M, and tag model/effort as stale when
newer input exists without a reply.

**Why:** The window was inferred from context size alone, so any session carrying more than 200k
showed `/1M` even after being switched to a 200k model.

**Verified:** The `[1m]` suffix does not survive into transcripts — a session running
`claude-opus-5[1m]` logs `claude-opus-5`, and the registry carries no model at all. So the window
is genuinely unknowable per session. Two facts are usable: over 200k in play can only be 1M, and
`settings.json`'s `model` says what sessions start as. The latter is marked with a `?`.

**Note:** `model` and `effort` come off the last assistant reply, so a session with newer input
and no reply yet was showing pre-change values as current. Hence `as of 3h ago`.

## 2026-08-27 — Ship as a plugin (`80c12d6`, `0cc7062`)

**What:** `.claude-plugin/{plugin,marketplace}.json` at the repo root, so the repo is both the
marketplace and the plugin, plus a `switchboard` skill exposing `/switchboard`,
`/switchboard report`, `/switchboard patterns`.

**Why:** Distribution. Two commands instead of a clone.

**Verified:** Installed from GitHub into a throwaway `CLAUDE_CONFIG_DIR` — the path a stranger
takes — then deleted the test config. `claude plugin validate .` passes on 2.1.243 and 2.1.246
as well as current.

**Note:** `claude plugin update` compares **versions, not commits**. The installed copy keeps
serving old code until the manifest version moves. Bump `version` in *both* `.claude-plugin/
plugin.json` and `package.json` on every change worth shipping.

## 2026-08-27 — Compact button never fired (`9fbf70a`)

**What:** The two-step arm moved out of the DOM into a module-level variable.

**Why:** `tick()` rebuilds every tile every 2 seconds. The armed state lived as a class on the
button, so a tick landing between the two clicks replaced the node and wiped the arm — the second
click just re-armed, forever. It could only fire in a lucky sub-2s window.

**Verified:** Armed, waited two full ticks, confirmed `nodeWasReplaced: true` and the button still
armed, then clicked the *replaced* node and saw the POST fire.

**This trap recurs.** Anything the user is mid-interaction with must live outside `#groups` or
outside the DOM. `openTiles` exists for the same reason; the chat composer is rendered outside the
tiles for the same reason.

## 2026-08-28 — Plan usage looked washed out (`75bd64f` … `793fca6`)

**What:** Four commits. The first three were wrong.

**Why:** The actual cause was a CSS class collision I introduced in `142f847`: the window
uncertainty marker claimed a bare `.q`, which already meant "one plan-usage block" *and* "the
asked line on a card". Its `opacity: .45` therefore dimmed the entire quota section and every card
prompt, not just the `?` glyph.

**Rejected, in order, all misdiagnoses:** that the green/red status tint had changed with usage
level; that the strip needed a brighter value; that it needed a bordered panel. Each was argued
from measurements that were true but irrelevant. The owner identified the real cause.

**Lesson:** three fixes were shipped before anyone looked at a rendered screenshot in the owner's
own colour scheme. Render it and look at it before theorising.

**Now:** marker is `.guess`, card prompt is `.ask`, and every quota rule is scoped under `#quota`
so a bare `.q` cannot leak in again.

## 2026-08-29 — Message a session, then chat with it (`f71cd7a`, `6122ac2`)

**What:** `POST /talk?pid=` types the request body into a session's prompt over the same
AppleScript path as `/compact`. The composer shows the last 24 turns from `GET /thread?pid=`.

**Why:** The dashboard could watch sessions but not reach them.

**Verified:** End to end against a live session — sent a message, read the terminal back, got the
reply. Then again through the UI.

**Security, deliberately:** kept as its own endpoint rather than widening `/send`'s allowlist,
because this genuinely *is* "type into my terminal over HTTP" and the README should say so.
Control characters are stripped rather than escaped — a newline would submit early and type the
remainder as a second prompt, and ESC sequences would drive the TUI. 2000 char cap. The text
reaches the AppleScript literal with `\` and `"` escaped, the only two ways out of it;
`--selftest` asserts this including a `"; do shell script "…` break-out attempt. The prompt rides
in the request body, never the query string, so it stays out of logs.

**Rejected:** the peer socket at `/tmp/cc-socks/<pid>.sock`. It is strictly better — structured
messages arriving like another Claude's `SendMessage`, and it is the *only* way to reach a
headless session — but it needs a token-signed frame protocol (`peerToken` from the
`<pid>.<hash>.key` files, auth prefix + JSON + newline) that is entirely undocumented and would
break on any Claude Code update. Still the right long-term answer.

**Performance:** the thread is served on demand, not pushed to the 2s poll. 24 turns × 1500 chars
across every session is megabytes a minute, so `thread` is stripped from the `/api` payload.

## 2026-08-29 — say → talk, send and close buttons (`d4ea7b2`, `fadddca`)

**What:** Renamed throughout including the endpoint, moved the button to the tile's bottom-right,
added the send button the composer never had, added a close `×`.

**Why:** "Not sending on clicking send" was accurate — there was nothing to click, only
enter-to-send.

## 2026-08-29 — Badge what a session *is* (`a7aa45a`)

**What:** `scan()` reports each session's tty from one `ps -eo pid=,tty=`, and the badge derives
from that: `bg` when headless, `bg · attached` when a bg session holds a tty, `parked` when
`parkedJobId` is set, `interactive` otherwise.

**Why:** The registry's `kind` is **write-once at launch and never corrected**. Attach a bg
session and it still says `bg` while holding a real tty; park an interactive one behind a job and
it still says `interactive`. Two sessions were mislabelled, and one had `talk` wrongly disabled
even though it was perfectly typeable.

**Verified:** All twelve live sessions cross-checked against `ps` output. `talk` is now gated on
the tty, which is what `/talk` actually requires — button and endpoint agree instead of
disagreeing.

## 2026-08-31 — Markdown in the chat (`d494a48`)

**What:** ~30 lines, no dependency: bold, italic, inline and fenced code, lists, headings, links.

**Why:** Claude replies in markdown, so the thread was showing raw `**` and ``` ``` ``` at the
reader.

**Verified:** It is an XSS surface, so the ordering matters — escape first, then only ever
pattern-match over already-escaped text, so no tag can be built from message content. Link hrefs
restricted to `http(s)`. Tested `<script>`, `<img onerror>`, and `[x](javascript:…)` by parsing
the output into a real DOM: **0** live `script`/`img`/`onerror` nodes, one surviving href, and it
was the https one.

**Known gap:** card text is still escaped-only, so `**bold**` shows raw there. Tiles clamp to two
lines and block elements would break the clamp; an inline-only pass would fix it.

## 2026-08-31 — Session chatter feed (`0.5.0`)

**What:** A "Session chatter" section under the session grid: every session-to-session message
as one `from → to` line, newest first, 60 deep.

**Why:** The traffic was already parsed into `inbox`/`outbox` and already shipped in `/api` — it
was only ever shown as a transient fly-across animation, so anything you didn't happen to be
looking at was lost. The feed is built entirely client-side from the existing payload, so it
costs zero extra bytes over the wire and no extra file reads.

**Two joins make it read as one conversation:**
- Every message is written *twice* — the sender logs a `SendMessage` tool_use, the receiver logs
  a `<cross-session-message>`. The receiver's copy is canonical because it resolves **both** ends
  to a pid; each outbox entry is then joined onto one inbox row within the same 120s window
  `correlate()` uses. Unjoined outbox entries went somewhere with no visible transcript, and are
  shown one-sided as "not seen arriving" rather than dropped.
- Same sender, same text, within 120s = one message. Without this, a broadcast to four sessions
  was four identical rows, and two live sessions sharing a name (`Harvey (Chief of Staff)` and
  `Harvey (Chief of Staff) [6f73e7]`) produced a near-duplicate pair. Recipients now collect onto
  one row.

**Verified:** Ran the join over a live `/api` capture — 92 inbox rows, 47 outbox entries joined,
41 genuinely one-sided, **0 rows with empty text**. Rendered in the browser and read it: 60 rows,
0 console errors, and the message bodies stay at full contrast (only timestamps and the arrow are
`--dim`) so it does not repeat the washed-out quota bug. Marked a row, waited two full 2s ticks,
confirmed the same node was still connected — the feed only re-renders when `rows.length` or the
newest timestamp changes, so text selection survives.

**Rejected:** Building the feed server-side. `/api` is already 232 KB every 2 seconds; a `feed`
array would have duplicated bytes that are already in the payload. Also rejected filtering out the
claude-mem observer relays by cwd — plugin-specific and brittle. Merging duplicates handles them
generally: they now fold into the real recipient's row.

**Also:** deleted a dead duplicate `correlate()`. Two definitions existed; the second silently won.

**Known gap:** messages you send from the dashboard's own composer don't appear. `/talk` types into
the terminal, so they land in the transcript as ordinary typed prompts with nothing marking them as
having come from here.

## 2026-08-31 — Chatter moved beside each project (`0.5.1`)

**What:** The one global feed became one collapsible panel per project, sitting to the right of
that project's tiles and carrying only messages its own agents took part in.

**Why:** Asked for. A single list mixed four projects' conversations into one stream, so the
`astro` agents' back-and-forth was interleaved with `jobHunt`'s and neither read as a thread.

**How the scoping works:** each row carries the cwds of both ends — the sender's resolved from
its pid, the recipients' from theirs (or by name, for a one-sided row). A panel takes every row
with one end in its project, so a message *between* two projects shows in both. Nothing is
dropped: every row has at least one end in a scanned session. A project with no traffic gets no
panel and its tiles take the full width.

**Verified:** Rendered it — three panels (astro 40, jobHunt 40, observer-sessions 1), the fourth
project correctly panel-less, each panel to the right of its own grid, 0 console errors.

**The 2s trap, third time:** `#groups` is rebuilt every tick, so a `<details>` collapsed by the
user re-opens itself and any scroll inside resets. Both now live outside the DOM — a `Set` of
collapsed cwds and a `Map` of scroll offsets, restored after each render. Tested by collapsing one
panel and scrolling another, then waiting two full ticks: node replaced, still collapsed, scroll
still at 120px, and the other panels untouched.

**Also:** the per-project cap is 40 rows; the merge no longer caps globally, or a busy project
would starve a quiet one of its history.

## 2026-08-31 — Read the full message behind a summary (`0.5.5`)

**What:** A `full` toggle on every chatter row, and a `GET /message?pid=&at=&to=` behind it.

**Why:** Rows show the one-line summary the sending agent wrote in its own `SendMessage` call.
The actual message body was nowhere in the payload — the closest thing was a 700-char clip, and
the summaries are a median ~56 chars, so most of what one agent told another was unreadable.

**Why an endpoint and not the payload:** `/api` is already 232 KB every 2 seconds. Full bodies
run to thousands of characters each, 20 per session — tens of KB per session per poll for text
nobody is reading. So `ingest()` keeps the whole body in memory (capped at 20 KB, last 20 per
session), `full` is stripped from the `/api` response the same way `thread` is, and it is served
only when someone clicks.

**Finding the right message:** a row's timestamp is the *receiver's*, but the body lives in the
*sender's* transcript, so the lookup matches within the same 120s window the two halves are
already joined on, preferring an entry addressed to a recipient the row names. Measured skew on a
real pair: **26.9s** — comfortably inside the window, and the reason it isn't tighter.

**Verified:** Against live data — a real message came back at 2499 chars against its 698-char
preview, and the same text was confirmed absent from the `/api` payload. Receiver-side lookup
returned 5596 chars across a 26.9s skew. Failure paths return a sentence, not a stack: dead pid,
timestamp with nothing near it, and non-numeric junk all answer `{ok:false}`. In the browser: 44
chars → 2488 on click, clamp lifted, still expanded after two ticks and a node replacement,
`less` restores the summary, and reopening is served from cache without a refetch.

**Detail worth keeping:** expanding scrolls the sender line back into view. Without it the body
fills the 24rem log and you lose sight of who sent the thing you are reading.

## 2026-08-31 — Show background jobs, not just processes (`0.6.0`)

**What:** Sessions with no process now appear as tiles, read from `~/.claude/jobs/<id>/state.json`.
Four were invisible on this machine: 16 real sessions against the 12 the dashboard showed.

**Why:** `scan()` only ever read `~/.claude/sessions/<pid>.json`, and that registry is keyed by
pid. A background job that isn't currently running has no pid, so it has no entry — it existed,
held a transcript and hundreds of millions of tokens, and simply never appeared.

**Asked for remote sessions; this is what was reachable.** Cloud and Remote Control sessions are
real (12 cloud, ~40 Remote Control on this account) but not obtainable locally: nothing on disk
holds them — a distinctive cloud session title appears nowhere under `~/.claude` or in
`~/.claude.json` — `daemon/roster.json` is empty with `auth_required`, no CLI command lists them,
and the only transport is `wss://bridge.claudeusercontent.com`, an undocumented token-authenticated
websocket. That is the peer-socket decision again, and worse: a remote service this time. Rejected.

**Rejected also:** shelling out to `claude agents --json` on the poll. It returns exactly the same
sessions, but it spawns a 197 MB binary every 2 seconds when the underlying state is a small JSON
file we can read directly.

**Job state carries more than the registry does:** `name`, `cwd`, `createdAt`, `sessionId`, and a
`needs` field saying what the job is waiting on. That last one is now on the tile as *blocked on*,
which is the whole point — one of these had been sitting on "confirm: build nudge + separate
once-per-conversation budgets" for 15 days.

**Everything keyed on pid needed a second key.** Tiles, the open-breakdown set, and the feed's
name/cwd maps all assumed a pid exists. `data-job` carries the short id instead, the breakdown set
keys on `job:<id>`, clicking copies `claude attach <id>` rather than POSTing `/focus?pid=null`, and
the feed's maps now filter out pid-less sessions — four `null` keys would otherwise collide into
one. Verified none of it regressed: 16 tiles, 0 `pid null` in the DOM, kill/compact/talk absent on
job tiles, one job's breakdown stayed open across two ticks while the other three stayed shut.

**Note:** a job is `blocked`, not `stale` — it has its own colour. Stale means the process died;
these are parked and resumable, which is a different thing to tell someone.

## 2026-08-31 — Suggested run rate (`0.6.1`)

**What:** `suggestedRatePerDay` on the budget strip and in `--report`: what is left divided by the
time still on the clock. Spend at that rate and the week ends exactly as the quota does.

**Why:** the strip said what you *are* spending and whether you'd run dry, but never what you
*should* spend. That is the number you act on.

**Verified:** recomputed independently from `tokensRemaining` and `resetsAt` — 435,067,892 against
435,072,662, the gap being the seconds between the two clock reads.

**Rejected:** colouring it red/green by whether the current rate is above it. It duplicates what
`projected = N%` and *runs out / to spare* already say, and a red target reads as though the target
itself were the problem. It is a goal, not a verdict, so it renders plain.

**Follow-up (`0.6.2`, `0.6.3`):** the target moved to sit under *all tokens today* as
`target N/day`, next to the value it judges, and was then removed from the weekly strip — carrying
it in both places was the same number twice. It stays in `--report`, which has no stat cards.

**Follow-up (`0.6.4`):** today's total is coloured against that target — green under 80%, amber to
100%, red above. Bands are scoped as `.stat b.hot` and friends: a bare `.hot`/`.warn` would collide
with the quota bands, which is precisely how the `.q` bug happened. Nothing lives in colour alone —
both numbers are on the card and the tooltip gives the percentage.

## 2026-09-01 — Git clones chart removed (`0.7.2`)

**What:** `0.7.0` and `0.7.1` reverted. No repo traffic panel, no `gh` call, no
`~/.switchboard/traffic.json`. The dashboard is Claude Code sessions again, and nothing else.

**Why:** it was off-mission, which was true when it was built and said so at the time. Repo traffic
is not a session, and the owner already tracks clone counts on his own site — so this was a second
place for the same number to drift out of date.

**Reverted, not force-pushed.** The repo is public and had 56 unique cloners at the time; rewriting
`main` would have broken every one of those clones to save two commits of history. `git revert`
leaves them able to pull.

**The version had to go *up*, not back.** The revert returned both manifests to `0.6.4`, and
installed copies were on `0.7.1` — `claude plugin update` compares versions, so every installation
would have silently kept the panel forever. Hence `0.7.2`. This is the trap the house rules already
warn about, met from the one direction that isn't obvious: removing a feature still needs a bump.

**Standing note:** if repo traffic ever comes back, `gh api repos/<slug>/traffic/clones` is the
endpoint, it needs push access, it only serves 14 days, and daily uniques must never be summed.

## 2026-09-01 — An agent can compact itself (`0.8.0`)

**What:** `POST /self?pid=$$&cmd=compact`. The caller passes its own pid and the server works out
which session that is, then types the command into that session's terminal.

**Why:** `/compact` is a TUI keystroke. An agent is mid-turn *inside* the TUI, so it cannot type it,
and there was no other way for a session to compact itself. It can run a shell command, so the curl
is the missing hop.

**Resolution is the whole feature.** `/send` already existed with the allowlist — what was missing
was a way for a caller to name itself. It walks up the process tree from the given pid until it
hits one the session registry knows: from a Bash tool call that is one or two hops (tool shell ->
`claude`). Capped at 12 hops.

**The queue is the point, not a limitation.** The caller is busy by definition — it is mid-turn
asking for this — so the typed input queues and runs when the turn ends. Confirmed live:
`{"ok":true,"app":"Terminal","tty":"ttys082","queued":true}`.

**Verified, including every way in:** resolved this session from `$$` as pid 27153 "me"; `cmd=bash`
refused; `cmd=compact;rm -rf /` refused *by name*, since it is matched as one whole string against
the allowlist rather than parsed; `pid=1` refused as not inside a session; a request carrying
`Origin: https://evil.example` refused; and GET returns identity without running anything.

**Note:** `sameOrigin()` already passed curl — a request with no `Origin` header is allowed, which
is what makes this reachable at all. That was existing behaviour, not something loosened for this.

**Left as-is:** the allowlist keeps all four commands rather than narrowing to `compact`. The other
three are read-only and already worked from the dashboard; removing them would have taken away
something that works to satisfy a "for now".

## 2026-09-01 — compact_self as an MCP tool (`0.9.0`)

**What:** the plugin now ships an MCP server (`switchboard-mcp.js`, declared in `.mcp.json`)
exposing one tool, `compact_self`. Installing the plugin is the whole setup — agents have it.

**Why this beats the curl:** Claude Code spawns a stdio MCP server as a **child of the session
process**, so `process.pid`'s ancestry leads straight to the session. The agent passes nothing —
no pid, no session id, no port. Verified against a running server: MCP pid `15254` → parent
`15133` → `claude`, which is a registered session.

**Deliberately thin.** It resolves nothing and validates nothing itself — it POSTs to `/self`,
which already does both. Two copies of that logic would be two things to keep in step.

**Only `compact` is exposed.** `context`, `cost` and `status` are on the HTTP allowlist and stay
there, but their output prints into the terminal where the agent that asked cannot read it. Useful
from the dashboard, pointless as a tool.

**Port discovery:** the server walks upward from 7823 if the port is taken and never recorded where
it landed. It now writes `~/.switchboard/port` on listen; the MCP server reads that, falls back to
probing 7823-7832, and honours `SWITCHBOARD_PORT`.

**Verified** by driving the server over stdio against a stub: `initialize` returns the right
serverInfo, `tools/list` returns `compact_self`, `tools/call` produced exactly
`POST /self?pid=<own pid>&cmd=compact`, an unknown tool name is refused, a deliberately malformed
JSON frame did not kill the process, and a notification (`notifications/initialized`) correctly drew
no response. Real ancestry resolution was checked separately and read-only: a spawned grandchild
process resolved to pid 27153, the right session. The tool was never called for real against a live
session — that would have compacted the owner's conversation to prove a point.

**Known limit:** in Cursor the MCP server's parent is a Cursor helper, not `claude`, so resolution
fails there — the same reason Cursor sessions can't be typed into at all. The error says so rather
than failing silently.

## 2026-09-01 — The await list (`0.10.0`)

**What:** an `await(waiting_for)` MCP tool, `POST /await?pid=`, and an **Awaiting** panel at the top
of the dashboard ordered by longest wait.

**Why:** suggested by a commenter, and it solves the thing the dashboard structurally cannot. From
outside, a session waiting on something external is indistinguishable from an idle one — `stalled`
is a heuristic only because Claude Code writes no blocked state anywhere. A session that *declares*
what it is waiting on is the one piece of state on the page that is not inferred.

**The clearing rule was the only real design question.** "Clear when the session next does
something" fails: the tool call is itself mid-turn, so the entry would vanish a second after being
written. It anchors on `lastUserAt` — the timestamp of the last real user message — and clears when
a newer one arrives, which is the event that would actually unblock it. That meant adding
`lastUserAt` to the parser; only `lastUser` (the text) was tracked.

**Ordering is the feature.** Tiles sort by tokens burned, which is the wrong axis for "who needs
me". The panel sorts oldest-first so the longest wait is the top row.

**Verified:** registration, the empty-text refusal, a pid outside any session, and a cross-origin
POST all behave. Both lifecycle rules were tested deterministically by seeding
`~/.switchboard/awaiting.json` and restarting — an entry with a stale `sinceUserAt` and one naming a
dead session were both dropped, and the pruned file was written back. The MCP leg was driven over
stdio against a stub: two tools exposed, `waiting_for` required, and `POST /await?pid=<own pid>`
carrying the text in the body.

**`--selftest` did not catch the bug this introduced.** The first version put the await block above
`const DATA`, so the server died at load with a TDZ error — while `--selftest` still printed OK,
because it exits before reaching that line. **A green selftest does not mean the server starts.**
Start it and curl it.

**Not built yet:** waking a waiting session automatically. Switchboard can already type into a
terminal, so "check back in 1m" is reachable — left until the list alone proves insufficient.

## 2026-09-02 — The budget was inflated 43x (`0.11.0`)

**What:** the quota window is now anchored on the **observed** restart of the reported percentage,
not on `resets_at` minus seven days. The dashboard was showing `100% ≈ 58.36B` where the truth was
about `1.36B`.

**The actual cause, which was not the first theory.** I assumed a mid-window reset that left
`resets_at` alone. The sample history said otherwise: on **2026-09-01 23:34 the percentage went
58% → 0% and `resets_at` moved at the same time** — to a point only **2.4 days** later, not seven.
So the window genuinely is not seven days long, and deriving its start from its end put us four days
early. Four extra days of measured tokens were then divided by a percentage counting from zero.
`1.75B / 0.03 = 58B`.

**Fix:** any drop of ≥5 percentage points is a restart, whether or not `resets_at` moves with it,
and that instant becomes the measurement anchor. Stored in `~/.switchboard/quota-anchor.json`, valid
while it falls inside the current window.

**Recovering the window we were already in:** the poller only sees drops that happen while it runs,
and this one predated the detector. But the sampler had been recording the percentage every five
minutes all along, so the restart was in `samples.jsonl` — `backfillAnchor()` scans for the most
recent drop and anchors to it. It found 2026-09-01 23:34 and the measured figure fell from 1.75B to
39M, which is what 3% of ~1.3B should look like.

**Provisional rather than hidden.** My first attempt suppressed the budget below 5% reported. That
trades a wrong number for no number, and no number for a whole day is worse. It now shows the
estimate with the arithmetic swing stated: at 3%, half a point of rounding is ±17%.

**Verified:** anchor recovered from history unaided; implied went 58.36B → 1.36B; the strip carries
both the provisional and the re-anchored explanations; `--selftest` gained six assertions on the
drop detector (restart, mid-window reset, ordinary growth, rounding noise, sub-threshold drop, and
missing readings). The detector had to move above the CLI blocks to be reachable from the selftest,
which exits before the rest of the file — the same TDZ shape as `osaLit`.

**Also:** the strip says "this window" rather than "this week" when re-anchored, because 2.4 days
is not a week and the label was quietly making the same wrong assumption the code was.

## 2026-09-02 — The talk panel was unreadable (`0.12.0`)

**What:** four fixes to the message composer, found by opening a real thread and reading it rather
than reasoning about the markup.

**1. Markdown emphasis was styled as a header.** `#talklog .m i` was written for the "Harvey · 1h
ago" line, but it catches every `<i>` in the message — including italics the agent wrote. Emphasised
words rendered at **10.88px and 30% opacity mid-sentence**, so *"supplies only `one` of the two
names"* read like a broken tag. Eight of them in one thread. This is the third time a broad
descendant selector has caught content it was never meant to — after `.q` and `.what .q`. The
header is now `i.hd` and a bare `.m i` is restored to plain italic.

**2. Nothing separated one message from the next.** An 8px gap, no rule, no border, with message
heights running 36px to 653px. A 1px top border and a bold sender name now bound each turn.

**3. The log showed 6.5% of the thread** — 416px holding 6407px — while the composer took 146px of
the panel's 562px for a two-line textarea. The panel is now a flex column capped at the viewport,
the log takes the leftover height, and the textarea starts at one line. Log went 416px → **828px**,
composer 146px → 118px, visible fraction 6.5% → **11.5%**.

**4. Long messages were cut at 1500 chars with nothing saying so** — 8 of 24 in this thread, ending
mid-sentence. The thread is fetched on demand, not in the 2s payload, so the cap costs little: it is
now 8000, and anything still cut carries a `cut` flag rendering as *"… truncated"*. The longest real
message is 2494 chars, so nothing is cut today.

**Left alone deliberately:** assistant text is dimmed to 55% while the owner's own messages are full
white — the thing you are there to read is the less legible half. Flagged, and the owner chose to
see whether it still reads badly once the rest was fixed.

---

## Standing notes for whoever works here next

- **Nothing here is public API.** The `~/.claude` layout, transcript record shapes, the
  `uds:/tmp/cc-socks/<pid>.sock` sender string, the usage endpoint — all internal, all liable to
  change. Parsers skip records they don't understand, so the failure mode is missing data rather
  than a crash. Keep it that way.
- **Zero dependencies is a feature.** Two files and Node's stdlib. Don't add a package for
  something thirty lines can do.
- **The 2s re-render eats DOM state.** See the compact-button entry.
- **Bump the version in both manifests** or `claude plugin update` will not ship your change.
- **Verify by running it, not by reading it.** Almost every wrong call in this log came from
  reasoning about the code instead of looking at the output.
- **Never log or serve the OAuth token.** It is read from the Keychain for one request and
  nothing else.
