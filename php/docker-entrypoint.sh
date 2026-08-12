#!/bin/sh
# Container entrypoint for the relay's php-fpm worker.
#
#  1. Make the bind-mounted data dir writable by the php worker user.
#  2. Size the FPM process pool for this relay's long-poll workload.
#  3. Delegate to the stock php image entrypoint (which execs php-fpm).
set -e

if [ -d /var/data ]; then
    chown -R www-data:www-data /var/data || true
    # 0700, NOT world-readable: session dirs hold live keys and full command +
    # result content (which may include credentials dumped by prior commands).
    # Only the php worker (www-data) needs access; keep other local users out.
    chmod 700 /var/data 2>/dev/null || true
    [ -d /var/data/sessions ] && chmod 700 /var/data/sessions 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Derive PHP's body limits from the single nginx-syntax MAX_BODY_SIZE knob
# (e.g. 25m, 512k, 1g, or 0 = unlimited) so the wire cap, PHP's post_max_size,
# the memory ceiling, and the zip-bomb guard's decoded cap can never drift
# apart. MAX_BODY_BYTES (bytes) feeds the guard; post_max_size must accept a raw
# body up to the wire cap; memory_limit must hold the decoded body (up to 3x the
# cap) plus headroom. Written to a zz-* conf.d file that loads AFTER (and thus
# overrides) the Dockerfile's 99-remotify.ini defaults.
# ---------------------------------------------------------------------------
_mbs=$(printf '%s' "${MAX_BODY_SIZE:-}" | tr 'A-Z' 'a-z' | tr -d ' ')
_num=${_mbs%[kmg]}
case "$_mbs" in
    *k) _bytes=$(( _num * 1024 )) ;;
    *m) _bytes=$(( _num * 1024 * 1024 )) ;;
    *g) _bytes=$(( _num * 1024 * 1024 * 1024 )) ;;
    0)  _bytes=-1 ;;                 # nginx "unlimited"
    ''|*[!0-9]*) _bytes=0 ;;         # empty or non-numeric -> leave code defaults
    *) _bytes=$_mbs ;;               # a bare byte count
esac

if [ "${_bytes:-0}" -gt 0 ] 2>/dev/null; then
    [ -z "${MAX_BODY_BYTES:-}" ] && export MAX_BODY_BYTES="$_bytes"
    _pms=$(( _bytes / 1048576 + 1 ))        # raw body cap, MB (round up)
    _mem=$(( _bytes * 5 / 1048576 + 64 ))   # ~5x decoded headroom + base, MB
    [ "$_mem" -lt 256 ] && _mem=256
    cat > /usr/local/etc/php/conf.d/zz-remotify-limits.ini <<EOF
post_max_size = ${_pms}M
upload_max_filesize = ${_pms}M
memory_limit = ${_mem}M
EOF
elif [ "${_bytes:-0}" -eq -1 ] 2>/dev/null; then
    # Unlimited wire: let PHP accept any raw body; the zip-bomb guard still keeps
    # a finite decoded cap (code default 25 MB unless MAX_BODY_BYTES is set).
    cat > /usr/local/etc/php/conf.d/zz-remotify-limits.ini <<EOF
post_max_size = 0
upload_max_filesize = 0
memory_limit = 512M
EOF
fi

# ---------------------------------------------------------------------------
# FPM pool sizing.
#
# This is the single most important reliability knob. Every GET /cmd-KEY and
# GET /result-KEY long-polls *inside* the PHP worker for up to LONGPOLL_MS
# (default 15s), so each active session pins roughly two workers at a time
# (the remote listener polling /cmd, the client polling /result). The stock
# php-fpm-alpine pool ships pm.max_children=5, which two or three concurrent
# sessions exhaust outright -- after that even POST /api/session and
# GET /api/health queue behind the held long-polls and appear to hang. That
# is the classic "works, but feels unstable under any real use" failure.
#
# Long-poll workers are cheap: they spend the wait sleeping in usleep(), not
# burning CPU or growing memory. So we can afford a large max_children. Size
# it for the expected concurrent-session count times two, plus headroom for
# short requests. Override FPM_MAX_CHILDREN in .env for very small or very
# busy hosts.
# ---------------------------------------------------------------------------
: "${FPM_MAX_CHILDREN:=64}"
: "${FPM_MAX_REQUESTS:=500}"

# Derive the dynamic-manager spares from the ceiling so the ratios stay sane
# across whatever max_children the operator picks. Guard the minimums so tiny
# values (e.g. FPM_MAX_CHILDREN=4) still yield a valid pool.
_start=$(( FPM_MAX_CHILDREN / 8 )); [ "$_start" -lt 2 ] && _start=2
_max_spare=$(( FPM_MAX_CHILDREN / 2 )); [ "$_max_spare" -lt "$_start" ] && _max_spare=$_start
_min_spare=$_start

# request_terminate_timeout caps a wedged request but must NEVER be shorter than
# the long-poll window, or every idle long-poll would be killed mid-wait. Derive
# it from LONGPOLL_MS (+60s slack), floored at 120s.
: "${LONGPOLL_MS:=15000}"
_rtt=$(( LONGPOLL_MS / 1000 + 60 )); [ "$_rtt" -lt 120 ] && _rtt=120

cat > /usr/local/etc/php-fpm.d/zz-remotify-pool.conf <<EOF
[www]
pm = dynamic
pm.max_children = ${FPM_MAX_CHILDREN}
pm.start_servers = ${_start}
pm.min_spare_servers = ${_min_spare}
pm.max_spare_servers = ${_max_spare}
; Recycle workers periodically so no slow leak accumulates over a long uptime.
pm.max_requests = ${FPM_MAX_REQUESTS}
; Cap a wedged request's wall-time, always above the long-poll window (derived
; from LONGPOLL_MS) so a legitimate idle long-poll is never killed mid-wait.
request_terminate_timeout = ${_rtt}
EOF

exec docker-php-entrypoint "$@"
