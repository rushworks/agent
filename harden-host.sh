#!/usr/bin/env bash
#
# harden-host.sh — run a RushworksAI agent as a sandboxed systemd service.
#
# Turns a BYOA agent that was started by hand (`cd workspace && rushworks-agent
# start`) into a dedicated, unprivileged, resource-capped systemd service.
#
#   sudo ./harden-host.sh <agent-name>
#
# What it does (idempotent — re-running with no changes is a no-op):
#   1. Creates a dedicated system user  <agent-name>  (no shell, no login).
#   2. Grants that user *surgical* access to the shared agent code (read) and
#      its own workspace (read/write) via POSIX ACLs — without widening group
#      or world permissions on the operator's home directory.
#   3. Installs a hardened systemd unit at
#      /etc/systemd/system/rushworks-agent-<agent-name>.service
#      (NoNewPrivileges, ProtectSystem=strict, PrivateTmp, syscall + address
#      family restrictions, cgroup memory/CPU caps).
#   4. Enables + starts the service.
#
# Network egress allowlisting is intentionally NOT handled here — see the
# companion firewall step / docs/HARDENING.md.
#
# Assumptions (see docs/HARDENING.md to adapt for other distros):
#   * Linux with systemd, POSIX ACLs (`setfacl`), and cgroup v2.
#   * The workspace was created by `rushworks-agent init --workspace` and lives
#     at  <operator-home>/rushworks/agents/<agent-name>  (override with $WORKSPACE).
#   * The agent code (this repo) is world-readable as installed; the only
#     traversal barrier is the operator's home dir.
set -euo pipefail

# ---------------------------------------------------------------- helpers ----
die()  { echo "harden-host: error: $*" >&2; exit 1; }
info() { echo "harden-host: $*"; }

[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)."
NAME="${1:-}"
[ -n "$NAME" ] || die "usage: sudo $0 <agent-name>"
[[ "$NAME" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "agent name '$NAME' is not a valid unix username."

command -v setfacl >/dev/null || die "setfacl not found — install the 'acl' package (apt-get install acl)."
command -v systemctl >/dev/null || die "systemctl not found — this host does not use systemd (see docs/HARDENING.md)."

# ---------------------------------------------------------------- resolve ----
# This script lives in the repo root; that is the agent code directory.
AGENT_CLI_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
[ -x "$AGENT_CLI_DIR/bin/rushworks-agent" ] || die "cannot find $AGENT_CLI_DIR/bin/rushworks-agent"

# The operator who installed the agent (owner of the code + workspace).
INSTALL_USER="${SUDO_USER:-$(logname 2>/dev/null || echo root)}"
INSTALL_HOME="$(getent passwd "$INSTALL_USER" | cut -d: -f6)"
[ -n "$INSTALL_HOME" ] || die "could not resolve home directory for '$INSTALL_USER'."

WORKSPACE="${WORKSPACE:-$INSTALL_HOME/rushworks/agents/$NAME}"
[ -d "$WORKSPACE" ] || die "workspace not found: $WORKSPACE (run 'rushworks-agent init --workspace' first, or set \$WORKSPACE)."
[ -f "$WORKSPACE/.env" ] || die "no .env in workspace: $WORKSPACE/.env"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || die "node not found on PATH."
NODE_BIN="$(readlink -f "$NODE_BIN")"

NOLOGIN="$(command -v nologin || echo /usr/sbin/nologin)"
UNIT="/etc/systemd/system/rushworks-agent-$NAME.service"

info "agent      : $NAME"
info "code       : $AGENT_CLI_DIR"
info "workspace  : $WORKSPACE"
info "node       : $NODE_BIN"
info "unit       : $UNIT"

changed=0

# ------------------------------------------------------------- 1. user -------
if id "$NAME" >/dev/null 2>&1; then
  info "user '$NAME' already exists — leaving as is."
else
  useradd --system --shell "$NOLOGIN" --home-dir "$WORKSPACE" --no-create-home "$NAME"
  info "created system user '$NAME'."
  changed=1
fi

# ------------------------------------------------------------- 2. acls -------
# Grant traverse (execute-only, cannot list) on each ancestor of the workspace
# and code, up to and including the operator's home dir. Skip world-traversable
# / off-limits roots so we never touch system directories.
add_traverse() {
  case "$1" in
    /|/home|/opt|/srv|/var|/usr|/etc|/root) return 0 ;;
  esac
  setfacl -m "u:$NAME:--x" "$1"
}
walk_up() {
  local p="$1"
  while [ "$p" != "/" ] && [ "$p" != "." ]; do
    p="$(dirname "$p")"
    add_traverse "$p"
    [ "$p" = "$INSTALL_HOME" ] && break
  done
}
walk_up "$WORKSPACE"
walk_up "$AGENT_CLI_DIR"

# Workspace: the service user needs read + write (work/ dir, runtime state).
# Default ACL so files the agent creates stay agent-accessible.
setfacl -R -m  "u:$NAME:rwX" "$WORKSPACE"
setfacl -R -d -m "u:$NAME:rwX" "$WORKSPACE"
info "ACLs applied (traverse to code + read/write workspace for '$NAME')."

# Code is world-readable as installed, so traversal is enough. If you have
# tightened the code dir, also run: setfacl -R -m u:$NAME:rX "$AGENT_CLI_DIR"

# ------------------------------------------------------------- 3. unit -------
read -r -d '' UNIT_BODY <<UNIT_EOF || true
[Unit]
Description=RushworksAI agent ($NAME)
Documentation=https://github.com/rushworks/agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$NAME
Group=$NAME
WorkingDirectory=$WORKSPACE
EnvironmentFile=$WORKSPACE/.env
ExecStart=$NODE_BIN $AGENT_CLI_DIR/bin/rushworks-agent start
Restart=on-failure
RestartSec=5

# ---- Sandbox (see docs/HARDENING.md) ----
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$WORKSPACE
PrivateTmp=yes
ProtectControlGroups=yes
ProtectKernelModules=yes
ProtectKernelTunables=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
UMask=0077

# ---- Resource limits (cgroup v2) ----
MemoryHigh=768M
MemoryMax=1G
CPUQuota=75%
TasksMax=256

[Install]
WantedBy=multi-user.target
UNIT_EOF

if [ -f "$UNIT" ] && printf '%s\n' "$UNIT_BODY" | cmp -s - "$UNIT"; then
  info "unit already up to date."
else
  printf '%s\n' "$UNIT_BODY" > "$UNIT"
  chmod 0644 "$UNIT"
  info "wrote $UNIT"
  changed=1
fi

# ------------------------------------------------------------ 4. enable ------
systemctl daemon-reload
systemctl enable "rushworks-agent-$NAME" >/dev/null 2>&1 || true

if [ "$changed" -eq 1 ] || ! systemctl is-active --quiet "rushworks-agent-$NAME"; then
  systemctl restart "rushworks-agent-$NAME"
  info "service (re)started."
else
  info "service already active and unchanged — no-op."
fi

echo
systemctl --no-pager --full status "rushworks-agent-$NAME" | head -n 12 || true
echo
info "done. Logs: journalctl -u rushworks-agent-$NAME -f"
