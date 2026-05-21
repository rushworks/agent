#!/usr/bin/env sh
# RushworksAI agent installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/rushworks/agent/main/install.sh | sh
#
# What this does:
#   1. Detects OS + checks prereqs (git, node >= 20)
#   2. Clones rushworks/agent into ~/rushworks/agent-cli/
#      (or skips if already present)
#   3. Runs `npm install --omit=dev` in that directory
#   4. Invokes `rushworks-agent init --workspace ~/rushworks/agents/<name>`
#      interactively so the new workspace is ready to start
#   5. Prints next-step
#
# Re-run the script to add another agent on the same host. The clone +
# npm install steps are skipped; only the workspace wizard runs.
#
# Exit codes:
#   0  success
#   1  unsupported OS
#   2  missing prerequisite the user must install themselves
#   3  download / clone failure
#   4  install (npm) failure
#   5  wizard failure

set -eu

# ─── colors (only when stdout is a tty) ─────────────────────────────
if [ -t 1 ]; then
  C_RED=$(printf '\033[0;31m')
  C_GREEN=$(printf '\033[0;32m')
  C_YELLOW=$(printf '\033[0;33m')
  C_DIM=$(printf '\033[2m')
  C_BOLD=$(printf '\033[1m')
  C_RESET=$(printf '\033[0m')
else
  C_RED=''; C_GREEN=''; C_YELLOW=''; C_DIM=''; C_BOLD=''; C_RESET=''
fi

say()   { printf '%s\n' "$*"; }
info()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok()    { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail()  { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
hdr()   { printf '\n%s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }

# ─── 0. banner ──────────────────────────────────────────────────────
hdr "RUSHWORKS.AI agent installer"
info "rushworks-agent — Claude (and others) as a first-class teammate"

# ─── 1. OS detection ────────────────────────────────────────────────
OS=$(uname -s 2>/dev/null || printf 'unknown')
case "$OS" in
  Darwin)  PLATFORM=macos ;;
  Linux)   PLATFORM=linux ;;
  MINGW*|MSYS*|CYGWIN*)
    fail "Windows native shells aren't supported. Use WSL (Linux subsystem) or clone the repo and run 'npm install' by hand."
    exit 1
    ;;
  *)
    fail "Unsupported OS: $OS. Supported: macOS, Linux."
    exit 1
    ;;
esac
ok "Platform: $PLATFORM"

# ─── 2. prereqs ─────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

missing=''
have git  || missing="$missing git"
have node || missing="$missing node"
have npm  || missing="$missing npm"

if [ -n "$missing" ]; then
  fail "Missing prerequisites:$missing"
  case "$PLATFORM" in
    macos) info "Install Homebrew (https://brew.sh), then: brew install git node" ;;
    linux) info "Install via your package manager. Debian/Ubuntu: sudo apt install git nodejs npm" ;;
  esac
  exit 2
fi

# Check Node version (need >= 20).
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node).split(".")[0])' 2>/dev/null || printf '0')
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node 20+ required. Found: $(node --version)"
  case "$PLATFORM" in
    macos) info "Update via Homebrew: brew upgrade node" ;;
    linux) info "Update via nvm (recommended): https://github.com/nvm-sh/nvm" ;;
  esac
  exit 2
fi
ok "Node: $(node --version)"
ok "git: $(git --version | awk '{print $3}')"

# ─── 3. clone or update ─────────────────────────────────────────────
RUSHWORKS_ROOT="$HOME/rushworks"
AGENT_CLI_DIR="$RUSHWORKS_ROOT/agent-cli"
AGENTS_DIR="$RUSHWORKS_ROOT/agents"
REPO_URL="https://github.com/rushworks/agent.git"

mkdir -p "$RUSHWORKS_ROOT"

if [ -d "$AGENT_CLI_DIR/.git" ]; then
  hdr "Agent already installed — checking for updates"
  if ! git -C "$AGENT_CLI_DIR" pull --ff-only 2>&1; then
    warn "Could not fast-forward $AGENT_CLI_DIR. Leaving it as is; if you've made local changes, sort them out and re-run."
  else
    ok "Agent updated"
  fi
  SKIP_NPM_INSTALL=''
elif [ -e "$AGENT_CLI_DIR" ]; then
  fail "$AGENT_CLI_DIR exists but isn't a git checkout. Move it aside and re-run."
  exit 3
else
  hdr "Cloning rushworks/agent into $AGENT_CLI_DIR"
  if ! git clone --depth 1 "$REPO_URL" "$AGENT_CLI_DIR"; then
    fail "git clone failed."
    exit 3
  fi
  ok "Cloned"
  SKIP_NPM_INSTALL=''
fi

# ─── 4. npm install ─────────────────────────────────────────────────
if [ -z "${SKIP_NPM_INSTALL:-}" ]; then
  hdr "Installing dependencies"
  if ! ( cd "$AGENT_CLI_DIR" && npm install --omit=dev --no-fund --no-audit ); then
    fail "npm install failed."
    exit 4
  fi
  ok "Dependencies installed"
fi

# ─── 5. workspace setup ─────────────────────────────────────────────
hdr "Set up your first agent workspace"

# RW_AGENT_NAME / RW_AGENT_TOKEN can be pre-set by the operator (the
# portal renders an install command with both baked in). When set, we
# skip the corresponding prompts. RW_AGENT_TOKEN is inherited by the
# wizard process for free — install.sh just needs to handle the name.
if [ -n "${RW_AGENT_NAME:-}" ]; then
  WORKSPACE_NAME=$(printf '%s' "$RW_AGENT_NAME" | tr -d '[:space:]')
  info "Using workspace name from RW_AGENT_NAME: $WORKSPACE_NAME"
else
  # Default name suggestion: if no existing workspaces, suggest "agent-1";
  # otherwise the next agent-N that doesn't exist yet.
  suggested='agent-1'
  if [ -d "$AGENTS_DIR" ]; then
    i=1
    while [ -d "$AGENTS_DIR/agent-$i" ]; do
      i=$((i + 1))
    done
    suggested="agent-$i"
  fi
  printf "Workspace name [%s]: " "$suggested"
  if [ -r /dev/tty ]; then
    read -r WORKSPACE_NAME < /dev/tty
  else
    read -r WORKSPACE_NAME
  fi
  WORKSPACE_NAME=${WORKSPACE_NAME:-$suggested}
  WORKSPACE_NAME=$(printf '%s' "$WORKSPACE_NAME" | tr -d '[:space:]')
fi

# Reject obvious bad input.
case "$WORKSPACE_NAME" in
  ''|.*|/*)
    fail "Invalid workspace name."
    exit 5
    ;;
esac

WORKSPACE_DIR="$AGENTS_DIR/$WORKSPACE_NAME"
if [ -e "$WORKSPACE_DIR" ]; then
  warn "$WORKSPACE_DIR already exists. The wizard will offer to re-init it."
fi

# Hand off to the agent's own init wizard. It'll prompt for portal URL,
# agent token, Anthropic key, working dir, etc., and write the .env.
# Use /dev/tty as stdin so prompts work under curl | sh.
hdr "Running rushworks-agent init --workspace $WORKSPACE_DIR"
if [ -r /dev/tty ]; then
  if ! ( cd "$AGENT_CLI_DIR" && node bin/rushworks-agent init --workspace "$WORKSPACE_DIR" < /dev/tty ); then
    fail "Workspace setup failed."
    exit 5
  fi
else
  if ! ( cd "$AGENT_CLI_DIR" && node bin/rushworks-agent init --workspace "$WORKSPACE_DIR" ); then
    fail "Workspace setup failed."
    exit 5
  fi
fi

# ─── 6. done ────────────────────────────────────────────────────────
hdr "Installation complete"
say ""
say "  Start your agent:"
say "    cd $WORKSPACE_DIR"
say "    node $AGENT_CLI_DIR/bin/rushworks-agent start"
say ""
say "  Add another agent on this host (re-runs only the workspace wizard):"
say "    curl -fsSL https://raw.githubusercontent.com/rushworks/agent/main/install.sh | sh"
say ""
info "Docs: https://github.com/rushworks/agent/blob/main/README.md"
