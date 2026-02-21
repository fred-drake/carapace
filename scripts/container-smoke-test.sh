#!/bin/bash
# Container smoke test for Carapace agent image.
#
# Validates security constraints enforced by the container:
#   1. Filesystem is read-only (except /workspace, /run/zmq, /tmp)
#   2. Network is unreachable (--network none)
#   3. The ipc binary is available in PATH
#   4. Container runs as non-root user
#
# Usage: ./scripts/container-smoke-test.sh <image-name>
# Exit code: 0 on success, 1 on any failure.

set -euo pipefail

IMAGE="${1:?Usage: $0 <image-name>}"
CONTAINER_NAME="carapace-smoke-$$"
PASSED=0
FAILED=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

pass() {
  echo "  PASS: $1"
  PASSED=$((PASSED + 1))
}

fail() {
  echo "  FAIL: $1"
  FAILED=$((FAILED + 1))
}

run_in_container() {
  docker exec "$CONTAINER_NAME" "$@"
}

# ---------------------------------------------------------------------------
# Setup: start container with security constraints
# ---------------------------------------------------------------------------

echo "Starting container from image: $IMAGE"
docker run -d \
  --name "$CONTAINER_NAME" \
  --read-only \
  --network none \
  --tmpfs /tmp:rw,noexec,nosuid \
  --entrypoint sleep \
  "$IMAGE" \
  300

# Give the container a moment to start
sleep 1

echo ""
echo "Running smoke tests..."
echo ""

# ---------------------------------------------------------------------------
# Test 1: Filesystem is read-only
# ---------------------------------------------------------------------------

echo "--- Filesystem checks ---"

# Root filesystem should be read-only
if run_in_container touch /test-file 2>/dev/null; then
  fail "Root filesystem is writable (touch /test-file succeeded)"
  run_in_container rm -f /test-file 2>/dev/null || true
else
  pass "Root filesystem is read-only"
fi

# /workspace should be writable
if run_in_container touch /workspace/test-file 2>/dev/null; then
  run_in_container rm -f /workspace/test-file 2>/dev/null || true
  pass "/workspace is writable"
else
  fail "/workspace is not writable"
fi

# /run/zmq should be writable
if run_in_container touch /run/zmq/test-file 2>/dev/null; then
  run_in_container rm -f /run/zmq/test-file 2>/dev/null || true
  pass "/run/zmq is writable"
else
  fail "/run/zmq is not writable"
fi

# /tmp should be writable
if run_in_container touch /tmp/test-file 2>/dev/null; then
  run_in_container rm -f /tmp/test-file 2>/dev/null || true
  pass "/tmp is writable"
else
  fail "/tmp is not writable"
fi

# /app should be read-only
if run_in_container touch /app/test-file 2>/dev/null; then
  fail "/app is writable (should be read-only)"
  run_in_container rm -f /app/test-file 2>/dev/null || true
else
  pass "/app is read-only"
fi

# ---------------------------------------------------------------------------
# Test 2: Network is unreachable
# ---------------------------------------------------------------------------

echo ""
echo "--- Network checks ---"

# ping should fail (no network)
if run_in_container ping -c 1 -W 2 8.8.8.8 2>/dev/null; then
  fail "Network is reachable (ping 8.8.8.8 succeeded)"
else
  pass "Network is unreachable (ping failed as expected)"
fi

# ---------------------------------------------------------------------------
# Test 3: IPC binary is available
# ---------------------------------------------------------------------------

echo ""
echo "--- Binary checks ---"

if run_in_container command -v ipc 2>/dev/null; then
  pass "ipc binary is in PATH"
else
  fail "ipc binary is not in PATH"
fi

# ---------------------------------------------------------------------------
# Test 4: Non-root user
# ---------------------------------------------------------------------------

echo ""
echo "--- User checks ---"

CONTAINER_USER=$(run_in_container whoami 2>/dev/null || echo "unknown")
if [ "$CONTAINER_USER" != "root" ] && [ "$CONTAINER_USER" != "unknown" ]; then
  pass "Running as non-root user: $CONTAINER_USER"
else
  fail "Running as root or unknown user: $CONTAINER_USER"
fi

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

echo ""
echo "Cleaning up..."
docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "=== Smoke Test Results ==="
echo "  Passed: $PASSED"
echo "  Failed: $FAILED"
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo "SMOKE TEST FAILED"
  exit 1
fi

echo "SMOKE TEST PASSED"
exit 0
