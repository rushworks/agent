#!/usr/bin/env bash
#
# harden-host.sh — run a RushworksAI agent as a sandboxed systemd service.
#
# Turns a BYOA agent that was started by hand (`cd workspace && rushworks-agent
# start`) into a dedicated, unprivileged, resource-capped, network-restricted
# systemd service.
#
#   sudo ./harden-host.sh <agent-name>
#
# What it does (idempotent — re-running converges to the same state):
#   1. Creates a dedicated system user  <agent-name>  (no shell, no login).
#   2. Grants that user *surgical* access to the shared agent code (read) and
#      its own workspace (read/write) via POSIX ACLs — without widening group
#      or world permissions on the operator's home directory.
#   3. Installs a hardened systemd unit at
#      /etc/systemd/system/rushworks-agent-<agent-name>.service
#      (NoNewPrivileges, ProtectSystem=strict, PrivateTmp, syscall + address
#      family restrictions, cgroup memory/CPU caps).
#   4. Restricts the agent user's outbound network to loopback + DNS + the
#      portal and model-provider hosts, scoped to the agent's uid only (never
#      box-wide), with a timer that re-resolves the allowlist (CDN IPs rotate).
#   5. Enables + starts everything.
#
# Assumptions (see docs/HARDENING.md to adapt for other distros):
#   * Linux with systemd, POSIX ACLs (`setfacl`), iptables (legacy or nft
#     backend) with the `owner` + `conntrack` matches, and cgroup v2.
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

command -v setfacl   >/dev/null || die "setfacl not found — install the 'acl' package (apt-get install acl)."
command -v systemctl >/dev/null || die "systemctl not found — this host does not use systemd (see docs/HARDENING.md)."
command -v iptables  >/dev/null || die "iptables not found (see docs/HARDENING.md)."

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
EGRESS_UNIT="/etc/systemd/system/rushworks-egress-$NAME.service"
EGRESS_TIMER="/etc/systemd/system/rushworks-egress-$NAME.timer"
EGRESS_APPLY="/usr/local/sbin/rw-egress-$NAME.sh"

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
AGENT_UID="$(id -u "$NAME")"

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
After=network-online.target rushworks-egress-$NAME.service
Wants=network-online.target rushworks-egress-$NAME.service

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
  info "agent unit already up to date."
else
  printf '%s\n' "$UNIT_BODY" > "$UNIT"; chmod 0644 "$UNIT"
  info "wrote $UNIT"; changed=1
fi

# ------------------------------------------------------------ 4. egress ------
# Allowed hosts: portal (parsed from .env) + model provider + $EGRESS_EXTRA_HOSTS.
PORTAL_HOST="$(sed -n 's#^RW_PORTAL_URL=https\?://\([^/:]*\).*#\1#p' "$WORKSPACE/.env" | head -1)"
PORTAL_HOST="${PORTAL_HOST:-rushworks.ai}"
EGRESS_HOSTS="$PORTAL_HOST api.anthropic.com ${EGRESS_EXTRA_HOSTS:-}"
CHAIN4="RW_EG4_${AGENT_UID}"
CHAIN6="RW_EG6_${AGENT_UID}"

# Generated, re-runnable apply script. The timer + boot unit re-run it so the
# allowlist tracks CDN IP rotation. iptables rules are NOT saved to disk; they
# are re-applied on boot by the oneshot below (before the agent starts).
read -r -d '' APPLY_BODY <<APPLY_EOF || true
#!/usr/bin/env bash
# Generated by harden-host.sh — (re)applies the egress allowlist for agent '$NAME'.
# Scoped to uid $AGENT_UID only; never affects other users/services.
set -euo pipefail
UID_OWNER=$AGENT_UID
HOSTS="$EGRESS_HOSTS"
C4=$CHAIN4
C6=$CHAIN6

build() { # \$1 = iptables|ip6tables  \$2 = chain
  local ipt="\$1" ch="\$2"
  "\$ipt" -N "\$ch" 2>/dev/null || true
  "\$ipt" -F "\$ch"
  "\$ipt" -A "\$ch" -o lo -j ACCEPT
  "\$ipt" -A "\$ch" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
}

# IPv4: loopback (covers DNS@127.0.0.53 + local Postgres) + DNS resolvers + 443 to allowed hosts.
build iptables "\$C4"
for ns in \$(awk '/^nameserver/{print \$2}' /etc/resolv.conf | grep -vE ':'); do
  iptables -A "\$C4" -p udp -d "\$ns" --dport 53 -j ACCEPT
  iptables -A "\$C4" -p tcp -d "\$ns" --dport 53 -j ACCEPT
done
for h in \$HOSTS; do
  for ip in \$(getent ahostsv4 "\$h" | awk '{print \$1}' | sort -u); do
    iptables -A "\$C4" -p tcp -d "\$ip" --dport 443 -j ACCEPT
  done
done
iptables -A "\$C4" -j DROP
iptables -C OUTPUT -m owner --uid-owner "\$UID_OWNER" -j "\$C4" 2>/dev/null || \\
  iptables -A OUTPUT -m owner --uid-owner "\$UID_OWNER" -j "\$C4"

# IPv6: no v6 hosts are allowlisted, so permit only loopback/established and drop
# the rest for this uid (forces the agent onto the filtered v4 path).
if command -v ip6tables >/dev/null 2>&1; then
  build ip6tables "\$C6"
  ip6tables -A "\$C6" -j DROP
  ip6tables -C OUTPUT -m owner --uid-owner "\$UID_OWNER" -j "\$C6" 2>/dev/null || \\
    ip6tables -A OUTPUT -m owner --uid-owner "\$UID_OWNER" -j "\$C6"
fi
echo "rw-egress: applied allowlist for uid \$UID_OWNER (hosts: \$HOSTS)"
APPLY_EOF

if [ -f "$EGRESS_APPLY" ] && printf '%s\n' "$APPLY_BODY" | cmp -s - "$EGRESS_APPLY"; then
  info "egress apply script already up to date."
else
  printf '%s\n' "$APPLY_BODY" > "$EGRESS_APPLY"; chmod 0750 "$EGRESS_APPLY"
  info "wrote $EGRESS_APPLY"; changed=1
fi

read -r -d '' EGRESS_UNIT_BODY <<EG_EOF || true
[Unit]
Description=Egress allowlist for RushworksAI agent ($NAME)
After=network-online.target nss-lookup.target
Wants=network-online.target
Before=rushworks-agent-$NAME.service

[Service]
Type=oneshot
ExecStart=$EGRESS_APPLY
# No RemainAfterExit: the iptables rules persist on their own, and a timer will
# NOT re-fire/advance while the unit it triggers stays active. Letting this
# oneshot go inactive after each run is what lets the .timer refresh on schedule.

[Install]
WantedBy=multi-user.target
EG_EOF

read -r -d '' EGRESS_TIMER_BODY <<TM_EOF || true
[Unit]
Description=Refresh egress allowlist for RushworksAI agent ($NAME) (tracks CDN IP rotation)

[Timer]
OnBootSec=2min
OnCalendar=*:0/15
Persistent=true

[Install]
WantedBy=timers.target
TM_EOF

for pair in "$EGRESS_UNIT|$EGRESS_UNIT_BODY" "$EGRESS_TIMER|$EGRESS_TIMER_BODY"; do
  f="${pair%%|*}"; body="${pair#*|}"
  if [ -f "$f" ] && printf '%s\n' "$body" | cmp -s - "$f"; then
    info "$(basename "$f") already up to date."
  else
    printf '%s\n' "$body" > "$f"; chmod 0644 "$f"
    info "wrote $f"; changed=1
  fi
done

# ------------------------------------------------------------ 5. enable ------
systemctl daemon-reload
systemctl enable rushworks-egress-$NAME.service >/dev/null 2>&1 || true
systemctl enable rushworks-egress-$NAME.timer   >/dev/null 2>&1 || true
systemctl enable "rushworks-agent-$NAME"        >/dev/null 2>&1 || true

# Apply the egress allowlist now (idempotent) and start the timer.
systemctl restart rushworks-egress-$NAME.service
systemctl restart rushworks-egress-$NAME.timer

if [ "$changed" -eq 1 ] || ! systemctl is-active --quiet "rushworks-agent-$NAME"; then
  systemctl restart "rushworks-agent-$NAME"
  info "agent service (re)started."
else
  info "agent service already active and unchanged — left running."
fi

echo
systemctl --no-pager --full status "rushworks-agent-$NAME" | head -n 12 || true
echo
info "done."
info "  agent logs   : journalctl -u rushworks-agent-$NAME -f"
info "  egress apply : $EGRESS_APPLY   (refresh: systemctl restart rushworks-egress-$NAME)"
