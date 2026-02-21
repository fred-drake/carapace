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

if [ -n "${CARAPACE_RESUME_SESSION_ID:-}" ]; then
  # Security: validate session ID is UUID format before passing to --resume.
  # Defense-in-depth: prevents argument injection via malformed session IDs.
  case "$CARAPACE_RESUME_SESSION_ID" in
    [0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]-[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F])
      VALIDATED_RESUME_SESSION="$CARAPACE_RESUME_SESSION_ID"
      ;;
    *)
      echo "WARN: Invalid CARAPACE_RESUME_SESSION_ID format, ignoring: must be UUID" >&2
      VALIDATED_RESUME_SESSION=""
      ;;
  esac
else
  VALIDATED_RESUME_SESSION=""
fi

if [ -n "${CARAPACE_TASK_PROMPT:-}" ]; then
  # Task-triggered session: run prompt in non-interactive mode (-p)
  # Always add --output-format stream-json and --verbose for non-interactive
  set -- --dangerously-skip-permissions -p "$CARAPACE_TASK_PROMPT" \
    --output-format stream-json --verbose

  if [ -n "$VALIDATED_RESUME_SESSION" ]; then
    set -- "$@" --resume "$VALIDATED_RESUME_SESSION"
  fi

  exec claude "$@"
else
  # Interactive session (no task prompt)
  if [ -n "$VALIDATED_RESUME_SESSION" ]; then
    exec claude --dangerously-skip-permissions --resume "$VALIDATED_RESUME_SESSION" "$@"
  else
    exec claude --dangerously-skip-permissions "$@"
  fi
fi
