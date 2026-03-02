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
# API mode: start claude-cli-api server
# ---------------------------------------------------------------------------

if [ "${CARAPACE_API_MODE:-}" = "1" ]; then
  # Read API key from file and export, then delete the file.
  # The bearer token IS visible in the container's process environment —
  # this is acceptable since the container is the consumer. The file is
  # deleted to avoid duplicate persistence.
  if [ -f "${CARAPACE_API_KEY_FILE:-}" ]; then
    API_KEY="$(cat "$CARAPACE_API_KEY_FILE")"
    if [ -z "$API_KEY" ]; then
      echo "ERROR: API key file was empty" >&2
      exit 1
    fi
    export API_KEY
    rm -f "$CARAPACE_API_KEY_FILE"
  fi

  # Guard: even if the file-read block was skipped (file missing), API_KEY must
  # be set for claude-cli-api to authenticate requests.
  if [ -z "${API_KEY:-}" ]; then
    echo "ERROR: API_KEY not set (key file missing or unreadable)" >&2
    exit 1
  fi

  # Unset the key file path so child processes can't discover it
  unset CARAPACE_API_KEY_FILE

  # MAX_CONCURRENT_PROCESSES is set by the lifecycle manager via env vars —
  # the host is the single source of truth for concurrency limits.

  exec node /app/node_modules/claude-cli-api/dist/index.js
fi

# ---------------------------------------------------------------------------
# Exec into Claude Code (legacy direct-exec mode)
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
