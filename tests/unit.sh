#!/usr/bin/env bash
#
# Run the PHPUnit unit suite. Requires only `curl` + either host `php`
# or `docker`. phpunit.phar is cached in ~/.cache/ after the first run.
#
#   ./tests/unit.sh              # runs all unit tests
#   ./tests/unit.sh --filter foo # pass extra args straight to phpunit
#
set -eu

# Defaults to the latest stable in the PHPUnit 11 series (phar.phpunit.de
# hosts phpunit-11.phar as an alias of the latest 11.x release). Pin to a
# specific patch by setting PHPUNIT_VERSION=11.5.3 etc., e.g. for
# reproducible release builds.
PHPUNIT_VERSION="${PHPUNIT_VERSION:-11}"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}"
PHAR="$CACHE_DIR/remotify/phpunit-${PHPUNIT_VERSION}.phar"

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

if [ ! -f "$PHAR" ]; then
  mkdir -p "$(dirname "$PHAR")"
  echo "downloading phpunit ${PHPUNIT_VERSION}..."
  curl -fsSL -o "$PHAR" "https://phar.phpunit.de/phpunit-${PHPUNIT_VERSION}.phar"
  chmod +x "$PHAR"
fi

# Prefer the host's PHP if available; otherwise use a throwaway docker container.
if command -v php >/dev/null 2>&1; then
  exec php "$PHAR" --configuration tests/phpunit.xml "$@"
fi

if command -v docker >/dev/null 2>&1; then
  # Run as the host user so any files PHPUnit creates in the workspace
  # (e.g. its cache dir) stay removable by whoever launched the script.
  exec docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$REPO_ROOT:/work" -v "$PHAR:/phpunit.phar:ro" -w /work \
    php:8.3-cli php /phpunit.phar --configuration tests/phpunit.xml "$@"
fi

echo "error: neither 'php' nor 'docker' is available" >&2
exit 1
