#!/bin/sh
# A bd for the answer-speed UI test (scripts/test-answer-speed-ui.mjs) only: start the
# isolated test server with BD_BIN set to this file. It runs the real bd
# (SCOTTY_SLOW_BD_REAL, default "bd") after two test controls, files in
# SCOTTY_SLOW_BD_DIR that the test writes:
#   delay-<command>          seconds to wait before that bd command (for example delay-close)
#   fail-<command>-<id>      that command on that item fails, as bd fails, with a JSON error
# Never point a live board's server at it.
dir="${SCOTTY_SLOW_BD_DIR:?set SCOTTY_SLOW_BD_DIR to the test control folder}"
real="${SCOTTY_SLOW_BD_REAL:-bd}"
if [ -n "$1" ] && [ -n "$2" ] && [ -e "$dir/fail-$1-$2" ]; then
  printf '%s\n' '{"error":"The test refused this write.","code":"test_refusal"}' >&2
  exit 1
fi
if [ -n "$1" ] && [ -s "$dir/delay-$1" ]; then
  sleep "$(cat "$dir/delay-$1")"
fi
exec "$real" "$@"
