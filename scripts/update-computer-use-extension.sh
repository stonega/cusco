#!/usr/bin/env sh
set -eu

uuid='cusco-computer-use@stonega'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
source_dir="$repo_root/data/gnome-shell/extensions/$uuid"
output_dir=${CUSCO_EXTENSION_OUTPUT_DIR:-"$repo_root/builddir/gnome-shell-extension"}
bundle="$output_dir/$uuid.shell-extension.zip"
mode='update'

usage() {
  printf 'Usage: %s [--build-only]\n' "$0"
  printf '\n'
  printf 'Builds only the Cusco GNOME Shell extension. By default, the resulting\n'
  printf 'bundle is also installed as an update for the current user.\n'
}

case ${1:-} in
  '')
    ;;
  --build-only)
    mode='build'
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

if ! command -v gnome-extensions >/dev/null 2>&1; then
  printf 'gnome-extensions is required to package and install the extension.\n' >&2
  exit 1
fi

if [ ! -f "$source_dir/metadata.json" ] \
  || [ ! -f "$source_dir/extension.js" ] \
  || [ ! -f "$source_dir/keyNames.js" ] \
  || [ ! -f "$source_dir/indicatorStatus.js" ] \
  || [ ! -f "$source_dir/windowFocus.js" ] \
  || [ ! -f "$source_dir/computer-use-active-symbolic.svg" ]; then
  printf 'Computer-use extension sources are incomplete: %s\n' "$source_dir" >&2
  exit 1
fi

mkdir -p "$output_dir"
(
  CDPATH= cd -- "$source_dir"
  gnome-extensions pack \
    --force \
    --out-dir="$output_dir" \
    --extra-source=keyNames.js \
    --extra-source=indicatorStatus.js \
    --extra-source=windowFocus.js \
    --extra-source=computer-use-active-symbolic.svg \
    .
)

if [ ! -f "$bundle" ]; then
  printf 'Expected extension bundle was not created: %s\n' "$bundle" >&2
  exit 1
fi

printf 'Built %s\n' "$bundle"

if [ "$mode" = 'build' ]; then
  exit 0
fi

gnome-extensions install --force "$bundle"
printf 'Updated %s for the current user.\n' "$uuid"
printf '\n'
printf 'To load the updated code on GNOME Wayland:\n'
printf '  1. Fully log out of GNOME and log back in.\n'
printf '  2. Run: gnome-extensions enable %s\n' "$uuid"
printf '  3. Restart Cusco.\n'
