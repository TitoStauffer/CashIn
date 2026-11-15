#!/bin/sh
# Development entrypoint of the API container (compose.yaml).
#
# node_modules lives in a named volume, so it survives image rebuilds: after a dependency change, the
# rebuilt image has the new packages but the volume still holds the old ones, and the API fails with
# ERR_MODULE_NOT_FOUND. The image records the hash of the package-lock.json it installed; when the
# mounted lockfile no longer matches, the dependencies are reinstalled before the API starts.
set -eu

stamp=node_modules/.package-lock.sha256
current=$(sha256sum package-lock.json | cut -d ' ' -f 1)

if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$current" ]; then
  echo "package-lock.json changed since node_modules was installed; running npm ci"
  npm ci
  echo "$current" > "$stamp"
fi

exec npm run dev
