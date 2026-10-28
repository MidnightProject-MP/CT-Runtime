#!/bin/sh
set -eu
if [ "$#" -lt 2 ]; then
  echo "usage: vnext-read-only-exec.sh WORKSPACE COMMAND [ARG...]" >&2
  exit 2
fi
workspace=$1
shift
if [ ! -d "$workspace" ]; then
  echo "workspace is not a directory" >&2
  exit 2
fi
exec unshare --user --map-root-user --mount --propagation private /bin/sh -c '
set -eu
workspace=$1
shift
if [ ! -d "$workspace" ]; then
  echo "workspace is not a directory" >&2
  exit 2
fi
mount --bind "$workspace" "$workspace"
mount -o remount,bind,ro "$workspace"
exec "$@"
' vnext-read-only-exec "$workspace" "$@"
