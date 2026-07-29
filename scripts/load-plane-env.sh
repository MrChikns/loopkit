#!/usr/bin/env bash
#
# load-plane-env.sh — source the plane's operator-controlled environment and export every
# assignment to child processes.
#
# This file MUST be sourced by a beat or console launcher:
#
#   source /path/to/loopkit/scripts/load-plane-env.sh
#   exec node ...
#
# Plain `NAME=value` assignments in a sourced file are shell-local by default. Without the
# temporary `allexport` below, Node sees the variable as unset and the console can report a
# halted plane while separately launched beats are armed.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo "load-plane-env.sh must be sourced by a launcher, not executed" >&2
  exit 2
fi

_loopkit_load_plane_env() {
  local env_file had_allexport=0 source_status

  if [[ -n "${LOOPKIT_ENV_FILE:-}" ]]; then
    env_file="$LOOPKIT_ENV_FILE"
  elif [[ -n "${LOOPKIT_HOME:-}" && -f "$LOOPKIT_HOME/config/autonomy.env" ]]; then
    env_file="$LOOPKIT_HOME/config/autonomy.env"
  else
    env_file=".ai/loops/config.env"
  fi

  if [[ ! -r "$env_file" ]]; then
    echo "loopkit: plane environment is not readable: $env_file" >&2
    return 1
  fi

  [[ "$-" == *a* ]] && had_allexport=1
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  source_status=$?
  [[ "$had_allexport" -eq 1 ]] || set +a
  return "$source_status"
}

_loopkit_load_plane_env
_loopkit_load_plane_env_status=$?
unset -f _loopkit_load_plane_env
return "$_loopkit_load_plane_env_status"
