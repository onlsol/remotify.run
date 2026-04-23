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
| `REMOTIFY_MAX_CHUNKS` | `24` | Hard ceiling on consecutive `[pending]` returns before the tool errors out (`24 * 5s = ~2min`). |
| `REMOTIFY_WAIT_MS` | `300000` | Max time to wait for the result once the listener has accepted the command. |
| `REMOTIFY_POLL_MS` | `500` | Internal poll interval against the relay's `/api/session/<key>/status` probe. |

## Tools exposed

- `remote_exec(command)` - pushes `command` to the relay, waits for the listener
  to run it, returns combined stdout+stderr as plain text.
- `remote_session_info()` - returns the current key, URLs, and the ready-to-paste
  remote one-liner.

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
4. Steps 1-3 repeat silently until the listener connects and returns output,
   or `REMOTIFY_MAX_CHUNKS` (default 24, ~2min) is hit. On the final timeout
   the queued command is deleted from the relay so it doesn't run later as an
   orphan.

Net effect the user sees: "Calling remotify..." for a few seconds, then either
the command output (if the listener was already up or connected quickly) or a
short chat message from the assistant asking them to paste the one-liner on
the remote - no dialog, no leftover UI prompts, auto-continues the moment the
listener accepts the command.

## Typical first-run flow

1. Your MCP host launches this server; it creates a session and prints to stderr:
   ```
   remotify: new session a1b2...
     on remote: curl -fsSL 'https://remotify.run/r/a1b2...' | bash
   ```
2. First `remote_exec` call. No listener yet → tool returns `[pending]`. The
   assistant tells you the paste one-liners.
3. You paste one of them on the remote (supervised prompts `y/N` per command;
   auto runs every command straight away). Listener connects.
4. The assistant's next looped `remote_exec` call picks up the listener and
   returns the output. From here on, calls with a running listener finish in
   ~0.5-2s.
