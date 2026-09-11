#!/usr/bin/env bash
# Stress gate for `npm test` determinism (UC-0.3, #136).
#
# Runs ROUNDS rounds (default 10). Each round starts TWO `npm test` processes in
# parallel from this same checkout, so they contend for CPU and for anything the
# suite still shares. A round is green only if both exit 0 and
# `git status --porcelain` afterwards matches the snapshot taken before round 1.
#
#   scripts/test-stress.sh            # the gate: must print 10/10 rounds green
#   ROUNDS=2 scripts/test-stress.sh   # a quick trial
#
# Plain bash, macOS-compatible (no `timeout`, no GNU-only flags).
set -u

ROUNDS="${ROUNDS:-10}"
case "$ROUNDS" in
  '' | *[!0-9]* | 0) echo "ROUNDS must be a positive integer, got '$ROUNDS'" >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.." || exit 2

LOG_DIR="$(mktemp -d)"
SNAPSHOT="$LOG_DIR/porcelain.before"
git status --porcelain > "$SNAPSHOT"
echo "logs: $LOG_DIR"

green=0
for round in $(seq 1 "$ROUNDS"); do
  a_log="$LOG_DIR/round-$round-a.log"
  b_log="$LOG_DIR/round-$round-b.log"
  npm test > "$a_log" 2>&1 &
  a_pid=$!
  npm test > "$b_log" 2>&1 &
  b_pid=$!
  wait "$a_pid"; a_exit=$?
  wait "$b_pid"; b_exit=$?

  round_ok=1
  if [ "$a_exit" -ne 0 ]; then
    round_ok=0
    echo "round $round: run a exited $a_exit (log: $a_log)"
    grep -E '^not ok|^✖|failing tests' "$a_log" | head -20
  fi
  if [ "$b_exit" -ne 0 ]; then
    round_ok=0
    echo "round $round: run b exited $b_exit (log: $b_log)"
    grep -E '^not ok|^✖|failing tests' "$b_log" | head -20
  fi

  after="$LOG_DIR/porcelain.after-$round"
  git status --porcelain > "$after"
  if ! diff -u "$SNAPSHOT" "$after"; then
    round_ok=0
    echo "round $round: the working tree changed"
  fi

  if [ "$round_ok" -eq 1 ]; then
    green=$((green + 1))
    echo "round $round: green"
  fi
done

echo "$green/$ROUNDS rounds green"
[ "$green" -eq "$ROUNDS" ]
