# remotify.run

Ephemeral HTTP command relay. Push a shell command from any HTTP client; have
it run on a remote machine that has nothing installed but `curl` and `bash`.

Useful whenever you need to bounce a command to a shell without opening an SSH
port, installing an agent, or deploying anything:

- LLM coding sessions driving an arbitrary remote host - any tool, self-hosted or cloud (MCP hosts, curl-literate chat models, local runners, etc.)
- CI runners poking at post-deploy state
- Admin shells behind NAT / firewalls
- Headless devices reachable only outbound

Nothing persists on the server - the relay is a pure byte pipe. Session keys
are 128-bit random; traffic flows only while both sides are attached.

## Architecture

```
  CLIENT                        remotify.run                     REMOTE SHELL
  (LLM / CI / terminal)         (single vhost)                   (curl + bash)

   |                              |                              |
   |-- POST /api/session -------->|                              |
   |<-- key + URLs ---------------|                              |
   |                              |                              |
   |        (user pastes the remote-quickstart on the remote)    |
   |                              |                              |
   |                              |<-- curl /r/KEY?mode=... -----|
   |                              |   runner script starts       |
   |                              |                              |
   |-- POST /cmd-KEY ------------>|      queued on disk          |
   |<-- 201 ----------------------|                              |
   |   (client may disconnect)    |                              |
   |                              |<-- GET /cmd-KEY (poll) ------|
   |                              |-- 200 + command body ------->|
   |                              |                >>> prints cmd|
   |                              |                (y/N if supervised)
   |                              |                bash runs     |
   |                              |                              |
   |                              |<-- POST /result-KEY ---------|
   |                              |      queued on disk          |
   |                              |--- 201 --------------------->|
   |                              |                <<< done      |
   |-- GET /result-KEY (poll) --->|                              |
   |<-- 200 + output -------------|                              |
```

## Stack

| Component | Role | First-party code |
|-----------|------|------------------|
| nginx | Reverse proxy, TLS, rate limiting, static landing page | Config only |
| PHP-FPM | Session API, runner script generator, file-backed queue | Yes |
| certbot | Automatic TLS issuance + renewal (optional, `--profile tls`) | No |

No database. No worker. The only persistent state is a flat-file queue under `/data/sessions/<KEY>/`.

## Quick start

```bash
cp .env.example .env
# edit DOMAIN / SCHEME for your deployment
docker compose up -d                       # HTTP only (use behind your own reverse proxy)
docker compose --profile tls up -d         # HTTP + HTTPS with automatic TLS
```

That's the whole install. Everything else runs in containers.

## Environment

All knobs live in `.env`; nothing is hardcoded.

| Var | Default | Meaning |
|-----|-----------------|---------|
| `DOMAIN` | `localhost` | Public hostname for the API / landing page |
| `SCHEME` | `http` | `http` or `https` - baked into returned one-liners |
| `PUBLIC_PORT` | _(empty)_ | Set only when serving on a non-standard port |
| `NGINX_MODE` | `http` | `http` or `tls`. `tls` requires `--profile tls` |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | Host ports published by nginx |
| `RATE_LIMIT` | `10r/m` | Per-IP rate on `POST /api/session` (nginx `limit_req` syntax) |
| `RATE_LIMIT_BURST` | `5` | Burst slots before 503 |
| `PROXY_TIMEOUT` | `3600` | Max seconds either side of a pipe waits for the other end |
| `MAX_BODY_SIZE` | `25m` | nginx `client_max_body_size` on the queue endpoints. Caps a single push. Set `0` for unlimited. |
| `SESSION_TTL` | `10800` | Idle TTL for a session (seconds). Every request on the key resets it; expired sessions are purged with their queue + history. |
| `AUDIT_LOG` | `0` | `1` = log key generation to container stderr |
| `CERTBOT_EMAIL` | _(required for tls profile)_ | Contact address used when requesting certs from the ACME CA |
| `CERTBOT_STAGING` | `0` | `1` = use the ACME staging environment (test-only certs, avoids rate limits) |

Behind your own reverse proxy? Skip the `tls` profile. Point your proxy at
`HTTP_PORT` on localhost and terminate TLS there.

## API

### `POST /api/session`
Generate a new session. Returns:

- `key` - 32-char hex, 128-bit entropy
- `ttl_seconds` - idle TTL (default 3h sliding; any request on the key resets it)
- `urls.cmd` / `urls.result` - queue push/pop endpoints for this session
- `urls.runner` - base URL of the runner script; append `?mode=auto` for unattended mode
- `urls.api` - `/api/session/<key>` for re-fetching the payload
- `remote_quickstart` - ready-to-paste one-liner (supervised mode by default; operator can opt in to auto by appending `?mode=auto`)
- `exec` - one-liner template with a `COMMAND` placeholder for pushing from any HTTP client

### `GET /api/session/{key}`
Re-fetch the same payload for a known key. Touches the session (resets its idle
timer) without consuming anything queued.

### `GET /api/session/{key}/status`
Cheap probe: returns `{cmd_queued, result_queued}` without consuming anything.
Used by the MCP server to detect whether the listener has already picked up the
queued command.

### `DELETE /api/session/{key}`
Purges the session directory (queued cmd/result + any archived pushes) and
returns 204.

### `POST /cmd-{key}` / `GET /cmd-{key}`
POST pushes a command (plain bytes or `Content-Encoding: gzip`). GET consumes
the hot command slot - used by the listener. Last-write-wins: pushing while a
command is already queued replaces it; the old bytes survive as a timestamped
archive.

### `DELETE /cmd-{key}`
Drops the hot command slot without consuming (no archive, no listener side
effects). Used by the MCP server to cancel its own queued command when it
gives up waiting for a listener, so the command won't execute as an orphan
when one eventually connects.

### `POST /result-{key}` / `GET /result-{key}`
Symmetric endpoints for the listener to post results and the client to fetch
them.

### `GET /r/{key}?mode=supervised|auto`
Returns a ready-to-`bash` runner script. The remote operator runs:

```bash
curl -fsSL 'https://remotify.run/r/KEY' | bash              # supervised
curl -fsSL 'https://remotify.run/r/KEY?mode=auto' | bash    # auto
```

`supervised` previews every incoming command and waits for `y/N` (accepts `y`,
`Y`, `yes`, etc. - any response starting with y/Y). `auto` trusts every command
(only on hosts where the session key is fully private).

Both modes print each incoming command as `>>> <cmd>` before running it and
`<<< done (N bytes pushed back)` after the result is posted back, so the
operator can see traffic even in auto mode.

The runner exports a non-interactive env block (`DEBIAN_FRONTEND=noninteractive`,
`CI=true`, `TERM=dumb`, `PAGER=cat`, `SYSTEMD_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`)
before executing each command, so apt, pagers, and git don't block on TTY input.
Sudo still prompts unless the caller uses `sudo -n` - the operator sees the
preview line and can choose to authenticate.

### `GET /api/health`
Returns `{"ok": true, "service": "remotify.run"}`.

## Landing page

`GET /` serves a tiny zero-dependency HTML page that calls `/api/session`,
shows the generated key, the remote-side one-liner with a copy button, and the
`curl`-only exec template you can paste straight into any terminal. Useful
when an operator just needs the one-liner without hitting the API manually.

## Using it from an LLM tool

Two integration paths. Pick whichever your tool supports:

- **MCP** (most coding agents): your tool runs `mcp/server.js` locally and the model gets a native `remote_exec` tool.
- **HTTP / curl** (any tool with a Bash/shell tool): drop `templates/AGENTS.md.example` into your repo as the rules file your tool reads; the model calls the API itself with curl.

The MCP server is on npm as [`remotify-mcp`](https://www.npmjs.com/package/remotify-mcp) - every host below can use `npx` to run it with zero install.

### Claude Code

```bash
claude mcp add -s user remotify -- npx -y remotify-mcp@latest
```
`-s user` registers the server globally (in `~/.claude.json` at the user scope) so it's available from every working directory. Without `-s user` it lands in project-local scope and only appears in sessions whose cwd matches where you ran the command.

Verify:
```bash
claude mcp list          # remotify should be listed
```
Inside a session, the `/mcp` slash-command shows the live status and the exposed `remote_exec` tool.

### Cursor

Edit `~/.cursor/mcp.json`:
```json
{ "mcpServers": { "remotify": { "command": "npx", "args": ["-y", "remotify-mcp@latest"] } } }
```
Restart Cursor.

### Codex CLI (OpenAI)

Edit `~/.codex/config.toml`:
```toml
[mcp_servers.remotify]
command = "npx"
args    = ["-y", "remotify-mcp@latest"]
```

### Gemini CLI

Edit `~/.gemini/settings.json`:
```json
{ "mcpServers": { "remotify": { "command": "npx", "args": ["-y", "remotify-mcp@latest"] } } }
```

### Any other MCP-capable tool

Windsurf, Continue, Cline/Roo Code, Zed, VS Code's built-in MCP - they all accept the same `command` + `args` shape, just in a config file they each document. Drop the snippet in and you're done.

### Tools that are NOT MCP-capable (ChatGPT web, Ollama UIs, any bash-only agent, ...)

Drop [`templates/AGENTS.md.example`](templates/AGENTS.md.example) into your project as the rules file the tool reads - common filenames: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `CONVENTIONS.md`, `.github/copilot-instructions.md`. It teaches the model to `POST /api/session` and use curl to push/pull. No server-side integration needed.

### Overriding the relay

All snippets above default to `https://remotify.run`. If you self-host, add one env var:
```json
"env": { "REMOTIFY_URL": "https://remotify.example.com" }
```


## Using it from anything else

If it speaks HTTP, it can talk to remotify.run. The only API call needed to
get started is `POST /api/session`; everything after that is an HTTP GET or
POST against the `pipe.` subdomain.

## Security model

- **Key = access.** 128-bit random hex, unguessable at internet scale. Keep
  it private; anyone with the key can push commands to any listener on that key.
- **TLS is mandatory in production.** Keys travel in URL paths; HTTPS prevents
  interception.
- **nginx rate-limits** `POST /api/session` per IP (see `RATE_LIMIT`).
- **No server-side persistence.** Commands and output stream through in memory
  and are forgotten when the pipe closes.
- **Supervised mode on the remote.** `/r/KEY?mode=supervised` prompts `y/N`
  before running each incoming command.
- **`--data-raw`** (rather than plain `-d` / `--data`) is used throughout to
  avoid curl's `@file` magic - a command that starts with `@` will not be
  read as a filename.

Threat-wise this is roughly equivalent to handing someone an SSH session:
commands run as whatever user pasted the remote one-liner. Do not paste the
one-liner on a shell you would not SSH into.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
