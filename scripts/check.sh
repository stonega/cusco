#!/usr/bin/env sh
set -eu

gjs -m tests/import-smoke.js
gjs -m tests/mock-provider-smoke.js

if command -v meson >/dev/null 2>&1; then
  if [ -d builddir ]; then
    meson setup builddir --wipe
  else
    meson setup builddir
  fi
  meson compile -C builddir
fi
