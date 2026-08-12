# remotify-mcp

MCP server that gives any MCP-compatible host a `remote_exec` tool backed by
a [remotify.run](https://remotify.run) relay.

Runs on **your** machine; zero cost to the relay server.

## Install

Most users don't install - the MCP hosts below all launch it via `npx`:

```bash
npx -y remotify-mcp@latest
```

Or clone this repo and run `npm install` in `mcp/` if you want to hack on it.

## Wire it into your MCP host

Most MCP hosts read a JSON config like this (consult your host's docs for the
exact file location):

```json
{
  "mcpServers": {
    "remotify": {
      "command": "npx",
      "args": ["-y", "remotify-mcp@latest"]
    }
  }
}
```

Out of the box this talks to the public relay at `https://remotify.run`.
Set `REMOTIFY_URL` in `env` only if you're pointing at a self-hosted instance.

### Environment

| Var | Default | Meaning |
|-----|---------|---------|
| `REMOTIFY_URL` | `https://remotify.run` | Relay to talk to. Override to point at your self-hosted instance. |
| `REMOTIFY_KEY` | _(unset)_ | Reuse an existing session key instead of creating a new one on startup. |
| `REMOTIFY_CHUNK_MS` | `5000` | Per-call blocking budget before the tool returns `[pending]` and asks the assistant to loop. |
| `REMOTIFY_MAX_CHUNKS` | `24` | Ceiling on consecutive **unproductive** `[pending]` returns before the tool gives up. Time a command spends genuinely in flight on the remote is refunded and does not count against this, so a long-running job isn't mistaken for a dead listener. |
| `REMOTIFY_POLL_MS` | `500` | Internal poll interval against the relay's `/api/session/<key>/status` probe. |
| `REMOTIFY_RESULT_TIMEOUT_MS` | `30000` | Per-fetch timeout on the `GET /result-{key}` long-poll. |
| `REMOTIFY_QUICK_TIMEOUT_MS` | `10000` | Timeout on the quick status/push/session HTTP calls. |
| `REMOTIFY_MAX_INFLIGHT_MS` | `1800000` | Absolute ceiling on how long a command may sit "in flight" before the tool stops waiting - guards against a listener that died mid-command. Also the ceiling past which a *stale* in-flight marker (left by a dead prior session) is cleared automatically so new commands can run. |
| `REMOTIFY_STALE_GRACE_S` | `30` | Slack for the stale-in-flight fast path: when the listener heartbeat is newer than the in-flight start by more than this many seconds, the in-flight command's executor is provably gone and the wedge is cleared immediately instead of waiting out `REMOTIFY_MAX_INFLIGHT_MS`. |

## Tools exposed

- `remote_exec(command)` - pushes `command` to the relay, waits for the listener
  to run it, returns combined stdout+stderr as plain text.
- `remote_session_info()` - returns the current key, URLs, and the ready-to-paste
  remote one-liner.
- `remote_session_reset({rotate?})` - recovery escape hatch. Default: clears
  wedged relay state in place (queued cmd/result + in-flight marker); the key
  and a connected listener keep working. `{"rotate": true}`: purges the current
  session and mints a brand-new key (the user must re-paste the new one-liner).
  Normally unnecessary - `remote_exec` auto-recovers on its own (see below).

## Auto-recovery from a wedged session

A listener killed mid-command without a chance to notify the relay (kill -9,
closed terminal, host reboot) used to leave the session wedged: every new
command returned `[busy]` for a command the current session never issued, and
the only way out was hand-posting a dummy result and reloading the MCP. That
state now clears itself:

- **Relay-side:** the moment any listener (re)connects and polls for work, the
  relay detects the orphaned in-flight marker, clears it, and queues a
  synthetic `[remotify: ...]` result for whoever was waiting.
- **MCP-side:** when a new command hits the busy-guard and the marker is
  provably stale (listener heartbeat newer than the pickup by
  `REMOTIFY_STALE_GRACE_S`) or older than `REMOTIFY_MAX_INFLIGHT_MS`, the MCP
  resets the session state itself (`POST /api/session/{key}/reset`, with a
  manual-clear fallback for older relays) and proceeds with the new command,
  prefixing the response with `[recovered]`.

A genuinely long-running command is not affected: while its listener is busy
executing, the heartbeat cannot be newer than the pickup, so nothing clears
before `REMOTIFY_MAX_INFLIGHT_MS`.

## How `remote_exec` handles a missing listener

The MCP server has no channel to show text to the user mid-tool-call (Claude
Code, Cursor, etc. don't render `notifications/progress` or `notifications/message`
from an MCP server during a tool call). Elicitation dialogs work but can't be
closed server-side on current clients, which leaves stale prompts in chat.

Instead, `remote_exec` uses a **silent pending-loop** pattern:

1. Pushes the command to the relay, polls for ~5s (`REMOTIFY_CHUNK_MS`).
2. If the listener picks up the command in that window, the tool waits for the
   result and returns it. Most calls finish here.
3. If the listener hasn't connected yet, the tool returns a `[pending]` text
   that tells the assistant to (a) relay the paste one-liners to the user as a
   concise chat message and (b) immediately call `remote_exec` again with the
   same arguments. The server carries state across chained calls, so the
   command is not re-queued and will not execute twice.
4. Steps 1-3 repeat silently until the listener connects and returns output.
   Two different limits bound this, and they are not the same thing:
   - The assistant is prompted to stop looping and tell the user about the
     failure after about 10 consecutive `[pending]` responses - that's chat-side
     guidance, not something the server enforces.
   - `REMOTIFY_MAX_CHUNKS` (default 24) is the server's internal ceiling, and it
     only counts *unproductive* waiting: once the relay confirms the command is
     actually executing on the remote (`cmd_in_flight`), that time is refunded
     and does not count against the budget, so a long-running job (`mongodump`,
     `restic`, a slow deploy) is never mistaken for a dead listener. The queued
     command is only auto-dropped from the relay once this pickup budget is
     genuinely exhausted on continued unproductive retries (no listener at all,
     or one that stopped responding), or once the session expires on its own
     idle TTL - whichever comes first.

Net effect the user sees: "Calling remotify..." for a few seconds, then either
the command output (if the listener was already up or connected quickly) or a
short chat message from the assistant asking them to paste the one-liner on
the remote - no dialog, no leftover UI prompts, auto-continues the moment the
listener accepts the command.

## Typical first-run flow

1. Your MCP host launches this server. Nothing happens yet - no session is
   created at startup. The first call to `remote_exec` or `remote_session_info`
   mints the session lazily and prints it to stderr:
   ```
   remotify: new session a1b2...
     on remote: curl -fsSL 'https://remotify.run/r/a1b2...' | bash
   ```
2. First `remote_exec` call triggers that session creation. No listener yet →
   tool returns `[pending]`. The assistant tells you the paste one-liners.
3. You paste one of them on the remote (supervised prompts `y/N` per command;
   auto runs every command straight away). Listener connects.
4. The assistant's next looped `remote_exec` call picks up the listener and
   returns the output. From here on, calls with a running listener finish in
   ~0.5-2s.
