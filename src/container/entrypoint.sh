#!/bin/sh
# Carapace container entrypoint — credential injection via stdin.
#
# Reads credentials from stdin in the format:
#   NAME=VALUE
#   NAME=VALUE
#   (empty line = done)
#
# Exports each as an environment variable, then exec's into Claude Code.
# Credentials never appear in docker inspect, Dockerfile, or mounted files.

set -eu

# ---------------------------------------------------------------------------
# Read credentials from stdin
# ---------------------------------------------------------------------------

while IFS= read -r line; do
  # Empty line signals end of credentials
  [ -z "$line" ] && break

  # Split on first '=' to get name and value
  name="${line%%=*}"
  value="${line#*=}"

  # Export as environment variable
  export "$name=$value"
done

# ---------------------------------------------------------------------------
# Close stdin to prevent credential leakage to child process
# ---------------------------------------------------------------------------

exec < /dev/null

# ---------------------------------------------------------------------------
# Exec into Claude Code
# ---------------------------------------------------------------------------

if [ -n "${CARAPACE_TASK_PROMPT:-}" ]; then
  # Task-triggered session: run prompt in non-interactive mode (-p)
  # Always add --output-format stream-json and --verbose for non-interactive
  set -- --dangerously-skip-permissions -p "$CARAPACE_TASK_PROMPT" \
    --output-format stream-json --verbose

  if [ -n "${CARAPACE_RESUME_SESSION:-}" ]; then
    set -- "$@" --resume "$CARAPACE_RESUME_SESSION"
  fi

  exec claude "$@"
else
  # Interactive session (no task prompt)
  if [ -n "${CARAPACE_RESUME_SESSION:-}" ]; then
    exec claude --dangerously-skip-permissions --resume "$CARAPACE_RESUME_SESSION" "$@"
  else
    exec claude --dangerously-skip-permissions "$@"
  fi
fi
