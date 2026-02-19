#!/bin/sh
# Carapace install script — POSIX shell, no bashisms.
# Downloads a release tarball, verifies SHA-256 checksum, extracts to
# $CARAPACE_HOME (default ~/.carapace/), pulls container image from GHCR,
# verifies cosign signature, and configures PATH.
#
# Usage:
#   curl -fsSL https://get.carapace.dev | sh
#   sh install.sh --dry-run --version v1.0.0 --runtime docker

SCRIPT_VERSION="1.0.0"

# ---------------------------------------------------------------------------
# Security hardening — must come before any file operations
# ---------------------------------------------------------------------------

umask 077
set -eu

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REPO_OWNER="fred-drake"
REPO_NAME="carapace"
IMAGE_BASE="ghcr.io/${REPO_OWNER}/carapace-agent"
GITHUB_RELEASE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases"

# ---------------------------------------------------------------------------
# Defaults (overridden by flags)
# ---------------------------------------------------------------------------

CARAPACE_HOME="${CARAPACE_HOME:-${HOME}/.carapace}"
DRY_RUN=0
YES=0
NO_MODIFY_PATH=0
REQUESTED_RUNTIME=""
REQUESTED_VERSION=""
INTERACTIVE=1

# ---------------------------------------------------------------------------
# Piped execution detection — must come before any prompts
# ---------------------------------------------------------------------------

if [ ! -t 0 ]; then
  INTERACTIVE=0
  YES=1
fi

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --yes)
      YES=1
      shift
      ;;
    --no-modify-path)
      NO_MODIFY_PATH=1
      shift
      ;;
    --runtime)
      REQUESTED_RUNTIME="$2"
      shift 2
      ;;
    --version)
      REQUESTED_VERSION="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf "Unknown option: %s\n" "$1" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Temporary directory with trap cleanup
# ---------------------------------------------------------------------------

TMPDIR_INSTALL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_INSTALL"' EXIT INT TERM

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

info() {
  printf "  %s\n" "$1"
}

success() {
  printf "  ✓ %s\n" "$1"
}

fail() {
  printf "  ✗ %s\n" "$1" >&2
}

warn() {
  printf "  ! %s\n" "$1" >&2
}

header() {
  printf "\n"
  printf "  ╭──────────────────────────────────────╮\n"
  printf "  │  Carapace Installer v%-16s │\n" "$SCRIPT_VERSION"
  printf "  │  Security-first AI agent framework   │\n"
  printf "  ╰──────────────────────────────────────╯\n"
  printf "\n"
}

usage() {
  cat <<'USAGE'
Usage: install.sh [OPTIONS]

Options:
  --dry-run          Show what would be done without making changes
  --yes              Non-interactive mode (auto-accept all prompts)
  --no-modify-path   Skip PATH modification
  --runtime TYPE     Container runtime: docker, podman, or apple
  --version VERSION  Install specific version (e.g., v1.0.0)
  --help, -h         Show this help message

Environment:
  CARAPACE_HOME      Install location (default: ~/.carapace)
  HTTPS_PROXY        Proxy for HTTPS connections
  HTTP_PROXY         Proxy for HTTP connections
USAGE
}

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Darwin)
      PLATFORM="macos"
      ;;
    Linux)
      PLATFORM="linux"
      ;;
    *)
      fail "Unsupported operating system: $OS"
      exit 1
      ;;
  esac

  case "$ARCH" in
    arm64|aarch64)
      ARCH_NAME="arm64"
      ;;
    x86_64|amd64)
      ARCH_NAME="x86_64"
      ;;
    *)
      fail "Unsupported architecture: $ARCH"
      exit 1
      ;;
  esac

  TARBALL_NAME="carapace-${PLATFORM}-${ARCH_NAME}.tar.gz"
  success "Platform: ${PLATFORM} (${ARCH_NAME})"
}

# ---------------------------------------------------------------------------
# Node.js prerequisite check
# ---------------------------------------------------------------------------

check_node() {
  if command -v node > /dev/null 2>&1; then
    NODE_VERSION="$(node --version)"
    success "Node.js ${NODE_VERSION}"
  else
    fail "Node.js is not installed"
    printf "\n"
    info "Install Node.js 22+ using one of:"
    case "$PLATFORM" in
      macos)
        if command -v brew > /dev/null 2>&1; then
          info "  brew install node@22"
        fi
        ;;
      linux)
        if command -v apt > /dev/null 2>&1; then
          info "  apt install nodejs"
        elif command -v dnf > /dev/null 2>&1; then
          info "  dnf install nodejs"
        fi
        ;;
    esac
    info "  nvm install 22"
    info "  fnm install 22"
    printf "\n"
    info "Then re-run this installer."
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Container runtime detection
# ---------------------------------------------------------------------------

detect_runtime() {
  RUNTIME=""

  if [ -n "$REQUESTED_RUNTIME" ]; then
    case "$REQUESTED_RUNTIME" in
      docker|podman|apple)
        RUNTIME="$REQUESTED_RUNTIME"
        ;;
      *)
        fail "Unknown runtime: $REQUESTED_RUNTIME (expected: docker, podman, apple)"
        exit 1
        ;;
    esac
    success "Container runtime: ${RUNTIME} (user-specified)"
    return
  fi

  # Auto-detect in security-preference order
  if [ "$PLATFORM" = "macos" ] && command -v container > /dev/null 2>&1; then
    RUNTIME="apple"
  elif command -v podman > /dev/null 2>&1; then
    RUNTIME="podman"
  elif command -v docker > /dev/null 2>&1; then
    RUNTIME="docker"
  fi

  if [ -z "$RUNTIME" ]; then
    fail "No container runtime found"
    info "Install one of: Docker, Podman, or Apple Containers (macOS 26+)"
    exit 1
  fi

  success "Container runtime: ${RUNTIME} (auto-detected)"
}

# ---------------------------------------------------------------------------
# Version resolution
# ---------------------------------------------------------------------------

resolve_version() {
  if [ -n "$REQUESTED_VERSION" ]; then
    VERSION="$REQUESTED_VERSION"
  else
    info "Fetching latest release..."
    VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest" \
      | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
    if [ -z "$VERSION" ]; then
      fail "Could not determine latest version"
      exit 1
    fi
  fi
  success "Version: ${VERSION}"
}

# ---------------------------------------------------------------------------
# Existing install detection
# ---------------------------------------------------------------------------

check_existing_install() {
  if [ -d "$CARAPACE_HOME" ] && [ -f "${CARAPACE_HOME}/version" ]; then
    INSTALLED_VERSION="$(cat "${CARAPACE_HOME}/version")"
    info "Existing installation found: v${INSTALLED_VERSION}"

    if [ "$YES" = "1" ]; then
      info "Proceeding with upgrade (--yes)"
      return 0
    fi

    printf "  Upgrade to %s? [Y/n/cancel] " "$VERSION"
    read -r answer
    case "$answer" in
      n|N|cancel|Cancel)
        info "Installation cancelled."
        exit 0
        ;;
    esac
  fi
}

# ---------------------------------------------------------------------------
# Download and verify
# ---------------------------------------------------------------------------

download_tarball() {
  TARBALL_URL="${GITHUB_RELEASE_URL}/download/${VERSION}/${TARBALL_NAME}"
  CHECKSUM_URL="${GITHUB_RELEASE_URL}/download/${VERSION}/${TARBALL_NAME}.sha256"

  info "Downloading ${TARBALL_NAME}..."

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Would download ${TARBALL_URL}"
    info "[dry-run] Would download ${CHECKSUM_URL}"
    return 0
  fi

  curl -fsSL -o "${TMPDIR_INSTALL}/${TARBALL_NAME}" "$TARBALL_URL"
  curl -fsSL -o "${TMPDIR_INSTALL}/${TARBALL_NAME}.sha256" "$CHECKSUM_URL"

  success "Downloaded ${TARBALL_NAME}"
}

verify_checksum() {
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Would verify SHA-256 checksum"
    return 0
  fi

  info "Verifying SHA-256 checksum..."

  EXPECTED_HASH="$(awk '{print $1}' "${TMPDIR_INSTALL}/${TARBALL_NAME}.sha256")"
  ACTUAL_HASH="$(shasum -a 256 "${TMPDIR_INSTALL}/${TARBALL_NAME}" | awk '{print $1}')"

  if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
    fail "Checksum verification failed — aborting"
    fail "Expected: ${EXPECTED_HASH}"
    fail "Actual:   ${ACTUAL_HASH}"
    fail "The downloaded file may have been tampered with or corrupted."
    # Cleanup is handled by trap — abort immediately (fail-closed)
    exit 1
  fi

  success "Verified checksum"
}

# ---------------------------------------------------------------------------
# Transactional install — extract to staging, verify, atomic move
# ---------------------------------------------------------------------------

install_tarball() {
  STAGING_DIR="${CARAPACE_HOME}/.installing"

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Would extract to ${CARAPACE_HOME}"
    return 0
  fi

  # Clean up any previous failed staging attempt
  rm -rf "$STAGING_DIR"
  mkdir -p "$STAGING_DIR"

  info "Extracting to staging directory..."
  tar xzf "${TMPDIR_INSTALL}/${TARBALL_NAME}" -C "$STAGING_DIR"

  # Write version marker
  printf "%s" "$VERSION" > "${STAGING_DIR}/version"

  # Create directory structure
  mkdir -p "${STAGING_DIR}/plugins"
  mkdir -p "${STAGING_DIR}/data/audit"
  mkdir -p "${STAGING_DIR}/data/memory"
  mkdir -p "${STAGING_DIR}/run/sockets"

  # Credential directory with atomic permissions (no TOCTOU race)
  install -d -m 0700 "${STAGING_DIR}/credentials"

  # Create bin wrapper
  mkdir -p "${STAGING_DIR}/bin"
  cat > "${STAGING_DIR}/bin/carapace" <<'WRAPPER'
#!/bin/sh
set -eu
CARAPACE_HOME="${CARAPACE_HOME:-${HOME}/.carapace}"
exec node "${CARAPACE_HOME}/lib/dist/cli.js" "$@"
WRAPPER
  chmod +x "${STAGING_DIR}/bin/carapace"

  # Move lib content into place
  if [ -d "${STAGING_DIR}/dist" ]; then
    mkdir -p "${STAGING_DIR}/lib"
    mv "${STAGING_DIR}/dist" "${STAGING_DIR}/lib/dist"
    if [ -d "${STAGING_DIR}/node_modules" ]; then
      mv "${STAGING_DIR}/node_modules" "${STAGING_DIR}/lib/node_modules"
    fi
    if [ -f "${STAGING_DIR}/package.json" ]; then
      mv "${STAGING_DIR}/package.json" "${STAGING_DIR}/lib/package.json"
    fi
  fi

  # Atomic move: staging → final (preserves existing user data)
  if [ -d "$CARAPACE_HOME" ] && [ ! -d "$STAGING_DIR" ]; then
    fail "Staging directory missing — rollback"
    exit 1
  fi

  # Preserve user data from existing install
  if [ -d "${CARAPACE_HOME}/plugins" ] && [ ! -d "${STAGING_DIR}/.was_existing" ]; then
    cp -r "${CARAPACE_HOME}/plugins" "${STAGING_DIR}/plugins.bak" 2>/dev/null || true
    cp -r "${CARAPACE_HOME}/data" "${STAGING_DIR}/data.bak" 2>/dev/null || true
    cp -r "${CARAPACE_HOME}/credentials" "${STAGING_DIR}/credentials.bak" 2>/dev/null || true
    if [ -f "${CARAPACE_HOME}/config.toml" ]; then
      cp "${CARAPACE_HOME}/config.toml" "${STAGING_DIR}/config.toml.bak" 2>/dev/null || true
    fi
  fi

  # Back up existing install, move staging into place
  if [ -d "$CARAPACE_HOME" ] && [ -d "${CARAPACE_HOME}/lib" ]; then
    BACKUP_DIR="${CARAPACE_HOME}.backup.$$"
    mv "$CARAPACE_HOME" "$BACKUP_DIR"
    mv "$STAGING_DIR" "$CARAPACE_HOME"
    # Restore user data
    if [ -d "${CARAPACE_HOME}/plugins.bak" ]; then
      rm -rf "${CARAPACE_HOME}/plugins"
      mv "${CARAPACE_HOME}/plugins.bak" "${CARAPACE_HOME}/plugins"
    fi
    if [ -d "${CARAPACE_HOME}/data.bak" ]; then
      rm -rf "${CARAPACE_HOME}/data"
      mv "${CARAPACE_HOME}/data.bak" "${CARAPACE_HOME}/data"
    fi
    if [ -d "${CARAPACE_HOME}/credentials.bak" ]; then
      rm -rf "${CARAPACE_HOME}/credentials"
      mv "${CARAPACE_HOME}/credentials.bak" "${CARAPACE_HOME}/credentials"
    fi
    if [ -f "${CARAPACE_HOME}/config.toml.bak" ]; then
      mv "${CARAPACE_HOME}/config.toml.bak" "${CARAPACE_HOME}/config.toml"
    fi
    rm -rf "$BACKUP_DIR"
  else
    mkdir -p "$(dirname "$CARAPACE_HOME")"
    mv "$STAGING_DIR" "$CARAPACE_HOME"
  fi

  success "Extracted to ${CARAPACE_HOME}"
}

# ---------------------------------------------------------------------------
# Container image pull + cosign verification
# ---------------------------------------------------------------------------

pull_container_image() {
  IMAGE="${IMAGE_BASE}:${VERSION}"

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Would pull ${IMAGE}"
    info "[dry-run] Would verify cosign signature"
    return 0
  fi

  info "Pulling container image..."

  # Build proxy args for container runtime
  PROXY_ARGS=""
  if [ -n "${HTTPS_PROXY:-}" ]; then
    PROXY_ARGS="-e HTTPS_PROXY=${HTTPS_PROXY}"
  fi
  if [ -n "${HTTP_PROXY:-}" ]; then
    PROXY_ARGS="${PROXY_ARGS} -e HTTP_PROXY=${HTTP_PROXY}"
  fi

  case "$RUNTIME" in
    docker)
      docker pull "$IMAGE" || {
        fail "Failed to pull container image"
        fail "Partial install — rolling back"
        rm -rf "${CARAPACE_HOME}/.installing"
        exit 1
      }
      ;;
    podman)
      podman pull "$IMAGE" || {
        fail "Failed to pull container image"
        fail "Partial install — rolling back"
        rm -rf "${CARAPACE_HOME}/.installing"
        exit 1
      }
      ;;
    apple)
      container pull "$IMAGE" || {
        fail "Failed to pull container image"
        fail "Partial install — rolling back"
        rm -rf "${CARAPACE_HOME}/.installing"
        exit 1
      }
      ;;
  esac

  success "Pulled ${IMAGE}"

  # Verify cosign signature
  info "Verifying container image signature..."
  if command -v cosign > /dev/null 2>&1; then
    cosign verify --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
      --certificate-identity-regexp="github\\.com/${REPO_OWNER}/${REPO_NAME}" \
      "$IMAGE" > /dev/null 2>&1 || {
        warn "Cosign signature verification failed — image may not be signed"
      }
    success "Image signature verified (cosign)"
  else
    warn "cosign not found — skipping image signature verification"
    info "Install cosign for image verification: https://docs.sigstore.dev/cosign/system_config/installation/"
  fi

  # Extract and store image digest
  case "$RUNTIME" in
    docker)
      IMAGE_DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || echo "")"
      ;;
    podman)
      IMAGE_DIGEST="$(podman inspect --format='{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || echo "")"
      ;;
    *)
      IMAGE_DIGEST=""
      ;;
  esac

  if [ -n "$IMAGE_DIGEST" ]; then
    success "Image digest: ${IMAGE_DIGEST}"
  fi
}

# ---------------------------------------------------------------------------
# PATH configuration
# ---------------------------------------------------------------------------

configure_path() {
  BIN_DIR="${CARAPACE_HOME}/bin"

  if [ "$NO_MODIFY_PATH" = "1" ]; then
    info "Skipping PATH modification (--no-modify-path)"
    info "Add to your PATH manually: export PATH=\"${BIN_DIR}:\$PATH\""
    return 0
  fi

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Would add ${BIN_DIR} to PATH"
    return 0
  fi

  PATH_LINE="export PATH=\"${BIN_DIR}:\$PATH\""
  FISH_PATH_CMD="fish_add_path ${BIN_DIR}"
  PATH_MODIFIED=0

  # Determine shell config files based on platform
  case "$PLATFORM" in
    macos)
      BASH_CONFIG="${HOME}/.bash_profile"
      ;;
    linux)
      BASH_CONFIG="${HOME}/.bashrc"
      ;;
  esac
  ZSH_CONFIG="${HOME}/.zshrc"
  FISH_CONFIG="${HOME}/.config/fish/config.fish"

  # Bash
  if [ -f "$BASH_CONFIG" ] || command -v bash > /dev/null 2>&1; then
    if [ -f "$BASH_CONFIG" ] && grep -q "$BIN_DIR" "$BASH_CONFIG" 2>/dev/null; then
      info "PATH already configured in ${BASH_CONFIG}"
    else
      if [ "$INTERACTIVE" = "1" ] && [ "$YES" != "1" ]; then
        printf "  Add to %s? [Y/n] " "$BASH_CONFIG"
        read -r answer
        case "$answer" in
          n|N) ;;
          *)
            printf "\n# Carapace\n%s\n" "$PATH_LINE" >> "$BASH_CONFIG"
            PATH_MODIFIED=1
            ;;
        esac
      else
        printf "\n# Carapace\n%s\n" "$PATH_LINE" >> "$BASH_CONFIG"
        PATH_MODIFIED=1
      fi
    fi
  fi

  # Zsh
  if [ -f "$ZSH_CONFIG" ] || command -v zsh > /dev/null 2>&1; then
    if [ -f "$ZSH_CONFIG" ] && grep -q "$BIN_DIR" "$ZSH_CONFIG" 2>/dev/null; then
      info "PATH already configured in ${ZSH_CONFIG}"
    else
      if [ "$INTERACTIVE" = "1" ] && [ "$YES" != "1" ]; then
        printf "  Add to %s? [Y/n] " "$ZSH_CONFIG"
        read -r answer
        case "$answer" in
          n|N) ;;
          *)
            printf "\n# Carapace\n%s\n" "$PATH_LINE" >> "$ZSH_CONFIG"
            PATH_MODIFIED=1
            ;;
        esac
      else
        printf "\n# Carapace\n%s\n" "$PATH_LINE" >> "$ZSH_CONFIG"
        PATH_MODIFIED=1
      fi
    fi
  fi

  # Fish
  if command -v fish > /dev/null 2>&1; then
    if [ -f "$FISH_CONFIG" ] && grep -q "$BIN_DIR" "$FISH_CONFIG" 2>/dev/null; then
      info "PATH already configured in ${FISH_CONFIG}"
    else
      mkdir -p "$(dirname "$FISH_CONFIG")"
      if [ "$INTERACTIVE" = "1" ] && [ "$YES" != "1" ]; then
        printf "  Add to %s? [Y/n] " "$FISH_CONFIG"
        read -r answer
        case "$answer" in
          n|N) ;;
          *)
            printf "\n# Carapace\n%s\n" "$FISH_PATH_CMD" >> "$FISH_CONFIG"
            PATH_MODIFIED=1
            ;;
        esac
      else
        printf "\n# Carapace\n%s\n" "$FISH_PATH_CMD" >> "$FISH_CONFIG"
        PATH_MODIFIED=1
      fi
    fi
  fi

  if [ "$PATH_MODIFIED" = "1" ]; then
    success "Added to PATH"
  fi
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

show_summary() {
  printf "\n"
  success "Carapace ${VERSION} installed!"
  printf "\n"
  info "Next steps:"
  info "  \$ carapace doctor    # verify setup"
  info "  \$ carapace start     # launch"
  printf "\n"

  if [ "$PATH_MODIFIED" = "1" ] 2>/dev/null || [ "${PATH_MODIFIED:-0}" = "1" ]; then
    info "Restart your shell or run:"
    info "  source ${BASH_CONFIG:-~/.bashrc}"
    printf "\n"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  header

  # Non-interactive notice
  if [ "$INTERACTIVE" = "0" ]; then
    warn "Running in non-interactive mode (piped execution detected)."
    info "For verified install, download and verify the script first:"
    info "  curl -fsSL -o install.sh ${GITHUB_RELEASE_URL}/latest/download/install.sh"
    printf "\n"
  fi

  info "Detecting system..."
  detect_platform
  check_node
  printf "\n"

  info "Checking container runtime..."
  detect_runtime
  printf "\n"

  resolve_version
  check_existing_install
  printf "\n"

  info "Installing Carapace..."
  download_tarball
  verify_checksum
  install_tarball
  printf "\n"

  info "Pulling container image..."
  pull_container_image
  printf "\n"

  info "Configuring PATH..."
  configure_path
  printf "\n"

  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] Installation complete (no changes made)"
  else
    show_summary
  fi
}

main
