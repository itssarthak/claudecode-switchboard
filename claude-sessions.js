#!/usr/bin/env node
// Live view of Claude Code sessions.
//   state:  ~/.claude/sessions/<pid>.json      (pid, cwd, name, status)
//   usage:  ~/.claude/projects/<slug>/<sessionId>.jsonl  (per-message token usage)
const fs = require('fs'), http = require('http'), path = require('path'), os = require('os');
const { execFileSync } = require('child_process');
const HOME = os.homedir();
const SESSIONS = path.join(HOME, '.claude', 'sessions');
const PROJECTS = path.join(HOME, '.claude', 'projects');
const BURN_WINDOW = 5 * 60e3;   // "active" consumption = last 5 minutes

const dayKey = ts => {                                   // local calendar day, not UTC
  const d = new Date(ts);
  return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
};
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } };

// --- transcript index: sessionId -> jsonl path. Slug rules are lossy, so just look. ---
let index = new Map(), indexedAt = 0;
function transcriptOf(id) {
  if (!fs.existsSync(PROJECTS)) return null;
  if (!index.has(id) && Date.now() - indexedAt > 10e3) {
    index = new Map(); indexedAt = Date.now();
    for (const d of fs.readdirSync(PROJECTS, { withFileTypes: true }).filter(d => d.isDirectory()))
      for (const f of fs.readdirSync(path.join(PROJECTS, d.name)))
        if (f.endsWith('.jsonl')) index.set(f.slice(0, -6), path.join(PROJECTS, d.name, f));
  }
  return index.get(id);
}

// --- incremental transcript parser -------------------------------------------------
// Transcripts are append-only, so each poll reads only the bytes added since the last one.
// Streaming re-writes the same assistant message many times => dedup on message.id or
// every total is inflated ~2x.
const parsed = new Map();
const blank = () => ({
  off: 0, buf: '', ids: new Set(), recent: [],
  tok: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: 0 },
  msgs: 0, turns: 0, tools: 0, byTool: {}, sidechain: 0, ctx: 0, daily: {},
  model: null, effort: null, branch: null, lastAt: 0, modelAt: 0,
  summary: null, lastUser: null, lastAssistant: null, lastTool: null, lastToolAt: 0,
  inbox: [], outbox: [], pat: {}, thread: [], full: [],
});

function usage(file) {
  let st = parsed.get(file);
  const size = fs.statSync(file).size;
  if (!st || size < st.off) { st = blank(); parsed.set(file, st); }   // truncated/replaced -> reparse
  if (size > st.off) {
    const fd = fs.openSync(file, 'r'), len = size - st.off;
    const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.off); fs.closeSync(fd);
    st.off = size;
    const lines = (st.buf + b.toString('utf8')).split('\n');
    st.buf = lines.pop();                                            // trailing partial line
    for (const line of lines) { if (line) try { ingest(st, JSON.parse(line)) } catch {} }
  }
  const now = Date.now();
  st.recent = st.recent.filter(r => now - r.ts < BURN_WINDOW);
  const burn = st.recent.reduce((n, r) => n + r.out, 0);
  const { off, buf, ids, recent, thread, full, ...out } = st;
  return { ...out, total: Object.values(st.tok).reduce((a, b) => a + b, 0) - st.tok.thinking, burn };
}

// injected pseudo-user turns: tool results, <system-reminder>, observer/cross-session relays
const THREAD_TURNS = 24, THREAD_CHARS = 1500, MSG_MAX = 20000;
const NOISE = /^(<|\[MESSAGE FROM NON-USER|Another Claude session sent|Caveat: The messages below|This session is being continued|Continue from where you left off)/;
// receiver side of a session->session message: the socket path carries the sender's pid
const XSESS = /<cross-session-message from="uds:[^"]*?\/(\d+)\.sock"(?:[^>]*?from-name="([^"]*)")?[^>]*>\s*([\s\S]{0,1200})/;
// summaries are short (median ~56 chars); only the raw-body fallback needs cutting, and
// slicing mid-word looks broken - break at whitespace instead
const clip = (t, n = 700) => {
  t = String(t || '').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 60)).trimEnd() + '…';
};
const text = m => (typeof m?.content === 'string' ? m.content
  : (m?.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ')).trim();

const bump = (o, k) => { if (k != null) o[k] = (o[k] || 0) + 1 };
const patDay = (st, ts) => st.pat[dayKey(ts)] ??=
  { hour: {}, dow: {}, tool: {}, model: {}, effort: {}, prompts: 0, chars: 0, interrupts: 0 };
function mergePat(into, from) {
  for (const [day, p] of Object.entries(from)) {
    const t = into[day] ??= { hour: {}, dow: {}, tool: {}, model: {}, effort: {}, prompts: 0, chars: 0, interrupts: 0 };
    for (const k of ['hour', 'dow', 'tool', 'model', 'effort'])
      for (const [x, n] of Object.entries(p[k])) t[k][x] = (t[k][x] || 0) + n;
    t.prompts += p.prompts; t.chars += p.chars; t.interrupts += p.interrupts;
  }
  return into;
}

function ingest(st, e) {
  // claude code writes its own auto-generated session title as a bare record - no .message
  if (e.type === 'summary' && e.summary) st.summary = e.summary;
  const ts = Date.parse(e.timestamp) || 0;
  if (ts > st.lastAt) st.lastAt = ts;
  if (e.gitBranch) st.branch = e.gitBranch;
  if (e.effort) st.effort = e.effort;
  if (e.isSidechain) st.sidechain++;

  const c = e.message?.content;
  if (Array.isArray(c)) for (const p of c) if (p.type === 'tool_use') {
    st.tools++; st.byTool[p.name] = (st.byTool[p.name] || 0) + 1;
    st.lastTool = p.name; st.lastToolAt = ts;                        // best "doing right now" signal
    if (ts) bump(patDay(st, ts).tool, p.name);
    if (p.name === 'SendMessage') {
      st.outbox.push({ at: ts, to: p.input?.to ?? null, summary: p.input?.summary || null,
                       preview: clip(p.input?.message) });
      st.outbox.splice(0, st.outbox.length - 20);
      // the whole message, kept in memory and served only when someone asks for it - putting
      // it in the 2s payload would be tens of KB per session that nobody is reading
      st.full.push({ at: ts, to: p.input?.to ?? null,
                     text: String(p.input?.message ?? '').slice(0, MSG_MAX) });
      st.full.splice(0, st.full.length - 20);
    }
  }
  if (!e.isSidechain) {
    const t = text(e.message);
    // tool results and <system-reminder>/<local-command-stdout> arrive as type:'user' too - skip them
    const x = t && XSESS.exec(t);
    if (x) {
      st.inbox.push({ at: ts, from: Number(x[1]), name: x[2] || null, body: clip(x[3]) });
      st.inbox.splice(0, st.inbox.length - 20);
    }
    if (t && e.type === 'user' && !NOISE.test(t)) st.lastUser = t.slice(0, 300);
    if (t && e.type === 'assistant') st.lastAssistant = t.slice(0, 300);
    // rolling transcript tail for the composer. Streaming rewrites the same assistant
    // message repeatedly, so match on id and replace rather than append a duplicate.
    if (t && (e.type === 'assistant' || (e.type === 'user' && !NOISE.test(t)))) {
      const id = e.message?.id || e.uuid || null;
      const at = id && st.thread.find(m => m.id === id);
      if (at) { at.text = t.slice(0, THREAD_CHARS); at.at = ts || at.at }
      else {
        st.thread.push({ id, role: e.type, at: ts, text: t.slice(0, THREAD_CHARS) });
        st.thread.splice(0, st.thread.length - THREAD_TURNS);
      }
    }
  }
  // a real user turn: a user message that is prose, not a tool result being fed back
  if (e.type === 'user' && !e.isSidechain &&
      (typeof c === 'string' || (Array.isArray(c) && c.some(p => p.type === 'text')))) {
    st.turns++;
    const txt = text(e.message), d = ts && patDay(st, ts);
    if (d && txt) {
      if (txt.startsWith('[Request interrupted')) d.interrupts++;
      else if (!NOISE.test(txt)) {                                   // count what you actually typed
        d.prompts++; d.chars += txt.length;
        const at = new Date(ts);
        bump(d.hour, at.getHours()); bump(d.dow, at.getDay());
      }
    }
  }

  const u = e.message?.usage;
  if (!u || st.ids.has(e.message.id)) return;                        // <-- the dedup
  st.ids.add(e.message.id);
  st.msgs++;
  // model/effort are only on assistant replies, so stamp when they were last true
  if (e.message.model) { st.model = e.message.model; st.modelAt = ts || st.modelAt }
  if (ts) { const d = patDay(st, ts); bump(d.model, e.message.model); bump(d.effort, st.effort) }
  st.tok.input += u.input_tokens || 0;
  st.tok.output += u.output_tokens || 0;
  st.tok.cacheWrite += u.cache_creation_input_tokens || 0;
  st.tok.cacheRead += u.cache_read_input_tokens || 0;
  st.tok.thinking += u.output_tokens_details?.thinking_tokens || 0;  // subset of output
  // context currently in play = what the last request actually carried
  st.ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  st.recent.push({ ts, out: u.output_tokens || 0 });
  const day = dayKey(ts || Date.now());
  const d = st.daily[day] ??= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, msgs: 0 };
  d.input += u.input_tokens || 0; d.output += u.output_tokens || 0;
  d.cacheWrite += u.cache_creation_input_tokens || 0; d.cacheRead += u.cache_read_input_tokens || 0;
  d.msgs++;
}

// --- account-wide rollup ------------------------------------------------------------
// transcripts run to gigabytes, so: walk them in the background, chunked, and only ever read
// the bytes each file has grown by. Requests serve the last completed pass.
const DAYS = Number(process.env.DAYS) || 7;
let rollup = { days: {}, files: 0, sessions: 0, scanning: true, done: 0, at: 0 };

function rollupPass() {
  if (!fs.existsSync(PROJECTS)) return;
  const cutoff = Date.now() - DAYS * 864e5;
  const files = [];
  for (const d of fs.readdirSync(PROJECTS, { withFileTypes: true }).filter(d => d.isDirectory()))
    for (const f of fs.readdirSync(path.join(PROJECTS, d.name)))
      if (f.endsWith('.jsonl')) {
        const fp = path.join(PROJECTS, d.name, f);
        try { if (fs.statSync(fp).mtimeMs > cutoff) files.push(fp) } catch {}
      }
  const days = {}, pat = {};
  const next = { days, pat, files: files.length, sessions: 0, scanning: true, done: 0, at: Date.now() };
  rollup = { ...rollup, files: files.length, scanning: true, done: 0 };
  let i = 0;
  (function step() {
    for (let n = 0; n < 3 && i < files.length; n++, i++) {
      try {
        const st = usage(files[i]);
        if (st.msgs) next.sessions++;
        mergePat(pat, st.pat);
        for (const [day, t] of Object.entries(st.daily)) {
          const acc = days[day] ??= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, msgs: 0 };
          for (const k of Object.keys(acc)) acc[k] += t[k] || 0;
        }
      } catch {}
    }
    next.done = i;
    rollup = { ...next, scanning: i < files.length };
    if (i < files.length) setImmediate(step);
  })();
}
setTimeout(rollupPass, 200);
setInterval(rollupPass, 60e3);

// the conversation tail for one session, fetched on demand rather than pushed to every poll
function threadOf(pid) {
  const s = scan().find(x => x.pid === pid);
  if (!s) return { ok: false, error: 'no such session' };
  const t = transcriptOf(s.sessionId);
  if (!t) return { ok: false, error: 'no transcript yet' };
  usage(t);                                              // make sure the tail is current
  return { ok: true, name: s.name || String(pid), alive: s.alive, status: s.status,
           messages: parsed.get(t)?.thread || [] };
}

// `kind` records how a session was launched and is never rewritten, so an attached bg
// session still says "bg" and a parked interactive one still says "interactive". The tty is
// the honest signal: no tty means nothing can be typed into it. One ps for the whole scan.
// The panel shows the one-line summary the sender wrote; this returns the message body behind
// it. Sender pid plus a timestamp identifies it - the receiver logs the message a beat after the
// sender does, so match on the same 120s window the two halves are joined on, preferring an
// entry addressed to one of the recipients the row already names.
function messageOf(pid, at, to) {
  const s = scan().find(x => x.pid === pid);
  if (!s) return { ok: false, error: 'that session is no longer on this machine' };
  const t = transcriptOf(s.sessionId);
  if (!t) return { ok: false, error: 'no transcript for that session' };
  usage(t);
  const all = parsed.get(t)?.full || [];
  const near = all.filter(m => Math.abs(m.at - at) < 12e4);
  if (!near.length) return { ok: false, error: 'the full message is no longer in memory' };
  const named = to ? near.filter(m => m.to === to) : [];
  const pick = (named.length ? named : near)
    .reduce((best, m) => Math.abs(m.at - at) < Math.abs(best.at - at) ? m : best);
  return { ok: true, at: pick.at, to: pick.to, text: pick.text };
}

function ttyMap() {
  const m = new Map();
  try {
    for (const l of execFileSync('ps', ['-eo', 'pid=,tty=']).toString().split('\n')) {
      const x = l.trim().match(/^(\d+)\s+(\S+)$/);
      if (x) m.set(+x[1], x[2]);
    }
  } catch {}
  return m;
}

// A background job has no process, so it never gets a ~/.claude/sessions/<pid>.json entry and
// was invisible here. Its state lives in ~/.claude/jobs/<id>/state.json instead - the same files
// `claude agents` reads. Finished ones are skipped, which is what `claude agents` hides without
// --all. These are resumable, not dead: `claude attach <id>` opens one in a terminal.
const JOBS = path.join(HOME, '.claude', 'jobs');
const JOB_OVER = new Set(['done', 'stopped', 'failed', 'cancelled']);
function jobs() {
  if (!fs.existsSync(JOBS)) return [];
  const out = [];
  for (const d of fs.readdirSync(JOBS)) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(JOBS, d, 'state.json'), 'utf8'));
      if (!j.sessionId || JOB_OVER.has(j.state)) continue;
      out.push({ job: j.daemonShort || d, sessionId: j.sessionId, name: j.name || null,
                 cwd: j.cwd || null, status: j.state || 'unknown',
                 detail: j.detail || j.intent || null, needs: j.needs || null,
                 startedAt: Date.parse(j.createdAt) || 0,
                 statusUpdatedAt: Date.parse(j.updatedAt) || 0 });
    } catch {}                                       // a half-written state.json is not fatal
  }
  return out;
}

const scan = () => {
  if (!fs.existsSync(SESSIONS)) return [];
  const ttys = ttyMap();
  const list = fs.readdirSync(SESSIONS).filter(f => f.endsWith('.json')).map(f => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8'));
      const t = transcriptOf(s.sessionId);
      const tty = ttys.get(s.pid) || null;
      return { ...s, alive: alive(s.pid), tty, headless: !/^ttys?\d+$/.test(tty || ''),
               usage: t ? usage(t) : null };
    } catch { return null }
  }).filter(Boolean);
  const seen = new Set(list.map(x => x.sessionId));
  for (const j of jobs()) {
    if (seen.has(j.sessionId)) continue;             // already running with a pid of its own
    const t = transcriptOf(j.sessionId);
    list.push({ ...j, pid: null, kind: 'bg', alive: false, tty: null, headless: true,
                usage: t ? usage(t) : null });
  }
  return list.sort((a, b) => (b.alive - a.alive) || (b.startedAt - a.startedAt));
};

// --- self-check: incremental parse must equal a one-shot parse, and repeat polls must not drift
// The text lands inside an AppleScript string literal, so only \ and " can break out of it.
// Control characters are stripped rather than escaped: a newline would submit the line early
// and type the remainder as a second prompt, and ESC sequences would drive the TUI.
const CTRL = /[\u0000-\u001f\u007f-\u009f]/g;
const TALK_MAX = 2000;
function cleanTalk(raw) {
  const t = String(raw ?? '').replace(CTRL, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return { error: 'empty message' };
  if (t.length > TALK_MAX) return { error: `too long: ${t.length} chars, max ${TALK_MAX}` };
  return { text: t };
}
const osaLit = t => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

if (process.argv[2] === '--patterns') {
  setTimeout(() => {
    const h = habits(Number(process.argv[3]) || 90);
    if (!h.prompts) { console.log('\nNo prompts recorded yet. Let the server run through a rollup pass first.\n'); process.exit(0) }
    const bar = (n, max, w = 26) => '\u2588'.repeat(Math.max(n > 0 ? 1 : 0, Math.round(n / max * w)));
    console.log(`\nHow you use Claude Code  (${h.activeDays} active days since ${h.since})\n`);
    console.log(`  ${h.prompts} prompts  ·  ${h.promptsPerActiveDay}/day  ·  ~${h.avgPromptChars} chars each`);
    console.log(`  ${h.interrupts} interruptions (${h.interruptRate}% of turns you cut short)`);
    if (h.concurrency) console.log(`  ${h.concurrency.median} sessions at once typically, peak ${h.concurrency.max}`);

    const hv = Object.values(h.byHour), hm = Math.max(...hv);
    console.log('\n  by hour');
    for (let i = 0; i < 24; i += 1) if (hv[i]) console.log(`   ${String(i).padStart(2, '0')}h ${bar(hv[i], hm).padEnd(26)} ${hv[i]}`);

    const dv = Object.entries(h.byDow), dm = Math.max(...dv.map(x => x[1]));
    console.log('\n  by weekday');
    for (const [d, n] of dv) console.log(`   ${d} ${bar(n, dm).padEnd(26)} ${n}`);

    const tm = h.topTools[0]?.[1] || 1;
    console.log('\n  tools you lean on');
    for (const [n, c] of h.topTools) console.log(`   ${n.replace(/^mcp__[^_]+__/, '').slice(0, 22).padEnd(23)} ${bar(c, tm, 18).padEnd(18)} ${c}`);

    console.log('\n  models   ' + h.models.map(([m, n]) => `${m.replace('claude-', '')} ${n}`).join('  ·  '));
    console.log('  effort   ' + (h.effort.map(([e, n]) => `${e} ${n}`).join('  ·  ') || '—') + '\n');
    process.exit(0);
  }, 4000);
} else if (process.argv[2] === '--report') {
  const m = n => n == null ? '—' : (n / 1e6).toFixed(1) + 'M';
  const d = iso => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
  setTimeout(() => {
    const r = report(), w = r.week;
    if (!w.impliedFullWeek) {
      console.log(`\nNo usage data yet.${w.note ? ' ' + w.note : ''}`);
      console.log(`Run the server for a few minutes so it can pair a plan percentage with token counts.`);
      console.log(r.days.length ? `\n(${r.days.length} days of tokens recorded, but no plan percentage to scale them against.)\n` : '');
      process.exit(0);
    }
    console.log(`\nquota week  ${d(w.startedAt)}  ->  ${d(w.resetsAt)}   (${r.timezone})`);
    console.log(`  reported   ${w.percentUsed == null ? '—' : w.percentUsed + '%'} used`);
    console.log(`  measured   ${m(w.tokensUsed)} tokens burned${w.exact ? '' : ' (approx - no sample from week start)'}`);
    console.log(`  => 100% is ${m(w.impliedFullWeek)} tokens   [derived, see caveat]`);
    console.log(`  remaining  ${m(w.tokensRemaining)}`);
    console.log(`  run rate   ${m(w.runRatePerDay)}/day  ->  ${m(w.projectedFullWeek)} by reset (${w.projectedPercent ?? '—'}% of implied)`);
    console.log(`  to finish  ${m(w.suggestedRatePerDay)}/day would land exactly on the reset`);
    console.log(`  hits 100%  ${d(w.exhaustedAt)}`);
    console.log(`\n  day          tokens    output   %of week`);
    for (const x of r.days.slice(0, 14))
      console.log(`  ${x.date}  ${m(x.total).padStart(7)}  ${m(x.output).padStart(7)}   ${(x.pctOfWeek ?? '—') + '%'}${x.partial ? '  (partial)' : ''}`);
    if (r.weeks.length > 1) {
      console.log(`\n  week starting   tokens`);
      for (const x of r.weeks) console.log(`  ${x.from.slice(0, 10)}     ${m(x.used).padStart(7)}${x.current ? '  (current)' : ''}`);
    }
    console.log(`\n  ledger since ${d(r.since)}, ${r.samples} samples\n`);
    process.exit(0);
  }, 3000);   // let the first rollup pass finish
} else if (process.argv[2] === '--selftest') {
  const assert = require('assert');
  const file = process.argv[3] || [...(() => { transcriptOf('_'); return index.values() })()]
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  const inc = usage(file), again = usage(file);            // second poll adds nothing
  assert.deepStrictEqual(inc.tok, again.tok, 'repeat poll double-counted');
  const oneShot = blank();
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) if (l) try { ingest(oneShot, JSON.parse(l)) } catch {}
  assert.deepStrictEqual(inc.tok, oneShot.tok, 'incremental != one-shot');
  assert.ok(inc.msgs < oneShot.ids.size + 1 && inc.msgs > 0);
  // /talk hands text to an AppleScript string literal - these are the only two ways out of it
  assert.strictEqual(osaLit('say "hi"'), 'say \\"hi\\"');
  assert.strictEqual(osaLit('back\\slash'), 'back\\\\slash');
  assert.strictEqual(osaLit('a"; do shell script "rm -rf /'), 'a\\"; do shell script \\"rm -rf /');
  assert.strictEqual(cleanTalk('one\ntwo').text, 'one two');            // newline would submit early
  assert.strictEqual(cleanTalk('esc\u001b[31m').text, 'esc [31m');      // ESC would drive the TUI
  assert.strictEqual(cleanTalk('   ').error, 'empty message');
  assert.ok(cleanTalk('x'.repeat(TALK_MAX + 1)).error.startsWith('too long'));
  assert.strictEqual(cleanTalk('x'.repeat(TALK_MAX)).text.length, TALK_MAX);
  console.log('selftest OK', path.basename(file), inc.tok, `msgs=${inc.msgs}`);
  process.exit(0);
}

// --- click a tile -> focus that session's terminal -----------------------------------
// Terminal.app and iTerm expose each tab's tty to AppleScript, so the exact tab can be
// raised. Editor terminals (Cursor/VS Code) are not scriptable - best effort is to raise
// the app and tell the user which tty to look for.
const APPS = {
  'Terminal': tty => `tell application "Terminal"
      repeat with wi from 1 to count of windows
        try
          repeat with ti from 1 to count of tabs of window wi
            if tty of tab ti of window wi is "${tty}" then
              set selected of tab ti of window wi to true
              set index of window wi to 1
              activate
              return "ok"
            end if
          end repeat
        end try
      end repeat
      activate
    end tell
    return "app-only"`,
  'iTerm2': tty => `tell application "iTerm2"
      repeat with wi from 1 to count of windows
        try
          repeat with ti from 1 to count of tabs of window wi
            repeat with si from 1 to count of sessions of tab ti of window wi
              if tty of session si of tab ti of window wi is "${tty}" then
                select window wi
                select tab ti of window wi
                select session si of tab ti of window wi
                activate
                return "ok"
              end if
            end repeat
          end repeat
        end try
      end repeat
      activate
    end tell
    return "app-only"`,
};
const APP_OF = { 'Cursor': 'Cursor', 'Code': 'Visual Studio Code', 'Electron': 'Code',
                 'Terminal': 'Terminal', 'iTerm2': 'iTerm2', 'ghostty': 'Ghostty',
                 'wezterm-gui': 'WezTerm', 'alacritty': 'Alacritty', 'kitty': 'kitty' };

function hostApp(pid) {
  const ps = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=']).toString();
  const parent = new Map(), name = new Map();
  for (const l of ps.split('\n')) {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) { parent.set(+m[1], +m[2]); name.set(+m[1], path.basename(m[3])); }
  }
  for (let p = pid, i = 0; p > 1 && i < 20; p = parent.get(p), i++) {
    const app = APP_OF[name.get(p)];
    if (app) return app;
  }
  return null;
}

function focus(pid) {
  const live = scan().find(s => s.pid === pid);          // only pids in the registry
  if (!live) return { ok: false, error: 'no such session' };
  const tty = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)]).toString().trim();
  if (!/^ttys?\d+$/.test(tty)) return { ok: false, error: `odd tty: ${tty}` };
  const app = hostApp(pid);
  if (!app) return { ok: false, tty, error: 'unknown terminal app' };
  const script = APPS[app]?.(`/dev/${tty}`) ?? `tell application "${app}" to activate`;
  try {
    const r = execFileSync('osascript', ['-e', script], { timeout: 5000 }).toString().trim();
    return { ok: true, app, tty, exact: r === 'ok' };
  } catch (e) { return { ok: false, app, tty, error: String(e.stderr || e.message).slice(0, 200) } }
}

// --- run a slash command in a session -----------------------------------------------
// AppleScript can type into a live Terminal/iTerm tab. Anything on localhost can reach
// this endpoint, so it is NOT a general "type into any terminal" hole: allowlist only.
const ALLOWED = new Set(['compact', 'context', 'cost', 'status']);
const TYPE = {
  'Terminal': (tty, line) => `tell application "Terminal"
      repeat with wi from 1 to count of windows
        try
          repeat with ti from 1 to count of tabs of window wi
            if tty of tab ti of window wi is "${tty}" then
              do script "${line}" in tab ti of window wi
              return "ok"
            end if
          end repeat
        end try
      end repeat
    end tell
    return "no-tab"`,
  'iTerm2': (tty, line) => `tell application "iTerm2"
      repeat with wi from 1 to count of windows
        try
          repeat with ti from 1 to count of tabs of window wi
            repeat with si from 1 to count of sessions of tab ti of window wi
              if tty of session si of tab ti of window wi is "${tty}" then
                tell session si of tab ti of window wi to write text "${line}"
                return "ok"
              end if
            end repeat
          end repeat
        end try
      end repeat
    end tell
    return "no-tab"`,
};

function type(pid, line) {
  const live = scan().find(s => s.pid === pid);
  if (!live) return { ok: false, error: 'no such session' };
  if (!live.alive) return { ok: false, error: 'session is dead' };
  const tty = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)]).toString().trim();
  if (!/^ttys?\d+$/.test(tty)) return { ok: false, error: `odd tty: ${tty}` };
  const app = hostApp(pid);
  if (!TYPE[app]) return { ok: false, app, error: `${app || 'this terminal'} can't be typed into - editor terminals aren't scriptable` };
  try {
    const r = execFileSync('osascript', ['-e', TYPE[app](`/dev/${tty}`, osaLit(line))], { timeout: 5000 }).toString().trim();
    return r === 'ok'
      ? { ok: true, app, tty, queued: live.status === 'busy' }   // busy sessions queue the input
      : { ok: false, app, tty, error: 'tab not found' };
  } catch (e) { return { ok: false, app, tty, error: String(e.stderr || e.message).slice(0, 200) } }
}

function send(pid, cmd) {
  if (!ALLOWED.has(cmd)) return { ok: false, error: `'${cmd}' not allowed` };
  return type(pid, `/${cmd}`);
}

function talk(pid, raw) {
  const { text, error } = cleanTalk(raw);
  if (error) return { ok: false, error };
  return { ...type(pid, text), text };
}


// --- plan quota (live) --------------------------------------------------------------
// Shared endpoint: Claude Code itself calls it, once per session. Poll it gently, cache
// across restarts, and back off hard on 429 - hammering it is what gets you rate limited.
const DATA = path.join(HOME, '.switchboard');
const QCACHE = path.join(DATA, 'quota-cache.json');
const QUOTA_EVERY = 5 * 60e3;

let quotaAt = 0, quotaGood = null, quotaErr = 'not fetched yet', backoff = 0;
try {                                                    // survive a restart without refetching
  const c = JSON.parse(fs.readFileSync(QCACHE, 'utf8'));
  if (Date.now() - c.at < QUOTA_EVERY) { quotaGood = c.data; quotaAt = c.at; quotaErr = null }
} catch {}

function oauthToken() {
  for (const svc of ['Claude Code-credentials', 'Claude Code']) {
    try {
      const j = JSON.parse(execFileSync('security', ['find-generic-password', '-s', svc, '-w'],
        { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
      const t = j.claudeAiOauth?.accessToken || j.accessToken;
      if (t) return t;
    } catch {}
  }
  return null;
}

async function fetchQuota() {
  quotaAt = Date.now();
  const t = oauthToken();
  if (!t) return quotaErr = 'no oauth token in keychain (api-key auth?)';
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${t}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    if (r.status === 429) {                              // never retry straight into a 429
      const after = Number(r.headers.get('retry-after')) * 1000;
      backoff = Math.min(30 * 60e3, after || (backoff ? backoff * 2 : 5 * 60e3));
      quotaAt = Date.now() + backoff - QUOTA_EVERY;      // push the next attempt out
      return quotaErr = `rate limited, retrying in ${Math.round(backoff / 6e4)}m`;
    }
    if (r.status === 401) return quotaErr = 'token expired - run any claude command to refresh';
    if (!r.ok) return quotaErr = `HTTP ${r.status}`;
    backoff = 0; quotaErr = null;
    quotaGood = { at: Date.now(), ...(await r.json()) };
    try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(QCACHE, JSON.stringify({ at: quotaGood.at, data: quotaGood })) } catch {}
    return quotaGood;
  } catch (e) { return quotaErr = String(e.message || e) }
}

// a failed refresh keeps serving the last good numbers, flagged stale - better than blanking the bar
const quota = () => {
  if (Date.now() - quotaAt > QUOTA_EVERY) fetchQuota();
  if (quotaGood) return quotaErr ? { ...quotaGood, stale: true, error: quotaErr } : quotaGood;
  return { error: quotaErr || 'not fetched yet' };
};

// --- persistent daily/weekly ledger --------------------------------------------------
// The rollup only reads the last DAYS days and forgets everything older, so days are
// accumulated here instead. Values only ever ratchet up: a later pass that reads fewer
// transcripts must not shrink a day that was already recorded.
const LEDGER = path.join(DATA, 'ledger.json');
const PATTERNS = path.join(DATA, 'patterns.json');
const SAMPLES = path.join(DATA, 'samples.jsonl');
const SAMPLE_EVERY = 5 * 60e3;
const FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead', 'msgs'];
const totalOf = d => (d.input || 0) + (d.output || 0) + (d.cacheWrite || 0) + (d.cacheRead || 0);

let ledger = { since: null, days: {} };
try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')) } catch {}
let patterns = { days: {} };
try { patterns = JSON.parse(fs.readFileSync(PATTERNS, 'utf8')) } catch {}
const ledgerTotal = () => Object.values(ledger.days).reduce((n, d) => n + totalOf(d), 0);

let sampledAt = 0;
function sample() {
  if (rollup.scanning || !rollup.at) return;             // only record a complete pass
  quota();                                               // refresh if stale; pairs % with tokens
  sampledAt = Date.now();
  ledger.since ??= Date.now();
  for (const [day, t] of Object.entries(rollup.days)) {
    const cur = ledger.days[day] ??= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, msgs: 0 };
    for (const k of FIELDS) cur[k] = Math.max(cur[k] || 0, t[k] || 0);
  }
  // a day only ever gains records, so keep whichever pass saw more of it
  for (const [day, p] of Object.entries(rollup.pat || {})) {
    const old = patterns.days[day];
    if (!old || p.prompts + p.interrupts >= old.prompts + old.interrupts) patterns.days[day] = p;
  }
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify(ledger));
    fs.writeFileSync(PATTERNS, JSON.stringify(patterns));
    fs.appendFileSync(SAMPLES, JSON.stringify({
      t: sampledAt, total: ledgerTotal(), live: scan().filter(x => x.alive).length,
      week: quotaGood?.seven_day?.utilization ?? null,
      resets: quotaGood?.seven_day?.resets_at ?? null,
    }) + '\n');
  } catch {}
}
setInterval(sample, SAMPLE_EVERY);
setTimeout(sample, 15e3);
setTimeout(quota, 2e3);      // warm the cache so a sample never lands without a percentage

const SAMPLE_KEEP_DAYS = 120;
function trimSamples() {                                 // ~26 KB/day, so cap it at 120 days
  try {
    const cutoff = Date.now() - SAMPLE_KEEP_DAYS * 864e5;
    const lines = fs.readFileSync(SAMPLES, 'utf8').split('\n').filter(Boolean);
    const keep = lines.filter(l => { try { return JSON.parse(l).t >= cutoff } catch { return false } });
    if (keep.length < lines.length) fs.writeFileSync(SAMPLES, keep.join('\n') + '\n');
  } catch {}
}
setTimeout(trimSamples, 30e3);
setInterval(trimSamples, 12 * 3600e3);

const readSamples = () => {
  try {
    return fs.readFileSync(SAMPLES, 'utf8').split('\n')
      .filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean);
  } catch { return [] }
};

// What was the running total at time t? Prefer the last sample at or before it.
const totalAt = (samples, t) => {
  const before = samples.filter(s => s.t <= t).pop();
  return before ? { total: before.total, exact: true } : null;
};

function report() {
  const samples = readSamples();
  // the endpoint rate limits; fall back to the last sample that carried a percentage so
  // the report still works while we are backed off
  const last = [...samples].reverse().find(s => s.week != null);
  const live = quotaGood?.seven_day?.utilization != null;
  const pct = live ? quotaGood.seven_day.utilization : (last?.week ?? null);
  const resetsIso = live ? quotaGood.seven_day.resets_at : (last?.resets ?? null);
  const resets = resetsIso ? Date.parse(resetsIso) : null;
  const weekStart = resets ? resets - 7 * 864e5 : null;
  const now = Date.now(), nowTotal = ledgerTotal();
  // a stale percentage was true at its sample time, so measure tokens up to that moment
  const asOf = live ? now : (last?.t ?? now);

  // tokens burned so far this quota week
  const base = weekStart ? totalAt(samples, weekStart) : null;
  const head = live ? nowTotal : (last?.total ?? nowTotal);
  let weekUsed = base ? head - base.total : null, exact = !!base;
  if (weekUsed == null && weekStart) {                   // no sample that old yet - sum whole days
    weekUsed = Object.entries(ledger.days)
      .filter(([d]) => d >= dayKey(weekStart)).reduce((n, [, v]) => n + totalOf(v), 0);
  }

  // the number they actually want: what is 100%, in tokens, for this week
  const implied = (weekUsed && pct) ? Math.round(weekUsed / (pct / 100)) : null;
  const elapsed = weekStart ? (asOf - weekStart) / 864e5 : null;
  const rate = (weekUsed && elapsed > 0) ? weekUsed / elapsed : null;
  const projected = rate ? Math.round(rate * 7) : null;

  const days = Object.entries(ledger.days).sort((a, b) => b[0].localeCompare(a[0])).map(([date, d]) => ({
    date, ...d, total: totalOf(d),
    pctOfWeek: implied ? +(totalOf(d) / implied * 100).toFixed(1) : null,
    partial: ledger.since ? date < dayKey(ledger.since) : false,
  }));

  // past quota weeks, stepping back from the current window
  const weeks = [];
  if (weekStart) for (let i = 0; i < 6; i++) {
    const a = weekStart - i * 7 * 864e5, b = a + 7 * 864e5;
    const from = totalAt(samples, a), to = totalAt(samples, Math.min(b, now));
    if (!from || !to || to.total === from.total) continue;
    weeks.push({ from: new Date(a).toISOString(), to: new Date(b).toISOString(),
                 used: to.total - from.total, current: i === 0 });
  }

  // sample-derived weeks need a sample from each boundary; this always works, at the cost
  // of snapping to whole local days rather than the exact mid-day quota boundary
  const weekly = [];
  const dates = Object.keys(ledger.days).sort();
  if (weekStart && dates.length) {
    const first = Date.parse(dates[0] + 'T00:00:00');
    for (let a = weekStart; a + 7 * 864e5 > first; a -= 7 * 864e5) {
      const from = dayKey(a), to = dayKey(a + 7 * 864e5 - 1);
      let used = 0, n = 0;
      for (const [d, v] of Object.entries(ledger.days))
        if (d >= from && d <= to) { used += totalOf(v); n++ }
      if (n) weekly.push({ from, to, used, days: n, current: a === weekStart });
    }
  }

  return {
    now, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekly,
    week: {
      startedAt: weekStart && new Date(weekStart).toISOString(),
      resetsAt: resets && new Date(resets).toISOString(),
      percentUsed: pct, tokensUsed: weekUsed, exact,
      percentAsOf: new Date(asOf).toISOString(), percentIsLive: live,
      note: pct == null ? (quotaErr || 'no plan percentage recorded yet - cannot derive a budget')
          : live ? null : `percentage is from ${new Date(asOf).toLocaleString()} (${quotaErr})`,
      impliedFullWeek: implied,
      tokensRemaining: implied && weekUsed != null ? implied - weekUsed : null,
      runRatePerDay: rate ? Math.round(rate) : null,
      // what is left, spread evenly over the time still on the clock: spend at this rate and the
      // week ends exactly as the quota does. Above it you run dry early, below it you leave
      // budget unspent.
      suggestedRatePerDay: (implied && weekUsed != null && resets && resets > now)
        ? Math.max(0, Math.round((implied - weekUsed) / ((resets - now) / 864e5))) : null,
      projectedFullWeek: projected,
      projectedPercent: (projected && implied) ? Math.round(projected / implied * 100) : null,
      exhaustedAt: (rate && implied) ? new Date(weekStart + implied / rate * 864e5).toISOString() : null,
    },
    days, weeks,
    since: ledger.since && new Date(ledger.since).toISOString(),
    samples: samples.length,
  };
}

// The receiver's copy has the pid (so we know which two tiles) but not the summary; the
// sender's SendMessage call has the summary. Join them on sender pid + nearby timestamp.
function correlate(sessions) {
  const out = new Map();
  for (const s of sessions) if (s.usage?.outbox?.length) out.set(s.pid, s.usage.outbox);
  for (const s of sessions) for (const m of s.usage?.inbox || []) {
    let best = null, gap = 12e4;
    for (const o of out.get(m.from) || []) {
      const g = Math.abs(o.at - m.at);
      if (g < gap) { gap = g; best = o }
    }
    m.text = best?.summary || m.body || best?.preview || null;
    m.fromSender = !!best?.summary;
  }
  return sessions;
}

// Claude Code fires "Claude is waiting for your input" only after the session has been
// quiet for messageIdleNotifThresholdMs (default 60s), not at the busy->idle flip.
let idleMs = 0, idleMsAt = 0;
function idleNotifMs() {
  if (Date.now() - idleMsAt < 60e3) return idleMs;
  idleMsAt = Date.now(); idleMs = 60e3;
  for (const f of [path.join(HOME, '.claude', 'settings.json'), path.join(HOME, '.claude.json')]) {
    try {
      const v = JSON.parse(fs.readFileSync(f, 'utf8')).messageIdleNotifThresholdMs;
      if (Number(v) > 0) { idleMs = Number(v); break }
    } catch {}
  }
  return idleMs;
}

// The context window is not recorded per session anywhere: transcripts log the resolved
// name ("claude-opus-5") with the [1m] suffix stripped, and the registry carries no model
// at all. The configured default is the only real signal on disk - a session switched with
// /model since launch is invisible, so the UI treats this as a hint, not a fact.
let defModel = null, defModelAt = 0;
function defaultModel() {
  if (Date.now() - defModelAt < 60e3) return defModel;
  defModelAt = Date.now(); defModel = null;
  for (const f of [path.join(HOME, '.claude', 'settings.json'), path.join(HOME, '.claude.json')]) {
    try {
      const v = JSON.parse(fs.readFileSync(f, 'utf8')).model;
      if (typeof v === 'string' && v) { defModel = v; break }
    } catch {}
  }
  return defModel;
}

// report() re-reads the samples file, so don't rebuild it on every 2s poll
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function habits(days = 90) {
  const cutoff = dayKey(Date.now() - days * 864e5);
  const t = { hour: {}, dow: {}, tool: {}, model: {}, effort: {}, prompts: 0, chars: 0, interrupts: 0 };
  let active = 0;
  for (const [day, p] of Object.entries(patterns.days)) {
    if (day < cutoff) continue;
    active++;
    for (const k of ['hour', 'dow', 'tool', 'model', 'effort'])
      for (const [x, n] of Object.entries(p[k] || {})) t[k][x] = (t[k][x] || 0) + n;
    t.prompts += p.prompts || 0; t.chars += p.chars || 0; t.interrupts += p.interrupts || 0;
  }
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  const conc = readSamples().map(s => s.live).filter(n => n > 0).sort((a, b) => a - b);
  return {
    since: Object.keys(patterns.days).sort()[0] || null, activeDays: active,
    prompts: t.prompts, interrupts: t.interrupts,
    interruptRate: t.prompts ? +(t.interrupts / (t.prompts + t.interrupts) * 100).toFixed(1) : null,
    avgPromptChars: t.prompts ? Math.round(t.chars / t.prompts) : null,
    promptsPerActiveDay: active ? +(t.prompts / active).toFixed(1) : null,
    byHour: Object.fromEntries(Array.from({ length: 24 }, (_, h) => [h, t.hour[h] || 0])),
    byDow: Object.fromEntries(DOW.map((d, i) => [d, t.dow[i] || 0])),
    topTools: top(t.tool, 10), models: top(t.model, 6), effort: top(t.effort, 4),
    concurrency: conc.length ? { median: conc[conc.length >> 1], max: conc[conc.length - 1] } : null,
  };
}

let repAt = 0, repCache = null;
const budget = () => {
  if (Date.now() - repAt > 30e3) { repAt = Date.now(); try { repCache = report() } catch {} }
  return repCache;
};

// SIGTERM, not SIGKILL: let the session flush its transcript and registry file.
function killSession(pid) {
  const live = scan().find(s => s.pid === pid);          // only pids in the registry
  if (!live) return { ok: false, error: 'no such session' };
  if (!live.alive) return { ok: false, error: 'already dead' };
  try { process.kill(pid, 'SIGTERM') } catch (e) { return { ok: false, error: e.code || String(e) } }
  return { ok: true, name: live.name || String(pid) };
}

const PORT = Number(process.env.PORT) || 7823;
const HOST = process.env.HOST || '127.0.0.1';   // loopback only: /api carries your prompt text

// Any page you visit can hit a localhost port. <img src="...:7823/send?..."> sends no Origin,
// so an Origin check alone would not stop it - browsers do always send sec-fetch-site.
const sameOrigin = req => {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const o = req.headers.origin;
  return !o || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
};
// the prompt text rides in the body, not the query string, so it stays out of any log
const body = (req, cap = 8192) => new Promise((ok, no) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > cap) { no(new Error('body too large')); req.destroy() } });
  req.on('end', () => ok(b));
  req.on('error', no);
});

const server = http.createServer((req, res) => {
  const sendCmd = req.url.match(/^\/send\?pid=(\d+)&cmd=(\w+)$/);
  const talkPid = req.url.match(/^\/talk\?pid=(\d+)$/);
  const threadPid = req.url.match(/^\/thread\?pid=(\d+)$/);
  const focusPid = req.url.match(/^\/focus\?pid=(\d+)$/);
  const killPid = req.url.match(/^\/kill\?pid=(\d+)$/);
  if ((sendCmd || talkPid || focusPid || killPid) && !(sameOrigin(req) && req.method === 'POST')) {
    res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: false, error: 'cross-origin or non-POST request refused' }));
  }
  if (sendCmd) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(send(Number(sendCmd[1]), sendCmd[2])));
  } else if (talkPid) {
    body(req).then(
      t => talk(Number(talkPid[1]), t),
      e => ({ ok: false, error: String(e.message || e) }),
    ).then(r => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(r));
    });
  } else if (focusPid) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(focus(Number(focusPid[1]))));
  } else if (killPid) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(killSession(Number(killPid[1]))));
  } else if (threadPid) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(threadOf(Number(threadPid[1]))));
  } else if (req.url.startsWith('/message?')) {
    const q = new URL(req.url, 'http://localhost').searchParams;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(messageOf(Number(q.get('pid')), Number(q.get('at')), q.get('to'))));
  } else if (req.url === '/patterns') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(habits(), null, 1));
  } else if (req.url === '/log') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(report(), null, 1));
  } else if (req.url === '/api') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ sessions: correlate(scan()), rollup, quota: quota(), budget: budget(), idleNotifMs: idleNotifMs(), defaultModel: defaultModel(), now: Date.now() }));
  } else {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    fs.createReadStream(path.join(__dirname, 'claude-sessions.html')).pipe(res);
  }
});
// port may already be taken - walk up until one is free
server.on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  server.listen(server.__port = (server.__port || PORT) + 1, HOST);
});
if (!String(process.argv[2] || '').startsWith('--'))    // --report / --selftest must not bind a port
  server.listen(PORT, HOST, () => console.log(`http://localhost:${server.address().port}`));
