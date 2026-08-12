#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const PKG_VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')
).version;

const API_BASE = (process.env.REMOTIFY_URL  || 'https://remotify.run').replace(/\/$/, '');
const PRESET   =  process.env.REMOTIFY_KEY  || null;
const CHUNK_MS      = parseInt(process.env.REMOTIFY_CHUNK_MS      || '5000',   10); // per-call blocking budget before returning [pending]
const MAX_CHUNKS    = parseInt(process.env.REMOTIFY_MAX_CHUNKS    || '24',     10); // ceiling on UNPRODUCTIVE waits (in-flight time is refunded), not total time
const POLL_MS       = parseInt(process.env.REMOTIFY_POLL_MS       || '500',    10);
// Per-fetch network timeouts. Without them a stalled TCP connection freezes a
// whole tool call indefinitely (the exact "stuck on a tool call" symptom). The
// result poll must exceed the relay's own long-poll window (LONGPOLL_MS,
// default 15s) plus slack; quick calls (status/push/session) return at once.
const RESULT_TIMEOUT_MS = parseInt(process.env.REMOTIFY_RESULT_TIMEOUT_MS || '30000', 10);
const QUICK_TIMEOUT_MS  = parseInt(process.env.REMOTIFY_QUICK_TIMEOUT_MS  || '10000', 10);
// Absolute ceiling on time a command may sit "in flight" on the remote before
// the MCP stops waiting. The runner's interrupt handler covers Ctrl+C, but a
// hard kill (kill -9 / crash / reboot) leaves the relay's phase marker stuck;
// without this the tool would loop [in-flight] forever. 0 disables. Default
// 30 min comfortably covers mongodump / restic / rsync / big installs.
const MAX_INFLIGHT_MS   = parseInt(process.env.REMOTIFY_MAX_INFLIGHT_MS   || '1800000', 10);
// A listener heartbeat NEWER than the in-flight start proves the in-flight
// command's executor is gone: an executing (or supervised-prompt-waiting)
// listener never polls /cmd, so any poll after pickup means the executor died
// and no result is coming. Genuine runs keep heartbeat_age >= inflight_age, so
// the difference never goes positive; the grace only absorbs mtime jitter.
// Lets a wedge clear in seconds instead of waiting out MAX_INFLIGHT_MS.
const STALE_GRACE_S     = parseInt(process.env.REMOTIFY_STALE_GRACE_S     || '30', 10);

let session = null;
// Resumable state for a single in-flight command. Shared across chained tool
// calls so the LLM can loop remote_exec with the same args and the server
// transparently continues where the previous chunk left off, without
// re-queueing the command on the relay.
let inFlight = null; // { command, key, phase: 'pickup' | 'result', chunks }
// Set when a session was just renewed (preset 410 on cold start, or in-flight
// 410 mid-session). Surfaced into the next pendingMessage so the LLM cannot
// miss the key change — stderr-only logging proved invisible in Claude Code.
let renewNotice = null; // { oldKey, newKey } | null
// One-shot notice prepended to the next remote_exec response after an
// automatic unwedge (stale in-flight cleared), so the LLM always learns that
// recovery happened and that the dead command's output is lost.
let recoveryNotice = null; // string | null

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// fetch with an AbortSignal timeout so a stalled connection can never hang a
// tool call forever. AbortSignal.timeout is available on Node 18+.
function fetchT(url, timeoutMs, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function fetchJSON(url, init) {
  const r = await fetchT(url, QUICK_TIMEOUT_MS, init);
  if (!r.ok) {
    const err = new Error(`${init?.method || 'GET'} ${url} -> HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// Mint a brand-new session on the relay. Used on cold start (no PRESET) and
// as a recovery path when a preset or cached key has expired server-side.
async function mintSession() {
  const s = await fetchJSON(`${API_BASE}/api/session`, { method: 'POST' });
  process.stderr.write(
    `\nremotify: new session ${s.key}\n` +
    `  on remote: ${s.remote_quickstart}\n\n`
  );
  return s;
}

async function ensureSession() {
  if (session) return session;
  let oldKey = null;
  if (PRESET) {
    try {
      session = await fetchJSON(`${API_BASE}/api/session/${PRESET}`);
      return session;
    } catch (e) {
      // Pinned key is gone server-side (expired TTL, purged, or never
      // existed). Fall back to minting a fresh session so the agent can
      // keep working — the old listener is dead either way.
      if (e.status !== 410 && e.status !== 404) throw e;
      oldKey = PRESET;
      process.stderr.write(
        `\nremotify: REMOTIFY_KEY=${PRESET} is not active on the relay; minting a new session\n\n`
      );
    }
  }
  session = await mintSession();
  // Either preset just 410'd, or remoteExec nulled the cache after an
  // in-flight 410 (renewNotice was pre-staged with newKey=null). Stamp the
  // new key so the next pendingMessage can surface the change to the LLM.
  if (oldKey)                                renewNotice = { oldKey, newKey: session.key };
  else if (renewNotice && !renewNotice.newKey) renewNotice.newKey = session.key;
  return session;
}

// Fetches the relay's per-session status, returning a discriminated result:
//   'gone'   -> session 410'd; trigger renewal.
//   'legacy' -> 404: an OLD relay without the status endpoint. Only THIS means
//               "assume no status probe" — a transient failure must not.
//   'error'  -> transient failure / timeout: caller should retry, NOT treat as
//               legacy (mis-treating a 502 as legacy silently disables the
//               busy-guard and can cause a stale queued command to run later).
//   object   -> the parsed status.
//
// Older relays only return cmd_queued / result_queued. Newer ones (PHP commit
// 19c9f5a onward) also expose cmd_in_flight and listener_seen_seconds_ago.
async function fetchStatus(key) {
  try {
    const r = await fetchT(`${API_BASE}/api/session/${key}/status`, QUICK_TIMEOUT_MS);
    if (r.status === 410) return 'gone';
    if (r.status === 404) return 'legacy';
    if (!r.ok) return 'error';
    return await r.json();
  } catch { return 'error'; }
}

// True when fetchStatus returned an actual status object (not a symbolic string).
const isStatus = (s) => s !== null && typeof s === 'object';

// mayHaveRun marks that the command had already been delivered to the remote
// (so re-pushing it after renewal risks a second execution).
function sessionGone(mayHaveRun = false) {
  const err = new Error('session expired on relay');
  err.sessionGone = true;
  err.mayHaveRun = mayHaveRun;
  return err;
}

async function dropQueuedCmd(cmdUrl) {
  try { await fetchT(cmdUrl, QUICK_TIMEOUT_MS, { method: 'DELETE' }); } catch { /* best-effort */ }
}

// Clear a wedged session's transient state on the relay (queued cmd/result +
// in-flight marker) while keeping the key and any connected listener alive.
// Primary path is the relay's POST /api/session/{key}/reset endpoint; a legacy
// relay without it (404) gets the manual equivalent: drop the hot cmd, then
// push and immediately drain a marker result (a result push flips the phase
// back to idle server-side). Returns true when the state is known to be clear.
async function resetRelayState(s) {
  try {
    const r = await fetchT(`${s.urls.api}/reset`, QUICK_TIMEOUT_MS, { method: 'POST' });
    if (r.ok) return true;
    if (r.status === 410) throw sessionGone(false);
    if (r.status !== 404) return false; // transient relay trouble; retry later
  } catch (e) {
    if (e.sessionGone) throw e;
    return false;
  }
  // Legacy relay without the reset endpoint.
  try {
    await fetchT(s.urls.cmd, QUICK_TIMEOUT_MS, { method: 'DELETE' });
    await fetchT(s.urls.result, QUICK_TIMEOUT_MS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: '[remotify: stale in-flight state cleared by the mcp client]',
    });
    await fetchT(`${s.urls.result}?nowait=1`, QUICK_TIMEOUT_MS); // drain the marker
    return true;
  } catch { return false; }
}

function consumeRenewNotice(s) {
  if (!renewNotice || renewNotice.newKey !== s.key) return '';
  const { oldKey, newKey } = renewNotice;
  renewNotice = null;
  return `[session-renewed] Previous session ${oldKey} expired on the relay; minted new session ${newKey}. ` +
         `Any listener that was running on ${oldKey} is now disconnected (it will exit on its next poll with "session expired or unknown key"). ` +
         `The runner one-liners below are for the new key — relay them to the user verbatim so they can reconnect.\n\n`;
}

// `listenerSeenAgo` (when known) splits "no listener at all" from
// "listener alive, just hasn't picked up yet". A fresh heartbeat (< 30s)
// means the runner is online and longpoll will deliver any moment, so we
// silently nudge the LLM to retry instead of telling the user to paste the
// one-liner — that message is what made agents abandon long-running setups.
function pendingMessage(s, firstTime, listenerSeenAgo) {
  const listenerAlive = typeof listenerSeenAgo === 'number' && listenerSeenAgo < 30;
  const supervised = `curl -fsSL '${s.urls.runner}' | bash`;
  const auto       = `curl -fsSL '${s.urls.runner}?mode=auto' | bash`;
  let header;
  if (listenerAlive) {
    header =
      `[pending] Remote listener is online (last seen ${listenerSeenAgo}s ago) but has not picked up the command yet. ` +
      `Call remote_exec again with the EXACT SAME arguments.`;
  } else if (firstTime) {
    header =
      `[pending] Remote listener not connected yet. Tell the user — as a concise chat message — to paste ONE of these on the remote shell to connect it:\n\n` +
      `  supervised (asks y/N for each command): ${supervised}\n` +
      `  auto (runs every command immediately):  ${auto}\n\n` +
      `After you have told the user, immediately call remote_exec again with the EXACT SAME arguments.`;
  } else {
    header = `[pending] Still no listener. Call remote_exec again with the EXACT SAME arguments.`;
  }
  return consumeRenewNotice(s) + header +
    ` Do NOT ask the user to confirm; do NOT narrate progress between retries; do NOT try a different command. ` +
    `The server is holding the queued command and will resume polling on the next call. ` +
    `Stop looping and surface a failure to the user only after about 10 consecutive [pending] responses.`;
}

async function remoteExec(command) {
  // One transparent retry if the relay tells us the session is gone. This is
  // what lets the MCP survive a TTL expiry mid-session: we null out the stale
  // cache, ensureSession mints a fresh key, and the command gets re-pushed --
  // BUT only when the command provably never left the queue. If it may have
  // already run on the remote (mayHaveRun), re-pushing could execute a
  // destructive command twice, so we surface the unknown fate instead.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await remoteExecOnce(command);
      // Surface a one-shot auto-recovery notice on whatever this call returns
      // ([pending], [in-flight], or a final result) so it cannot get lost.
      if (recoveryNotice) { r.text = recoveryNotice + r.text; recoveryNotice = null; }
      return r;
    } catch (e) {
      if (e.sessionGone && attempt === 0) {
        // Stage the notice with the dying key now; ensureSession will fill
        // newKey after the mint. Falls back to PRESET if session was nulled
        // before we cached anything (cold start with stale preset).
        renewNotice = { oldKey: session?.key ?? PRESET ?? '(unknown)', newKey: null };
        session = null;
        inFlight = null;
        if (e.mayHaveRun) {
          // The command had already been delivered to the remote when the
          // session expired; re-pushing could run a destructive command twice.
          const s = await ensureSession();
          return { pending: false, text:
            consumeRenewNotice(s) +
            `[unknown-result] The session expired while "${command}" was already running on the ` +
            `remote, so its output was lost and it may or may not have finished. A new session ` +
            `was minted — relay the reconnect one-liner above to the user. Decide whether ` +
            `re-running the command is safe BEFORE issuing it again; the server will not ` +
            `silently re-run it for you.` };
        }
        continue; // command never left the queue -> safe to re-push on the new key
      }
      throw e;
    }
  }
}

async function remoteExecOnce(command) {
  const s = await ensureSession();

  const isNewCmd = !inFlight || inFlight.command !== command || inFlight.key !== s.key;
  if (isNewCmd) {
    const preStatus = await fetchStatus(s.key);
    if (preStatus === 'gone') { inFlight = null; throw sessionGone(false); }

    // Busy-guard: a prior command is still executing on the remote. Pushing now
    // would overwrite the queue and misattribute its result to this call. Older
    // relays (no cmd_in_flight field) skip this guard, matching prior behavior.
    let justRecovered = false;
    if (isStatus(preStatus) && preStatus.cmd_in_flight) {
      const elapsed = preStatus.cmd_in_flight_seconds_ago ?? 0;
      const seenAgo = preStatus.listener_seen_seconds_ago;
      // Auto-recovery from a wedged in-flight marker (typically left by a DEAD
      // prior session — the exact state that used to require a manual unwedge).
      // Provably stale: a listener polled for NEW work after the command was
      // handed out (heartbeat newer than the in-flight start), so its executor
      // is gone and no result is coming; newer relays self-heal this on the
      // poll itself, the MCP-side check covers older relays. Presumably stale:
      // in flight past the absolute ceiling (listener died, never reconnected).
      const provablyStale = typeof seenAgo === 'number' && (elapsed - seenAgo) > STALE_GRACE_S;
      const pastCap = MAX_INFLIGHT_MS > 0 && elapsed * 1000 >= MAX_INFLIGHT_MS;
      if ((provablyStale || pastCap) && await resetRelayState(s)) {
        recoveryNotice =
          `[recovered] A stale command (likely from a previous session) was stuck in-flight on the relay for ${elapsed}s ` +
          (provablyStale
            ? `even though the listener was already polling for new work`
            : `— past the ${Math.round(MAX_INFLIGHT_MS / 60000)} min in-flight ceiling`) +
          `. Its state was cleared automatically; its output is lost. Proceeding with your command.\n\n`;
        justRecovered = true; // state is clean now; fall through to the push
      } else if (provablyStale || pastCap) {
        return { pending: true, text:
          `[busy] A stale in-flight command is wedging the session and the automatic clear did not go ` +
          `through (relay unreachable?). Call remote_exec again with the EXACT SAME arguments to retry the recovery.` };
      } else {
        return { pending: true, text:
          `[busy] A previous command is still executing on the remote (${elapsed}s elapsed). ` +
          `Do NOT issue a different command — its result would be misattributed to the new one. ` +
          `If you know the previous command, call remote_exec with ITS exact arguments first to drain its result, then issue this one. ` +
          `If you do not know it (e.g. it was issued by an earlier session), keep calling remote_exec with THIS command's arguments: ` +
          `the stale state clears automatically as soon as the listener reconnects` +
          (MAX_INFLIGHT_MS > 0 ? ` or after the ${Math.round(MAX_INFLIGHT_MS / 60000)} min in-flight ceiling` : '') + `.` };
      }
    }

    // Recovery: a result is already queued and we hold NO in-flight context
    // (cold start, or the MCP restarted while a command ran). Adopt it and
    // RETURN it below instead of discarding it and re-pushing -- re-pushing
    // would execute a possibly-destructive command a second time and lose this
    // output. Only when there is no prior inFlight; a deliberate command switch
    // (different inFlight) falls through to push, and the relay drops the stale
    // result on that push. Skipped right after an auto-recovery: preStatus
    // predates the reset, so a result_queued it reports was just dropped.
    if (!justRecovered && !inFlight && isStatus(preStatus) && preStatus.result_queued) {
      inFlight = { command, key: s.key, phase: 'result', chunks: 0, resumed: true };
    } else {
      if (inFlight) await dropQueuedCmd(s.urls.cmd);
      let push;
      try {
        push = await fetchT(s.urls.cmd, QUICK_TIMEOUT_MS, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: command,
        });
      } catch {
        // Network/timeout on the push: the command was almost certainly not
        // queued. A same-args retry is safe -- the busy-guard above catches the
        // rare case where it actually did queue and get picked up.
        inFlight = null;
        return { pending: true, text:
          `[pending] Could not reach the relay to queue the command (network/timeout). ` +
          `Call remote_exec again with the EXACT SAME arguments to retry.` };
      }
      if (push.status === 410) { inFlight = null; throw sessionGone(false); }
      if (!push.ok)            { inFlight = null; throw new Error(`push failed: HTTP ${push.status}`); }
      inFlight = { command, key: s.key, phase: 'pickup', chunks: 0 };
    }
  }
  inFlight.chunks += 1;

  const deadline = Date.now() + CHUNK_MS;

  // Phase 1: wait for the listener to accept the queued command.
  if (inFlight.phase === 'pickup') {
    let lastStatus = null;
    while (Date.now() < deadline) {
      lastStatus = await fetchStatus(s.key);
      if (lastStatus === 'gone')   { inFlight = null; throw sessionGone(false); }
      if (lastStatus === 'legacy') { inFlight.phase = 'result'; break; }  // old relay w/o status probe
      if (lastStatus === 'error')  { await sleep(POLL_MS); continue; }     // transient: retry, do NOT flip phase
      if (!lastStatus.cmd_queued)  { inFlight.phase = 'result'; break; }
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
      const seenAgo = isStatus(lastStatus) && typeof lastStatus.listener_seen_seconds_ago === 'number'
        ? lastStatus.listener_seen_seconds_ago
        : null;
      return { pending: true, text: pendingMessage(s, firstTime, seenAgo) };
    }
  }

  // Phase 2: wait for the result.
  const resumedLabel = inFlight.resumed
    ? `[resumed] This output was already waiting on the relay when the command was (re-)issued; ` +
      `it belongs to the most recent run (likely the one you just re-issued after an interruption). ` +
      `If it is not what you expected for this command, issue the command again.\n\n`
    : '';
  while (Date.now() < deadline) {
    let res;
    try { res = await fetchT(s.urls.result, RESULT_TIMEOUT_MS); }
    catch { return inflightOrPending(s); }   // timeout/stall: treat as retryable, don't drop state
    if (res.status === 200) {
      const body = await res.text();
      // An ADOPTED "waiting result" that turns out to be a recovery marker
      // ('[remotify: ...', queued by the relay's self-heal or by a runner's
      // interrupt trap) belongs to a dead prior session, not to this command.
      // Absorb it and ask for a same-args retry instead of surfacing it as
      // this command's [resumed] output.
      if (inFlight.resumed && /^\[remotify: /.test(body)) {
        inFlight = null;
        return { pending: true, text:
          `[recovered] The relay was holding a stale recovery marker from a previous session (now absorbed): ` +
          `${body.trim()} — call remote_exec again with the EXACT SAME arguments to run your command.` };
      }
      inFlight = null;
      return { pending: false, text: consumeRenewNotice(s) + resumedLabel + body };
    }
    if (res.status === 204) { await sleep(POLL_MS); continue; }
    if (res.status === 410) { inFlight = null; throw sessionGone(true); } // cmd was consumed before expiry
    inFlight = null;
    throw new Error(`fetch result: HTTP ${res.status}`);
  }
  return inflightOrPending(s);
}

// Chunk budget exhausted (or a result fetch stalled). MAX_CHUNKS bounds only
// *unproductive* waits, not legitimate in-flight time: ask the relay whether the
// command is still executing and, if so, refund this chunk -- unless it has been
// in flight past the absolute ceiling, which means the listener likely died.
async function inflightOrPending(s) {
  const status = await fetchStatus(s.key);
  if (status === 'gone') { inFlight = null; throw sessionGone(true); }
  if (isStatus(status) && status.cmd_in_flight) {
    const secs = typeof status.cmd_in_flight_seconds_ago === 'number' ? status.cmd_in_flight_seconds_ago : 0;
    if (MAX_INFLIGHT_MS > 0 && secs * 1000 >= MAX_INFLIGHT_MS) {
      inFlight = null;
      // Clear the wedged relay state NOW so the next command starts clean
      // instead of tripping the busy-guard on this dead command's marker.
      let cleared = false;
      try { cleared = await resetRelayState(s); } catch { /* session gone; next call renews */ }
      throw new Error(
        `Command has been in flight on the remote for ~${Math.round(secs / 60)} min with no result. ` +
        `The listener likely died mid-command (crash / kill -9 / reboot) — its phase never cleared. ` +
        (cleared ? `The wedged relay state was cleared automatically so new commands can run. ` : '') +
        `Re-check the remote state and re-issue only if it is safe to run again.`
      );
    }
    if (inFlight) inFlight.chunks = Math.max(0, inFlight.chunks - 1);
    const elapsed = typeof status.cmd_in_flight_seconds_ago === 'number'
      ? status.cmd_in_flight_seconds_ago
      : Math.round((inFlight ? inFlight.chunks : 0) * CHUNK_MS / 1000);
    return { pending: true, text:
      `[in-flight] Remote listener is actively executing the command (${elapsed}s elapsed). ` +
      `Call remote_exec again with the EXACT SAME arguments. ` +
      `Long operations like mongodump, restic, rsync, large package installs, or ` +
      `slow service restarts routinely take many minutes; do NOT give up just ` +
      `because there is no result yet, and do NOT ask the user to confirm. ` +
      `The relay will return the output the moment the command finishes.` };
  }
  if (inFlight && inFlight.chunks >= MAX_CHUNKS) {
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

// remote_session_reset tool. In place (rotate=false): clear wedged relay state
// while keeping the key and any connected listener. Rotate: purge the session
// server-side and mint a fresh key (the old listener exits on its next poll
// with 410, so the user must re-paste the new one-liner on the remote).
async function sessionReset(rotate) {
  if (!rotate) {
    const s = await ensureSession();
    inFlight = null;
    let ok = false;
    try { ok = await resetRelayState(s); }
    catch (e) {
      if (!e.sessionGone) throw e;
      // The key is already dead server-side; nothing left to clear. Renew so
      // the caller walks away with a working session instead of an error.
      session = null;
      renewNotice = { oldKey: s.key, newKey: null };
      const ns = await ensureSession();
      return consumeRenewNotice(ns) + rotateSummary(ns);
    }
    return ok
      ? `Session ${s.key} reset: any queued command/result was dropped and the in-flight marker cleared. ` +
        `The key and a connected listener keep working — issue remote_exec normally now.`
      : `Reset attempted but the relay did not confirm it; state may be unchanged. ` +
        `Retry, or call remote_session_reset with {"rotate": true} for a fresh session.`;
  }
  const oldKey = session?.key ?? PRESET;
  if (oldKey) {
    try { await fetchT(`${API_BASE}/api/session/${oldKey}`, QUICK_TIMEOUT_MS, { method: 'DELETE' }); }
    catch { /* best-effort; the TTL reaps it eventually */ }
  }
  session = null;
  inFlight = null;
  renewNotice = { oldKey: oldKey ?? '(none)', newKey: null };
  const s = await ensureSession();
  return consumeRenewNotice(s) + rotateSummary(s);
}

function rotateSummary(s) {
  return `New session ${s.key} minted. Relay ONE of these to the user so they can connect the remote listener:\n\n` +
    `  supervised (y/N per command): curl -fsSL '${s.urls.runner}' | bash\n` +
    `  auto (runs immediately):      curl -fsSL '${s.urls.runner}?mode=auto' | bash\n` +
    (PRESET ? `\nNote: REMOTIFY_KEY still points at a now-dead key, so an MCP restart will mint ANOTHER ` +
              `new session; tell the user to update or unset it when convenient.\n` : '');
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
        "\n\nPending handling: the response text may start with one of two markers." +
        "\n  '[pending]' = remote listener has not connected yet, OR listener is up but the relay cannot confirm pickup. In that case:" +
        "\n    1. On the FIRST [pending], relay the paste one-liners from the response to the user as a short chat message so they can start the remote listener." +
        "\n    2. Call remote_exec again with the EXACT SAME arguments. The server resumes where it left off; the command will not execute twice." +
        "\n    3. Loop silently — don't ask the user between retries, don't narrate 'still waiting'." +
        "\n    4. Give up only after about 10 consecutive [pending] responses." +
        "\n  '[in-flight]' = the command IS already being executed on the remote (cmd was picked up, no output yet). In that case:" +
        "\n    1. Do NOT give up. Long operations (mongodump, restic, rsync, big installs, slow restarts) routinely take many minutes." +
        "\n    2. Call remote_exec again with the EXACT SAME arguments — the relay will return the output the moment the command finishes." +
        "\n    3. Do NOT tell the user the listener disconnected; do NOT ask them to re-paste the listener; do NOT switch to a different command." +
        "\n    4. There is no LLM-side retry cap on '[in-flight]' — keep waiting until the result lands or the relay returns something else." +
        "\n  '[busy]' = you tried to issue a NEW command while a previous one is still executing on the remote. Each session is single-flight (one command at a time). In that case:" +
        "\n    1. If you know the previous command, call remote_exec with ITS exact arguments first to drain its result, then issue the new one." +
        "\n    2. If you do NOT know it (e.g. it was issued by an earlier session), keep calling remote_exec with the NEW command's arguments: stale state left by a dead session is cleared automatically (see '[recovered]')." +
        "\n  '[recovered]' = wedged state left by a dead session/listener was cleared automatically. Read the rest of the message: either the command already proceeded, or you are asked to call remote_exec again with the EXACT SAME arguments." +
        "\n  '[resumed]' = the returned output was already waiting on the relay and belongs to the most recent run (e.g. you re-issued a command after an interruption). Use it if it matches what you expected; if not, issue the command again." +
        "\n  '[unknown-result]' = the session expired while the command was already running on the remote. Its output was lost and it may or may not have completed. A new session was minted; relay the reconnect one-liner to the user, then decide whether re-running is safe — the server will NOT silently re-run it.",
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
    {
      name: 'remote_session_reset',
      description:
        'Recover a wedged remotify session. Default (no arguments): clear stuck relay state in place — drops any queued command/result and the in-flight marker; the session key and a connected listener keep working. ' +
        'With {"rotate": true}: abandon the current session and mint a brand-new key — the old key dies, the remote listener disconnects, and the user must paste the NEW runner one-liner (returned by this tool) on the remote. ' +
        'Normally NOT needed: remote_exec auto-recovers from stale state by itself. Use it only when remote_exec stays wedged (repeated [busy] for a command you never issued) despite same-args retries, or when the user explicitly asks to reset or rotate the session.',
      inputSchema: {
        type: 'object',
        properties: {
          rotate: { type: 'boolean', description: 'Mint a brand-new session key instead of clearing the current one in place (requires the user to reconnect the remote listener)' },
        },
      },
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
    if (params.name === 'remote_session_reset') {
      const text = await sessionReset(params.arguments?.rotate === true);
      return { content: [{ type: 'text', text }] };
    }
    throw new Error(`Unknown tool: ${params.name}`);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] };
  }
});

// Test seam: expose the state machine and let a test reset module-level state
// between cases. Only connect the stdio transport when run as the real server,
// so importing this file for tests does not block on a transport.
export const __test = {
  remoteExec,
  ensureSession,
  sessionReset,
  reset() { session = null; inFlight = null; renewNotice = null; recoveryNotice = null; },
  getInFlight: () => inFlight,
};

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await server.connect(new StdioServerTransport());
}
