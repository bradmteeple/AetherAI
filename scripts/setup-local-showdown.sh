#!/usr/bin/env bash
# Clones and builds the current Pokémon Showdown server into .showdown/ for
# local end-to-end testing (and for exact local team validation).
set -euo pipefail
DIR="${SHOWDOWN_DIR:-$(cd "$(dirname "$0")/.." && pwd)/.showdown}"
REF="${SHOWDOWN_REF:-master}"
if [ ! -d "$DIR/.git" ]; then
  echo "Cloning smogon/pokemon-showdown into $DIR ..."
  git clone --depth 1 --branch "$REF" https://github.com/smogon/pokemon-showdown.git "$DIR"
else
  echo "Updating $DIR ..."
  git -C "$DIR" fetch --depth 1 origin "$REF" && git -C "$DIR" reset --hard FETCH_HEAD
fi
cd "$DIR"
echo "Installing dependencies ..."
npm install --no-audit --no-fund
echo "Building ..."
node build
if [ ! -f config/config.js ]; then cp config/config-example.js config/config.js; fi
echo "Showdown ready at $DIR (commit $(git rev-parse --short HEAD))"
echo "Start a test server with: node pokemon-showdown start --no-security"
