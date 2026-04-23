<?php
declare(strict_types=1);

// ---------------------------------------------------------------------------
// Config (read once, cached forever in the worker).
// Pass $reset=true in tests to force the next call to re-read the environment.
// ---------------------------------------------------------------------------
function cfg(bool $reset = false): array {
    static $c = null;
    if ($reset) { $c = null; return []; }
    if ($c !== null) return $c;
    $scheme      = getenv('SCHEME')      ?: 'http';
    $domain      = getenv('DOMAIN')      ?: 'localhost';
    $publicPort  = getenv('PUBLIC_PORT') ?: '';
    $defaultPort = $scheme === 'https' ? '443' : '80';
    $portSuffix  = ($publicPort !== '' && $publicPort !== $defaultPort) ? ":$publicPort" : '';
    $dataDir     = getenv('DATA_DIR')    ?: '/var/data/sessions';
    if (!is_dir($dataDir)) @mkdir($dataDir, 0755, true);
    $c = [
        'scheme'         => $scheme,
        'domain'         => $domain,
        'port_suffix'    => $portSuffix,
        'base'           => "$scheme://$domain$portSuffix",
        'data_dir'       => $dataDir,
        'session_ttl'    => (int)(getenv('SESSION_TTL') ?: '10800'),
        'audit_log'      => getenv('AUDIT_LOG') === '1',
        'source_url'     => getenv('SOURCE_URL') ?: '',
        'max_body_bytes' => (int)(getenv('MAX_BODY_BYTES') ?: (25 * 1024 * 1024)),
    ];
    return $c;
}

// ---------------------------------------------------------------------------
// Response helpers.
// ---------------------------------------------------------------------------
function json_out(int $code, array $data): never {
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    exit;
}

function text_out(int $code, string $body, string $type = 'text/plain'): never {
    header("Content-Type: $type");
    http_response_code($code);
    echo $body;
    exit;
}

// ---------------------------------------------------------------------------
// Session directory lifecycle.
// ---------------------------------------------------------------------------
function session_dir(string $key): string {
    return cfg()['data_dir'] . "/$key";
}

// True if the session exists and is within TTL; touches the dir on hit.
// Expired sessions are purged on contact and return false.
function touch_session(string $key): bool {
    $dir = session_dir($key);
    if (!is_dir($dir)) return false;
    if ((time() - filemtime($dir)) > cfg()['session_ttl']) {
        purge_session($key);
        return false;
    }
    @touch($dir);
    return true;
}

function create_session(string $key): void {
    @mkdir(session_dir($key), 0755, true);
}

function purge_session(string $key): void {
    $dir = session_dir($key);
    if (!is_dir($dir)) return;
    $it = new RecursiveDirectoryIterator($dir, RecursiveDirectoryIterator::SKIP_DOTS);
    foreach (new RecursiveIteratorIterator($it, RecursiveIteratorIterator::CHILD_FIRST) as $f) {
        if ($f->isDir()) @rmdir($f->getPathname()); else @unlink($f->getPathname());
    }
    @rmdir($dir);
}

// ---------------------------------------------------------------------------
// Queue slot I/O.
//
// Every push writes a timestamped archive and a "hot" hard-link pointing at
// it. The hot file is what the consumer sees and unlinks; the archive
// survives until the session expires, giving a free audit trail without
// doubling on-disk bytes.
// ---------------------------------------------------------------------------
function write_queue(string $key, string $slot, string $body): int {
    $dir  = session_dir($key);
    $lock = "$dir/.lock";
    $hot  = "$dir/$slot";
    $ts   = gmdate('Ymd\THis\Z');
    $archive = "$dir/$slot-$ts";
    $fp = @fopen($lock, 'c');
    if (!$fp || !flock($fp, LOCK_EX)) return 500;
    try {
        $i = 1;
        while (file_exists($archive)) { $archive = "$dir/$slot-$ts-$i"; $i++; }
        if (@file_put_contents($archive, $body) === false) return 500;
        // Prior hot (if still unconsumed) already has its own archive from its
        // own write; last-wins rotation replaces the hot pointer.
        @unlink($hot);
        if (!@link($archive, $hot) && !@copy($archive, $hot)) return 500;
        return 201;
    } finally {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}

function read_queue(string $key, string $slot): ?string {
    $dir  = session_dir($key);
    $lock = "$dir/.lock";
    $hot  = "$dir/$slot";
    $fp = @fopen($lock, 'c');
    if (!$fp || !flock($fp, LOCK_EX)) return null;
    try {
        if (!file_exists($hot)) return null;
        $body = @file_get_contents($hot);
        @unlink($hot);
        return $body === false ? null : $body;
    } finally {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}

// Drops the hot slot without consuming (no archive change, no listener will
// ever see it). Used by the client side to cancel an uncollected command.
function delete_hot(string $key, string $slot): void {
    @unlink(session_dir($key) . "/$slot");
}

// ---------------------------------------------------------------------------
// Payloads.
// ---------------------------------------------------------------------------
function session_payload(string $key): array {
    $c = cfg();
    $base = $c['base'];
    return [
        'key' => $key,
        'ttl_seconds' => $c['session_ttl'],
        'urls' => [
            'cmd'    => "$base/cmd-$key",
            'result' => "$base/result-$key",
            'api'    => "$base/api/session/$key",
            'runner' => "$base/r/$key",
        ],
        // Supervised is the safe default. The operator can opt in to auto by
        // appending ?mode=auto to the URL themselves.
        'remote_quickstart' => "curl -fsSL '$base/r/$key' | bash",
        'exec' => "curl -s --data-raw 'COMMAND' $base/cmd-$key && while :; do R=\$(curl -fsw '%{http_code}' -o /tmp/.r $base/result-$key); [ \"\$R\" = 200 ] && { cat /tmp/.r; break; }; sleep 1; done",
    ];
}

function runner_script(string $key, string $mode): string {
    $base = cfg()['base'];
    $header = <<<BASH
#!/usr/bin/env bash
# remotify.run - remote-side runner (mode: $mode)
set -u
BASE='$base'
KEY='$key'
POLL=2
CMD_URL="\$BASE/cmd-\$KEY"
RES_URL="\$BASE/result-\$KEY"
# Exported once so every command the relay sends inherits a non-interactive
# environment. Suppresses apt/dpkg prompts, forces plain terminal output,
# and prevents pagers and git from blocking on a TTY.
export DEBIAN_FRONTEND=noninteractive
export CI=true
export TERM=dumb
export PAGER=cat
export SYSTEMD_PAGER=cat
export GIT_TERMINAL_PROMPT=0
trap 'echo; echo "remotify: disconnected"; exit 0' INT TERM
BASH;

    if ($mode === 'auto') {
        $body = <<<'BASH'
echo "remotify: connected [auto] - polling for commands (${POLL}s). Ctrl+C to stop."
while :; do
  CODE=$(curl -fs -o /tmp/.remotify-cmd -w '%{http_code}' --max-time 15 "$CMD_URL" 2>/dev/null || echo 000)
  case "$CODE" in
    200)
      CMD=$(cat /tmp/.remotify-cmd); [ -z "$CMD" ] && { sleep "$POLL"; continue; }
      printf '\n>>> %s\n' "$CMD"
      OUT=$(bash -c "$CMD" 2>&1)
      printf '%s' "$OUT" | gzip -c | curl -fs -H 'Content-Encoding: gzip' --data-binary @- "$RES_URL" >/dev/null 2>&1 || sleep 1
      printf '<<< done (%d bytes pushed back)\n' "${#OUT}"
      ;;
    204) sleep "$POLL" ;;
    410) echo "remotify: session expired or unknown key"; exit 1 ;;
    *)   sleep "$POLL" ;;
  esac
done
BASH;
    } else {
        $body = <<<'BASH'
echo "remotify: connected [supervised] - preview each command before it runs. Ctrl+C to stop."
while :; do
  CODE=$(curl -fs -o /tmp/.remotify-cmd -w '%{http_code}' --max-time 15 "$CMD_URL" 2>/dev/null || echo 000)
  case "$CODE" in
    200)
      CMD=$(cat /tmp/.remotify-cmd); [ -z "$CMD" ] && { sleep "$POLL"; continue; }
      printf '\n>>> %s\n' "$CMD"
      read -r -p 'Run? [y/N] ' ok </dev/tty || ok=n
      case "$ok" in
        [yY]*) OUT=$(bash -c "$CMD" 2>&1) ;;
        *)     OUT='[declined by operator]' ;;
      esac
      printf '%s' "$OUT" | gzip -c | curl -fs -H 'Content-Encoding: gzip' --data-binary @- "$RES_URL" >/dev/null 2>&1 || true
      printf '<<< done (%d bytes pushed back)\n' "${#OUT}"
      ;;
    204) sleep "$POLL" ;;
    410) echo "remotify: session expired or unknown key"; exit 1 ;;
    *)   sleep "$POLL" ;;
  esac
done
BASH;
    }
    return $header . "\n\n" . $body . "\n";
}

// ---------------------------------------------------------------------------
// Handlers.
// Each handler receives the regex captures (if any) from its route pattern as
// positional arguments. All handlers terminate the request via json_out(),
// text_out(), or an explicit exit.
// ---------------------------------------------------------------------------
function h_health(): never {
    json_out(200, ['ok' => true, 'service' => 'remotify.run']);
}

function h_source_redirect(): never {
    $url = cfg()['source_url'];
    if ($url === '') text_out(404, "source link not configured\n");
    header("Location: $url", true, 302);
    exit;
}

function h_source_json(): never {
    json_out(200, ['url' => cfg()['source_url']]);
}

function h_session_create(): never {
    $key = bin2hex(random_bytes(16));
    create_session($key);
    if (cfg()['audit_log']) {
        error_log(sprintf('remotify: session key=%s from=%s', $key, $_SERVER['REMOTE_ADDR'] ?? '-'));
    }
    json_out(201, session_payload($key));
}

function h_session_get(string $key): never {
    if (!touch_session($key)) json_out(410, ['error' => 'session gone']);
    json_out(200, session_payload($key));
}

function h_session_status(string $key): never {
    if (!touch_session($key)) json_out(410, ['error' => 'session gone']);
    $dir = session_dir($key);
    json_out(200, [
        'cmd_queued'    => file_exists("$dir/cmd"),
        'result_queued' => file_exists("$dir/result"),
    ]);
}

function h_session_delete(string $key): never {
    purge_session($key);
    http_response_code(204);
    exit;
}

function h_runner(string $key): never {
    if (!touch_session($key)) text_out(410, "remotify: session gone\n");
    $mode = (($_GET['mode'] ?? 'supervised') === 'auto') ? 'auto' : 'supervised';
    header('Content-Type: text/x-shellscript; charset=utf-8');
    header('Cache-Control: no-store');
    header('Content-Disposition: inline; filename="remotify-' . $key . '-' . $mode . '.sh"');
    echo runner_script($key, $mode);
    exit;
}

function h_queue_write(string $slot, string $key): never {
    if (!touch_session($key)) text_out(410, "session gone\n");
    $body = file_get_contents('php://input');
    if ($body === false) $body = '';
    if (strtolower($_SERVER['HTTP_CONTENT_ENCODING'] ?? '') === 'gzip') {
        $decoded = @gzdecode($body);
        if ($decoded === false) text_out(400, "bad gzip\n");
        // Zip-bomb guard: 3x the nginx wire cap is the tolerable ratio.
        if (strlen($decoded) > 3 * cfg()['max_body_bytes']) text_out(413, "decoded body too large\n");
        $body = $decoded;
    }
    $code = write_queue($key, $slot, $body);
    text_out($code, $code === 201 ? "queued\n" : "error\n");
}

function h_queue_read(string $slot, string $key): never {
    if (!touch_session($key)) text_out(410, "session gone\n");
    $body = read_queue($key, $slot);
    if ($body === null) { http_response_code(204); exit; }
    header('Content-Type: application/octet-stream');
    echo $body;
    exit;
}

function h_queue_delete(string $slot, string $key): never {
    if (!touch_session($key)) text_out(410, "session gone\n");
    delete_hot($key, $slot);
    http_response_code(204);
    exit;
}

// ---------------------------------------------------------------------------
// Route table: [method, pattern, handler].
// Regex captures are passed to the handler as positional arguments.
// First match wins; order matters only for overlapping patterns (e.g. the
// /status variant must come before the bare /api/session/{key} pattern).
// ---------------------------------------------------------------------------
$ROUTES = [
    ['GET',    '#^/api/health$#',                                'h_health'],
    ['GET',    '#^/source$#',                                    'h_source_redirect'],
    ['GET',    '#^/api/source$#',                                'h_source_json'],
    ['POST',   '#^/api/session$#',                               'h_session_create'],
    ['GET',    '#^/api/session/([a-f0-9]{32})/status$#',         'h_session_status'],
    ['GET',    '#^/api/session/([a-f0-9]{32})$#',                'h_session_get'],
    ['DELETE', '#^/api/session/([a-f0-9]{32})$#',                'h_session_delete'],
    ['GET',    '#^/r/([a-f0-9]{32})$#',                          'h_runner'],
    ['POST',   '#^/(cmd|result)-([a-f0-9]{32})$#',               'h_queue_write'],
    ['GET',    '#^/(cmd|result)-([a-f0-9]{32})$#',               'h_queue_read'],
    ['DELETE', '#^/(cmd|result)-([a-f0-9]{32})$#',               'h_queue_delete'],
];

// ---------------------------------------------------------------------------
// Dispatch.
// Unit tests define REMOTIFY_TESTING before requiring this file so the
// helpers, payloads, and runner_script() are available without the HTTP
// dispatcher running on include.
// ---------------------------------------------------------------------------
if (defined('REMOTIFY_TESTING')) return;

$path   = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

foreach ($ROUTES as [$m, $pat, $fn]) {
    if ($m !== $method) continue;
    if (!preg_match($pat, $path, $match)) continue;
    $fn(...array_slice($match, 1));
}

json_out(404, ['error' => 'not found', 'path' => $path]);
