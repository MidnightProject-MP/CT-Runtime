#!/usr/bin/env bash
# Shared semantic gate for `clasp run` Execution API calls.
#
# A green process exit is not proof of success: clasp can report a semantic
# failure (for example an Execution API permission error) while exiting 0.
# Every workflow `clasp run` must pass through this gate so the rule has one
# executable implementation and one test surface.
#
# Usage:
#   clasp-run-gate.sh <log-file> <label> [--require <fixed-string>]...
#     [--fail-on <fixed-string>]... -- <command> [args...]
#
# - Runs <command>, tees combined output to <log-file>.
# - Fails on nonzero exit.
# - Fails when <log-file> contains the default Execution API permission failure
#   or any extra --fail-on string (false-green semantic failure).
# - Fails when any --require fixed string is absent (missing semantic payload).
# - Inspects fixed strings only with grep -F; never prints credential values.
set -u

DEFAULT_FAIL_ON='Unable to run script function. Please make sure you have permission to run the script function.'

log_file="${1:-}"
label="${2:-clasp-run}"
shift 2 2>/dev/null || { echo "clasp-run-gate: missing <log-file> <label>" >&2; exit 2; }

requires=()
fail_ons=("$DEFAULT_FAIL_ON")
command_args=()
parsing_requires=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --require)
      shift
      if [ "$#" -eq 0 ]; then echo "clasp-run-gate ($label): --require needs a value" >&2; exit 2; fi
      requires+=("$1")
      ;;
    --fail-on)
      shift
      if [ "$#" -eq 0 ]; then echo "clasp-run-gate ($label): --fail-on needs a value" >&2; exit 2; fi
      fail_ons+=("$1")
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do command_args+=("$1"); shift; done
      break
      ;;
    *)
      echo "clasp-run-gate ($label): unexpected argument: $1" >&2
      echo "usage: clasp-run-gate.sh <log-file> <label> [--require s]... [--fail-on s]... -- <command> [args...]" >&2
      exit 2
      ;;
  esac
  shift
done

if [ -z "$log_file" ]; then echo "clasp-run-gate ($label): log file is required" >&2; exit 2; fi
if [ "${#command_args[@]}" -eq 0 ]; then echo "clasp-run-gate ($label): no command supplied after --" >&2; exit 2; fi
if [ "${#requires[@]}" -eq 0 ]; then echo "clasp-run-gate ($label): at least one --require is required" >&2; exit 2; fi

set +e
"${command_args[@]}" 2>&1 | tee "$log_file"
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "clasp-run-gate ($label): command exited with status $status" >&2
  exit "$status"
fi

for pattern in "${fail_ons[@]}"; do
  if grep -Fq -- "$pattern" "$log_file"; then
    echo "clasp-run-gate ($label): reported a semantic failure despite a successful process exit." >&2
    echo "matched: $pattern" >&2
    exit 1
  fi
done

for pattern in "${requires[@]}"; do
  if ! grep -Fq -- "$pattern" "$log_file"; then
    echo "clasp-run-gate ($label): did not return the expected result payload." >&2
    echo "missing required string in $log_file (value withheld when it matches an env secret)." >&2
    exit 1
  fi
done
