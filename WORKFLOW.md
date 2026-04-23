# Workflow

## Glossary
- **Client side** - whatever pushes commands: an LLM (any MCP host, any Bash-tool-capable chat model), a CI runner, a human at a terminal.
- **Remote side** - the shell where commands actually run. Only has `curl` + `bash`.
- **Queue** - per-session directory on remotify.run's disk holding one pending command and one pending result at a time.

## Data flow

```
  CLIENT                        remotify.run                     REMOTE SHELL
  (LLM / CI / terminal)         (single vhost)                   (curl + bash)

   |                              |                              |
   |-- POST /api/session -------->|                              |
   |<-- key + URLs + one-liners --|                              |
   |                              |                              |
   |    copy remote_quickstart to the clipboard                  |
   |    paste it on the remote shell --------------------------->|
   |                              |                              |
   |                              |<-- curl /r/KEY?mode=... -----|
   |                              |   runner script starts       |
   |                              |                              |
   |-- POST /cmd-KEY ------------>|   (writes cmd + archive)        |
   |<-- 201 queued ---------------|                              |
   |   (client may disconnect)    |                              |
   |                              |<-- GET /cmd-KEY (poll) ------|
   |                              |-- 200 + command body ------->|
   |                              |              >>> prints cmd  |
   |                              |              (y/N if supervised)
   |                              |              runs cmd        |
   |                              |                              |
   |                              |<-- POST /result-KEY ---------|
   |                              |   (writes result + archive)    |
   |                              |--- 201 queued -------------->|
   |                              |              <<< done (N B)  |
   |                              |   (remote may disconnect)    |
   |-- GET /result-KEY (poll) --->|                              |
   |<-- 200 + output -------------|                              |
```

Everything is short, stateless HTTP calls. Both sides can drop offline between steps; the queue is on disk.

## Use cases

| Actor                  | How it talks to the relay                                       | Clipboard paste |
|------------------------|-----------------------------------------------------------------|-----------------|
| LLM + MCP              | `mcp/server.js` pushes + polls; wraps it as a `remote_exec` tool  | once per session (MCP prints one-liner to stderr on startup) |
| LLM without MCP        | reads `templates/AGENTS.md.example`; uses its Bash tool + curl  | once (LLM tells user the one-liner) |
| Human via landing page | open `/`, click **Generate**, click **Copy**                    | once            |
| CI / cron / script     | raw HTTP: POST `/api/session`, then POST `/cmd-KEY` + poll `/result-KEY` | once (pre-provisioned listener) |

## Clipboard

The only thing that ever hits the clipboard:

    curl -fsSL 'https://<HOST>/r/<KEY>?mode=supervised' | bash

Paste it on the remote. Done. Push commands from wherever - no more copy/paste.

## Session lifetime

Every request touching a key (pushing/popping the queue, fetching the runner, pinging `/api/session/<key>`) refreshes the session mtime. Sessions expire **after `SESSION_TTL` seconds of idleness** (default 3h). Expired session dirs are purged on next access, taking any queued + history files with them.

`DELETE /api/session/<key>` explicitly purges immediately.

## Listener modes

`?mode=supervised` - prints each command, waits for `y/N` (accepts `y`, `Y`, `yes`, `YES`, etc.). Default.
`?mode=auto`       - runs every command immediately. Unattended hosts only.

Both poll `/cmd-KEY` every ~2s by default. Approval pauses can be as long as the operator needs - the queue just sits on disk.

Both modes print `>>> <cmd>` before execution and `<<< done (N bytes pushed back)` after the result is posted, so the operator sees status flow even in auto mode.

### Non-interactive env

The runner exports a standard "headless" env block once at the top, so every executed command inherits it: `DEBIAN_FRONTEND=noninteractive`, `CI=true`, `TERM=dumb`, `PAGER=cat`, `SYSTEMD_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`. That covers apt, pagers, git HTTPS auth, and most tools that would otherwise block on a TTY. Sudo still prompts unless called with `-n` - the operator sees the preview and can authenticate interactively if they choose.

## Filesystem visibility (audit + debug)

```
/opt/remotify.run/data/sessions/
└── <KEY>/
    ├── cmd                            # hot: current unconsumed command (absent when none pending)
    ├── cmd-20260422T103015Z           # archive of every cmd push ever, timestamped
    ├── cmd-20260422T103020Z
    ├── result                         # hot: current unconsumed result
    ├── result-20260422T103017Z        # archive of every result push ever
    └── .lock                          # internal (flock coordination)
```

The hot file (`cmd` / `result`) is hard-linked to its corresponding archive on write, so the bytes exist once on disk. When the hot is consumed by the other side it's unlinked; the archive survives.

Everything in `<KEY>/` is removed when the session expires (`SESSION_TTL`, default 3h sliding) or on explicit `DELETE /api/session/<KEY>`.

`ls -lt /opt/remotify.run/data/sessions/` - live sessions sorted by last activity.  
`ls -lt /opt/remotify.run/data/sessions/<KEY>/` - chronological push history for one session.  
`cat /opt/remotify.run/data/sessions/<KEY>/cmd-20260422T103015Z` - inspect any past push.

## Queue semantics

- **Last-wins rotation.** Pushing while a hot file still exists **replaces** it; the old bytes stay on disk as a timestamped archive. No 409.
- **Single delivery.** The remote only ever consumes the *current* hot file. Older archives are audit, never delivered.
- **GET on empty slot** returns **204 No Content**. Poll again.
- **GET / POST on expired or unknown key** returns **410 Gone**.
- **DELETE /cmd-KEY** drops the hot command slot without consuming or archiving. Used by the MCP server to cancel its own queued command when it gives up waiting for a listener, so the command won't run as an orphan when one eventually connects.
- **Max payload per push**: `MAX_BODY_SIZE` from `.env` (default 25 MB); larger pushes are refused by nginx before they reach PHP.
