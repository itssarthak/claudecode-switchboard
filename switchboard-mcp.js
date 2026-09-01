#!/usr/bin/env node
// MCP server: lets an agent run /compact on its own session.
//
// /compact is typed into the TUI, and an agent is mid-turn inside that TUI, so it can never type
// it itself. This server can: Claude Code spawns it as a child of the session process, so its own
// parent IS the session. Nothing has to be passed in - no pid, no session id, no config.
//
// It is deliberately thin. Resolving the caller and validating the command already happen in
// switchboard's /self endpoint, and duplicating either here would mean two things to keep in step.
//
// Only `compact` is exposed. The other allowlisted commands (context, cost, status) print into the
// terminal, where the agent that asked for them cannot read the output - useful from the dashboard,
// pointless from here.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');

const PORTS = Array.from({ length: 10 }, (_, i) => 7823 + i);
const PORTFILE = path.join(os.homedir(), '.switchboard', 'port');
let VERSION = '0';
try { VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version } catch {}

// the server writes its port on listen, but it walks upward if 7823 is taken and older copies
// never wrote the file at all, so fall back to trying the range
async function findPort() {
  if (process.env.SWITCHBOARD_PORT) return Number(process.env.SWITCHBOARD_PORT);
  const first = [];
  try { first.push(Number(fs.readFileSync(PORTFILE, 'utf8').trim())) } catch {}
  for (const p of [...first, ...PORTS]) {
    if (!p) continue;
    try {
      const r = await fetch(`http://127.0.0.1:${p}/self?pid=${process.pid}`,
        { signal: AbortSignal.timeout(1500) });
      if (r.ok) return p;
    } catch {}
  }
  return null;
}

async function compactSelf() {
  const port = await findPort();
  if (!port) return { ok: false, error: 'switchboard is not running - start it with /switchboard' };
  try {
    const r = await fetch(`http://127.0.0.1:${port}/self?pid=${process.pid}&cmd=compact`,
      { method: 'POST', signal: AbortSignal.timeout(8000) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e.message || e) } }
}

const TOOLS = [{
  name: 'compact_self',
  description:
    'Compact your own Claude Code session, freeing context. Use when your context is nearly full '
    + 'and you want to keep working. The command is queued into your session, so it runs once your '
    + 'current turn finishes, not immediately. Takes no arguments - the session is worked out from '
    + 'the process tree. Requires the switchboard dashboard to be running, and a real terminal '
    + '(sessions hosted inside an editor cannot be typed into).',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}];

const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return;                        // a notification: initialized, cancelled...
  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'switchboard', version: VERSION },
      });
    case 'ping': return ok(id, {});
    case 'tools/list': return ok(id, { tools: TOOLS });
    case 'tools/call': {
      if (params?.name !== 'compact_self') return fail(id, -32602, `unknown tool: ${params?.name}`);
      const r = await compactSelf();
      return ok(id, {
        content: [{ type: 'text', text: r.ok
          ? `Queued /compact for "${r.session}" (pid ${r.pid}). It runs when this turn ends.`
          : `Could not compact: ${r.error}` }],
        isError: !r.ok,
      });
    }
    default: return fail(id, -32601, `unknown method: ${method}`);
  }
}

let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk;
  for (let nl; (nl = buf.indexOf('\n')) !== -1;) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line) } catch { continue }   // never die on a bad frame
    Promise.resolve(handle(msg)).catch(e => {
      if (msg?.id !== undefined) fail(msg.id, -32603, String(e.message || e));
    });
  }
});
process.stdin.on('end', () => process.exit(0));
