#!/bin/sh
set -eu

umask 077
base=/tmp/ct-runtime
mkdir -p \
  "$base/home" \
  "$base/xdg/config" \
  "$base/xdg/cache" \
  "$base/xdg/data" \
  "$base/tmp" \
  "$base/results" \
  "$base/workspace"

exec node /app/bin/ct-runtime.mjs "$@"
