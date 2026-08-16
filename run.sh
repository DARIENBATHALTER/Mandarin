#!/bin/bash
# Build the world if it is missing, then serve it.
set -e
cd "$(dirname "$0")"
if [ ! -f web/world/meta.json ]; then
  echo "no world built, running pipeline..."
  (cd tools && python3 fetch.py && python3 build_world.py)
fi
[ -d web/node_modules ] || (cd web && npm i three @dimforge/rapier3d-compat)
exec python3 serve.py "${1:-8099}"
