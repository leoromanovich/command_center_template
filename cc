#!/usr/bin/env bash
set -euo pipefail

cc_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  printf '%s\n' \
    'Usage: ./cc <command> [arguments]' \
    '' \
    'Commands:' \
    '  doctor         Check local prerequisites' \
    '  show           Show flake packages, checks and apps' \
    '  check          Evaluate and build every flake check' \
    '  build <name>   Build .#<name>' \
    '  run <name>     Run .#<name>' \
    '  validate       Validate the Markdown knowledge graph' \
    '  bootstrap install [target]  Materialize a new CC from this clone' \
    '  bootstrap validate          Validate the configured CC contract' \
    '  repo <add|list|show|set-status> ...' \
    '  worktree <create|add|status|remove> ...' \
    '  plan <create|list|show|accept|reflect|archive|complete> ...' \
    '  feature <name> <show|check|build|run> ...  Use feature input overrides'
}

require_nix() {
  if ! command -v nix >/dev/null 2>&1; then
    printf '%s\n' 'error: Nix is not installed; see https://nixos.org/download/' >&2
    exit 1
  fi
}

nix_override_args=()
load_feature_overrides() {
  if [[ -z "${CC_FEATURE:-}" ]]; then
    return
  fi
  override_output="$(python3 "$cc_root/scripts/worktrees.py" "$cc_root" nix-args "$CC_FEATURE")"
  if [[ -n "$override_output" ]]; then
    while IFS= read -r argument; do
      nix_override_args+=("$argument")
    done <<< "$override_output"
  fi
}

command_name="${1:-help}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$command_name" in
  doctor)
    require_nix
    nix --version
    if command -v docker >/dev/null 2>&1; then
      docker --version
    elif command -v podman >/dev/null 2>&1; then
      podman --version
    else
      printf '%s\n' 'note: Docker/Podman is absent; container E2E apps will be unavailable'
    fi
    ;;
  show)
    require_nix
    load_feature_overrides
    exec nix --extra-experimental-features 'nix-command flakes' flake show ${nix_override_args[@]+"${nix_override_args[@]}"} "$cc_root" "$@"
    ;;
  check)
    require_nix
    load_feature_overrides
    exec nix --extra-experimental-features 'nix-command flakes' flake check ${nix_override_args[@]+"${nix_override_args[@]}"} "$cc_root" --keep-going "$@"
    ;;
  build)
    require_nix
    target="${1:?usage: ./cc build <name>}"
    shift
    load_feature_overrides
    exec nix --extra-experimental-features 'nix-command flakes' build ${nix_override_args[@]+"${nix_override_args[@]}"} "${cc_root}#$target" "$@"
    ;;
  run)
    require_nix
    target="${1:?usage: ./cc run <name>}"
    shift
    load_feature_overrides
    export CC_ROOT="$cc_root"
    exec nix --extra-experimental-features 'nix-command flakes' run ${nix_override_args[@]+"${nix_override_args[@]}"} "${cc_root}#$target" -- "$@"
    ;;
  validate)
    exec python3 "$cc_root/scripts/validate-knowledge.py" "$cc_root"
    ;;
  bootstrap)
    bootstrap_command="${1:-help}"
    if [[ $# -gt 0 ]]; then
      shift
    fi
    case "$bootstrap_command" in
      install)
        exec python3 "$cc_root/scripts/materialize-template.py" "${1:-.}"
        ;;
      validate)
        exec python3 "$cc_root/scripts/validate-control-center.py" "$cc_root"
        ;;
      *)
        printf '%s\n' 'usage: ./cc bootstrap <install [target]|validate>' >&2
        exit 2
        ;;
    esac
    ;;
  repo)
    exec python3 "$cc_root/scripts/repositories.py" "$cc_root" "$@"
    ;;
  worktree)
    exec python3 "$cc_root/scripts/worktrees.py" "$cc_root" "$@"
    ;;
  plan)
    exec python3 "$cc_root/scripts/plans.py" "$cc_root" "$@"
    ;;
  feature)
    feature_name="${1:?usage: ./cc feature <name> <show|check|build|run> [arguments]}"
    shift
    if [[ $# -eq 0 ]]; then
      printf '%s\n' 'error: feature requires a command' >&2
      exit 2
    fi
    export CC_FEATURE="$feature_name"
    exec "$cc_root/cc" "$@"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    printf 'error: unknown command: %s\n' "$command_name" >&2
    usage >&2
    exit 2
    ;;
esac
