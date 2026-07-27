#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
build_dir="$repo_root/builddir"
install_prefix="$HOME/.local"

usage() {
  printf 'Usage: %s\n' "$0"
  printf '\nBuilds and installs Cusco for the current user under %s.\n' "$install_prefix"
}

case ${1:-} in
  '')
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

if [ "$(id -u)" -eq 0 ]; then
  printf 'Do not run this installer as root or with sudo.\n' >&2
  printf 'Run it as the desktop user who will use Cusco.\n' >&2
  exit 1
fi

for command in meson ninja; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf '%s is required to build and install Cusco.\n' "$command" >&2
    exit 1
  fi
done

if [ -d "$build_dir/meson-private" ]; then
  meson setup --reconfigure "$build_dir" --prefix "$install_prefix"
else
  meson setup "$build_dir" --prefix "$install_prefix"
fi

meson compile -C "$build_dir"
meson install -C "$build_dir" --no-rebuild

printf '\nCusco was installed for the current user in %s.\n' "$install_prefix"
printf 'No system-wide files were changed.\n'

case ":$PATH:" in
  *":$install_prefix/bin:"*)
    printf 'Run Cusco with: cusco\n'
    ;;
  *)
    printf 'Run Cusco with: %s/bin/cusco\n' "$install_prefix"
    printf 'Add %s/bin to PATH to use the shorter command.\n' "$install_prefix"
    ;;
esac

printf '\nFully log out of GNOME and log back in after the first install so GNOME\n'
printf 'can discover the bundled computer-use extension.\n'
