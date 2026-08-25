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
  model: null, effort: null, branch: null, lastAt: 0,
  summary: null, lastUser: null, lastAssistant: null, lastTool: null, lastToolAt: 0,
  inbox: [],
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
  const { off, buf, ids, recent, ...out } = st;
  return { ...out, total: Object.values(st.tok).reduce((a, b) => a + b, 0) - st.tok.thinking, burn };
}

// injected pseudo-user turns: tool results, <system-reminder>, observer/cross-session relays
const NOISE = /^(<|\[MESSAGE FROM NON-USER|Another Claude session sent|Caveat: The messages below|This session is being continued|Continue from where you left off)/;
// receiver side of a session->session message: the socket path carries the sender's pid
const XSESS = /<cross-session-message from="uds:[^"]*?\/(\d+)\.sock"(?:[^>]*?from-name="([^"]*)")?/;
const text = m => (typeof m?.content === 'string' ? m.content
  : (m?.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ')).trim();

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
  }
  if (!e.isSidechain) {
    const t = text(e.message);
    // tool results and <system-reminder>/<local-command-stdout> arrive as type:'user' too - skip them
    const x = t && XSESS.exec(t);
    if (x) { st.inbox.push({ at: ts, from: Number(x[1]), name: x[2] || null }); st.inbox.splice(0, st.inbox.length - 20) }
    if (t && e.type === 'user' && !NOISE.test(t)) st.lastUser = t.slice(0, 300);
    if (t && e.type === 'assistant') st.lastAssistant = t.slice(0, 300);
  }
  // a real user turn: a user message that is prose, not a tool result being fed back
  if (e.type === 'user' && !e.isSidechain &&
      (typeof c === 'string' || (Array.isArray(c) && c.some(p => p.type === 'text')))) st.turns++;

  const u = e.message?.usage;
  if (!u || st.ids.has(e.message.id)) return;                        // <-- the dedup
  st.ids.add(e.message.id);
  st.msgs++;
  if (e.message.model) st.model = e.message.model;
  st.tok.input += u.input_tokens || 0;
  st.tok.output += u.output_tokens || 0;
  st.tok.cacheWrite += u.cache_creation_input_tokens || 0;
  st.tok.cacheRead += u.cache_read_input_tokens || 0;
  st.tok.thinking += u.output_tokens_details?.thinking_tokens || 0;  // subset of output
  // context currently in play = what the last request actually carried
  st.ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  st.recent.push({ ts, out: u.output_tokens || 0 });
  const day = new Date(ts || Date.now()).toISOString().slice(0, 10);
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
  const days = {}, next = { days, files: files.length, sessions: 0, scanning: true, done: 0, at: Date.now() };
  rollup = { ...rollup, files: files.length, scanning: true, done: 0 };
  let i = 0;
  (function step() {
    for (let n = 0; n < 3 && i < files.length; n++, i++) {
      try {
        const st = usage(files[i]);
        if (st.msgs) next.sessions++;
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

const scan = () => !fs.existsSync(SESSIONS) ? [] : fs.readdirSync(SESSIONS).filter(f => f.endsWith('.json')).map(f => {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8'));
    const t = transcriptOf(s.sessionId);
    return { ...s, alive: alive(s.pid), usage: t ? usage(t) : null };
  } catch { return null }
}).filter(Boolean).sort((a, b) => (b.alive - a.alive) || (b.startedAt - a.startedAt));

// --- self-check: incremental parse must equal a one-shot parse, and repeat polls must not drift
if (process.argv[2] === '--selftest') {
  const assert = require('assert');
  const file = process.argv[3] || [...(() => { transcriptOf('_'); return index.values() })()]
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  const inc = usage(file), again = usage(file);            // second poll adds nothing
  assert.deepStrictEqual(inc.tok, again.tok, 'repeat poll double-counted');
  const oneShot = blank();
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) if (l) try { ingest(oneShot, JSON.parse(l)) } catch {}
  assert.deepStrictEqual(inc.tok, oneShot.tok, 'incremental != one-shot');
  assert.ok(inc.msgs < oneShot.ids.size + 1 && inc.msgs > 0);
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
  'Terminal': (tty, cmd) => `tell application "Terminal"
      repeat with wi from 1 to count of windows
        try
          repeat with ti from 1 to count of tabs of window wi
            if tty of tab ti of window wi is "${tty}" then
              do script "/${cmd}" in tab ti of window wi
              return "ok"
            end if
          end repeat
        end try
      end repeat
    end tell
    return "no-tab"`,
  'iTerm2': (tty, cmd) => `tell application "iTerm2"
      repeat with wi from 1 to count of windows
        try
          repeat with ti from 1 to count of tabs of window wi
            repeat with si from 1 to count of sessions of tab ti of window wi
              if tty of session si of tab ti of window wi is "${tty}" then
                tell session si of tab ti of window wi to write text "/${cmd}"
                return "ok"
              end if
            end repeat
          end repeat
        end try
      end repeat
    end tell
    return "no-tab"`,
};

function send(pid, cmd) {
  if (!ALLOWED.has(cmd)) return { ok: false, error: `'${cmd}' not allowed` };
  const live = scan().find(s => s.pid === pid);
  if (!live) return { ok: false, error: 'no such session' };
  if (!live.alive) return { ok: false, error: 'session is dead' };
  const tty = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)]).toString().trim();
  if (!/^ttys?\d+$/.test(tty)) return { ok: false, error: `odd tty: ${tty}` };
  const app = hostApp(pid);
  if (!TYPE[app]) return { ok: false, app, error: `${app || 'this terminal'} can't be typed into - editor terminals aren't scriptable` };
  try {
    const r = execFileSync('osascript', ['-e', TYPE[app](`/dev/${tty}`, cmd)], { timeout: 5000 }).toString().trim();
    return r === 'ok'
      ? { ok: true, app, tty, queued: live.status === 'busy' }   // busy sessions queue the input
      : { ok: false, app, tty, error: 'tab not found' };
  } catch (e) { return { ok: false, app, tty, error: String(e.stderr || e.message).slice(0, 200) } }
}


// --- plan quota (live) --------------------------------------------------------------
// same endpoint /usage hits. token stays in this process - never logged, never served.
let quotaAt = 0, quotaData = { error: 'not fetched yet' };
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
  if (!t) return quotaData = { error: 'no oauth token in keychain (api-key auth?)' };
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${t}`, 'anthropic-beta': 'oauth-2025-04-20' },
    });
    if (r.status === 401) return quotaData = { error: 'token expired - run any claude command to refresh' };
    if (!r.ok) return quotaData = { error: `HTTP ${r.status}` };
    return quotaData = { at: Date.now(), ...(await r.json()) };
  } catch (e) { return quotaData = { error: String(e.message || e) } }
}
const quota = () => (Date.now() - quotaAt > 60e3 && fetchQuota(), quotaData);   // refresh in background, serve last

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
const server = http.createServer((req, res) => {
  const sendCmd = req.url.match(/^\/send\?pid=(\d+)&cmd=(\w+)$/);
  const focusPid = req.url.match(/^\/focus\?pid=(\d+)$/);
  const killPid = req.url.match(/^\/kill\?pid=(\d+)$/);
  if ((sendCmd || focusPid || killPid) && !(sameOrigin(req) && req.method === 'POST')) {
    res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: false, error: 'cross-origin or non-POST request refused' }));
  }
  if (sendCmd) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(send(Number(sendCmd[1]), sendCmd[2])));
  } else if (focusPid) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(focus(Number(focusPid[1]))));
  } else if (killPid) {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(killSession(Number(killPid[1]))));
  } else if (req.url === '/api') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ sessions: scan(), rollup, quota: quota(), now: Date.now() }));
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
server.listen(PORT, HOST, () => console.log(`http://localhost:${server.address().port}`));
