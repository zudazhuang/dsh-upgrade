#!/bin/sh
# Launch the supported Web profile through its version-switch supervisor.
plugin_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$plugin_dir/supervisor.mjs" "${DSH_SOURCE:-$plugin_dir/../deepseek-harness}" "${DSH_HOME:-$HOME/.dsh}" "${DSH_SAFE_UPDATE_ROOT:-$HOME/.local/share/dsh-safe-release-update}"
