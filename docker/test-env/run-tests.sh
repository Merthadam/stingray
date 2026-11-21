#!/usr/bin/env bash
# Runs the test suites inside the test-env image (used by `scripts/test-env.sh test` and CI).
#   run-tests.sh [unit] [e2e [SUITE...]]      default: unit e2e (all suites)
# Evidence (screenshots, logs) goes to /out when mounted, else artifacts/testing/e2e.
set -uo pipefail
cd /app
export STINGRAY_TEST_EVIDENCE=${STINGRAY_TEST_EVIDENCE:-$([ -d /out ] && echo /out/e2e || echo /app/artifacts/testing/e2e)}
git config --global user.name >/dev/null || git config --global user.name 'Stingray Test'
git config --global user.email >/dev/null || git config --global user.email 'test@invalid'

export DISPLAY=:99
Xvfb :99 -screen 0 1440x940x24 -nolisten tcp >/dev/null 2>&1 &
for _ in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done

[ $# -eq 0 ] && set -- unit e2e
status=0
while [ $# -gt 0 ]; do
  case $1 in
    unit) shift; echo "=== unit tests ==="; npm test || status=1 ;;
    e2e) shift; suites=(); while [ $# -gt 0 ] && [ "$1" != unit ]; do suites+=("$1"); shift; done
         node scripts/run-e2e.mjs "${suites[@]}" || status=1 ;;
    *) echo "run-tests: unknown argument $1" >&2; exit 2 ;;
  esac
done
exit $status
