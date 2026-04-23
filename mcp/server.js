#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PKG_VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')
).version;

const API_BASE = (process.env.REMOTIFY_URL  || 'https://remotify.run').replace(/\/$/, '');
const PRESET   =  process.env.REMOTIFY_KEY  || null;
const CHUNK_MS      = parseInt(process.env.REMOTIFY_CHUNK_MS      || '5000',   10); // per-call blocking budget before returning [pending]
const MAX_CHUNKS    = parseInt(process.env.REMOTIFY_MAX_CHUNKS    || '24',     10); // hard ceiling so a runaway doesn't loop forever (~2 min at 5s chunks)
const POLL_MS       = parseInt(process.env.REMOTIFY_POLL_MS       || '500',    10);

let session = null;
// Resumable state for a single in-flight command. Shared across chained tool
// calls so the LLM can loop remote_exec with the same args and the server
// transparently continues where the previous chunk left off, without
// re-queueing the command on the relay.
let inFlight = null; // { command, key, phase: 'pickup' | 'result', chunks }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${init?.method || 'GET'} ${url} -> HTTP ${r.status}`);
  return r.json();
}

async function ensureSession() {
  if (session) return session;
  if (PRESET) {
    session = await fetchJSON(`${API_BASE}/api/session/${PRESET}`);
  } else {
    session = await fetchJSON(`${API_BASE}/api/session`, { method: 'POST' });
    process.stderr.write(
      `\nremotify: new session ${session.key}\n` +
      `  on remote: ${session.remote_quickstart}\n\n`
    );
  }
  return session;
}

async function cmdStillQueued(key) {
  try {
    const r = await fetch(`${API_BASE}/api/session/${key}/status`);
    if (!r.ok) return null;
    const j = await r.json();
    return !!j.cmd_queued;
  } catch { return null; }
}

async function dropQueuedCmd(cmdUrl) {
  try { await fetch(cmdUrl, { method: 'DELETE' }); } catch { /* best-effort */ }
}

function pendingMessage(s, firstTime) {
  const supervised = `curl -fsSL '${s.urls.runner}' | bash`;
  const auto       = `curl -fsSL '${s.urls.runner}?mode=auto' | bash`;
  const header = firstTime
    ? `[pending] Remote listener not connected yet. Tell the user — as a concise chat message — to paste ONE of these on the remote shell to connect it:\n\n` +
      `  supervised (asks y/N for each command): ${supervised}\n` +
      `  auto (runs every command immediately):  ${auto}\n\n` +
      `After you have told the user, immediately call remote_exec again with the EXACT SAME arguments.`
    : `[pending] Still no listener. Call remote_exec again with the EXACT SAME arguments.`;
  return header +
    ` Do NOT ask the user to confirm; do NOT narrate progress between retries; do NOT try a different command. ` +
    `The server is holding the queued command and will resume polling on the next call. ` +
    `Stop looping and surface a failure to the user only after about 10 consecutive [pending] responses.`;
}

async function remoteExec(command) {
  const s = await ensureSession();

  // Fresh call (first time OR different command OR session changed): drop any
  // orphan queued command from a prior in-flight, then push the new one.
  if (!inFlight || inFlight.command !== command || inFlight.key !== s.key) {
    if (inFlight) await dropQueuedCmd(s.urls.cmd);
    const push = await fetch(s.urls.cmd, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: command,
    });
    if (push.status === 410) { inFlight = null; throw new Error('session expired or unknown; delete REMOTIFY_KEY or run remote_session_info'); }
    if (!push.ok)            { inFlight = null; throw new Error(`push failed: HTTP ${push.status}`); }
    inFlight = { command, key: s.key, phase: 'pickup', chunks: 0 };
  }
  inFlight.chunks += 1;

  const deadline = Date.now() + CHUNK_MS;

  // Phase 1: wait for the listener to accept the queued command.
  if (inFlight.phase === 'pickup') {
    while (Date.now() < deadline) {
      const queued = await cmdStillQueued(s.key);
      if (queued === false) { inFlight.phase = 'result'; break; }
      if (queued === null)  { inFlight.phase = 'result'; break; } // older server without status probe
      await sleep(POLL_MS);
    }
    if (inFlight.phase === 'pickup') {
      const firstTime = inFlight.chunks === 1;
      if (inFlight.chunks >= MAX_CHUNKS) {
        await dropQueuedCmd(s.urls.cmd);
        const hung = inFlight;
        inFlight = null;
        throw new Error(
          `Gave up after ${hung.chunks} chunks (${Math.round(hung.chunks * CHUNK_MS / 1000)}s) with no listener. ` +
          `The queued command has been dropped. Tell the user the remote is not connected.`
        );
      }
      return { pending: true, text: pendingMessage(s, firstTime) };
    }
  }

  // Phase 2: wait for the result.
  while (Date.now() < deadline) {
    const res = await fetch(s.urls.result);
    if (res.status === 200) {
      inFlight = null;
      return { pending: false, text: await res.text() };
    }
    if (res.status === 204) { await sleep(POLL_MS); continue; }
    if (res.status === 410) { inFlight = null; throw new Error('session expired while waiting for result'); }
    inFlight = null;
    throw new Error(`fetch result: HTTP ${res.status}`);
  }
  if (inFlight.chunks >= MAX_CHUNKS) {
    const hung = inFlight;
    inFlight = null;
    throw new Error(
      `Command was picked up but produced no output within ${hung.chunks * CHUNK_MS / 1000}s. It may still be running on the remote.`
    );
  }
  return { pending: true, text:
    `[pending] Listener picked up the command but it is still running on the remote. ` +
    `Call remote_exec again with the EXACT SAME arguments; do NOT ask the user anything. ` +
    `Stop after about 10 consecutive [pending] responses.` };
}

const server = new Server({ name: 'remotify', version: PKG_VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'remote_exec',
      description:
        "Execute a shell command on the PROJECT'S REMOTE SERVER via the remotify relay (the deployed/production/staging box, NOT the developer's local machine). " +
        "Examples: 'check disk usage', 'restart the service', 'tail the app log', 'query the prod DB', 'is port 443 open in prod', 'what version is running in staging'. " +
        "Chain this tool freely for iterative work — log analysis with grep/awk/sed/head/tail, narrowing a search, cross-checking outputs, diagnosing slow services with ps/vmstat/netstat/iostat. Each call saves a manual copy-paste roundtrip; only surface the meaningful result or synthesis to the user. " +
        "In supervised mode the operator approves each command on the remote via y/N prompt, so no extra confirmation is needed from the assistant. " +
        "Returns combined stdout+stderr as plain text on success." +
        "\n\nPending handling: if the response text starts with '[pending]', the remote listener has not connected yet or the command is still running. In that case:" +
        "\n  1. On the FIRST [pending], relay the paste one-liners from the response to the user as a short chat message so they can start the remote listener." +
        "\n  2. Call remote_exec again with the EXACT SAME arguments. The server resumes where it left off; the command will not execute twice." +
        "\n  3. Loop silently — don't ask the user between retries, don't narrate 'still waiting'." +
        "\n  4. Give up only after about 10 consecutive [pending] responses.",
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute on the remote machine' },
        },
        required: ['command'],
      },
    },
    {
      name: 'remote_session_info',
      description: 'Return the current relay session: key, URLs, and the exact one-liner to paste on the remote machine to start the listener.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    if (params.name === 'remote_exec') {
      const r = await remoteExec(params.arguments?.command ?? '');
      return { content: [{ type: 'text', text: r.text || '(no output)' }] };
    }
    if (params.name === 'remote_session_info') {
      const s = await ensureSession();
      const info = { mcp_version: PKG_VERSION, ...s };
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    }
    throw new Error(`Unknown tool: ${params.name}`);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] };
  }
});

await server.connect(new StdioServerTransport());
