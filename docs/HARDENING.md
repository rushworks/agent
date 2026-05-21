# Host hardening for RushworksAI agents

A BYOA agent runs *your* code on *your* machine, next to your apps and data.
By default `rushworks-agent start` runs as whatever user launched it (often a
full sudo-capable login user) with no resource limits and unrestricted network
access. That is fine for a laptop demo and wrong for a production box —
especially for a **devops** agent, which by design can read your logs and query
your database.

`harden-host.sh` turns that hand-launched process into a dedicated, sandboxed
systemd service. This document explains the security model, what the script
does and why, what it deliberately does **not** cover, and how to adapt the
principles to a non-Ubuntu/non-systemd host.

> **Trust boundary.** Anything the agent does *locally* (reading logs, running
> `db_query`) happens on this host, not through the portal, so the portal can't
> enforce it at runtime. The real, un-bypassable controls live in **host
> primitives**: a least-privilege DB role, a dedicated unix user, filesystem
> ACLs, resource caps, and network egress rules. Treat the agent process as
> semi-trusted and contain it at the OS level.

## Usage

```bash
sudo ./harden-host.sh <agent-name>      # e.g. sudo ./harden-host.sh sysley
```

Idempotent: re-running when nothing has changed will not restart a healthy
agent. Override the workspace location with `WORKSPACE=/path sudo -E
./harden-host.sh <name>`.

## What the script does, and why

### 1. Dedicated system user
`useradd --system --shell nologin --no-create-home --home-dir <workspace>`.

A separate, unprivileged account is the primary blast-radius control: if the
agent (or a bug/exploit in the harness) misbehaves, it is confined to what that
user can touch — not the operator's full account. No shell and no login means
the account can't be used interactively.

### 2. Surgical filesystem access via ACLs
Rather than widening group/world permissions (which would expose the operator's
home to everyone) or adding the agent to the operator's group (too broad), the
script grants the agent user exactly two things with POSIX ACLs:

* **Traverse-only (`--x`)** on each ancestor directory up to the operator's
  home — enough to *reach* the code and workspace, but not to *list* the home.
  System roots (`/`, `/home`, `/usr`, …) are skipped; they are already
  world-traversable.
* **Read/write (`rwX`, plus a default ACL)** on the agent's own workspace, so it
  can write its `work/` directory and runtime state. A matching default ACL
  keeps files the agent creates accessible to it.

The shared agent code is world-readable as installed (a normal `git` checkout +
`npm install`), so traverse access is sufficient to read it. If you have
tightened the code directory's permissions, also grant read:
`setfacl -R -m u:<name>:rX <agent-cli-dir>`.

### 3. Hardened systemd unit
Installed at `/etc/systemd/system/rushworks-agent-<name>.service`. The notable
directives:

| Directive | Effect |
|---|---|
| `User` / `Group` | Runs as the dedicated unprivileged user. |
| `NoNewPrivileges=yes` | Process can never gain privileges (no setuid escalation). |
| `ProtectSystem=strict` | Entire filesystem mounted read-only inside the unit… |
| `ReadWritePaths=<workspace>` | …except the agent's own workspace. |
| `PrivateTmp=yes` | Private `/tmp`; can't see or tamper with others' temp files. |
| `ProtectKernelModules/Tunables/Logs`, `ProtectControlGroups`, `ProtectClock`, `ProtectHostname` | Block reads/writes to sensitive kernel + host state. |
| `RestrictSUIDSGID`, `RestrictRealtime`, `RestrictNamespaces`, `LockPersonality` | Remove rarely-needed, frequently-abused capabilities. |
| `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` | Only normal IP + unix sockets; no raw/packet/netlink sockets. |
| `SystemCallFilter=@system-service` | Allow only the typical service syscall set; everything else returns `EPERM`. |
| `MemoryHigh` / `MemoryMax` / `CPUQuota` / `TasksMax` | cgroup v2 resource caps so a runaway agent can't starve the box. |

`EnvironmentFile=<workspace>/.env` is read by systemd (as root) and injected
into the process, so the agent gets its config without the service user needing
to read the secrets file directly.

### 4. Network egress allowlist (per-uid)
The agent runs on a box full of other services, so the firewall rules are scoped
to the **agent's uid only** (`iptables -m owner --uid-owner`) — never box-wide.
They can't affect your apps, CI runners, or anything else.

The agent user may reach: loopback (covers DNS via `127.0.0.53` and a local DB on
`127.0.0.1`), established/related return traffic, the configured DNS resolvers on
`:53`, and `:443` to the **portal host** (parsed from the workspace `.env`) and
the **model provider** (`api.anthropic.com`). Everything else is dropped. IPv6
egress is dropped except loopback/established (no v6 hosts are allowlisted), which
forces the agent onto the filtered v4 path. Add extra destinations with
`EGRESS_EXTRA_HOSTS="host1 host2" sudo -E ./harden-host.sh <name>`.

Because allowlisting is by **IP** (iptables can't match hostnames) and providers
sit behind **CDNs whose IPs rotate**, the script installs a oneshot that applies
the rules at boot (before the agent starts) plus a **timer that re-resolves the
allowlist every 15 minutes**. Refresh manually any time with
`systemctl restart rushworks-egress-<name>`. Rules are intentionally not saved to
disk — they are rebuilt from current DNS on every apply.

The rules are **fail-open**: the agent unit `Wants=` (not `Requires=`) the egress
oneshot, so a firewall hiccup won't take the agent down — but the agent could
then run un-restricted. For a fail-closed posture, change `Wants=`→`Requires=`
and add `BindsTo=` in the generated agent unit.

**Roll back the egress rules:**
```bash
UID=$(id -u <name>)
iptables  -D OUTPUT -m owner --uid-owner "$UID" -j RW_EG4_"$UID"; iptables  -F RW_EG4_"$UID"; iptables  -X RW_EG4_"$UID"
ip6tables -D OUTPUT -m owner --uid-owner "$UID" -j RW_EG6_"$UID"; ip6tables -F RW_EG6_"$UID"; ip6tables -X RW_EG6_"$UID"
systemctl disable --now rushworks-egress-<name>.timer rushworks-egress-<name>.service
```

## What this does NOT cover
* **Mandatory Access Control.** No SELinux or AppArmor profile is shipped. The
  systemd sandbox is discretionary + namespace-based; an MAC profile would add
  defense in depth. Write one for `rushworks-agent` if your environment requires it.
* **Audit log shipping.** systemd logs to the local journal
  (`journalctl -u rushworks-agent-<name>`). Forwarding to a central, tamper-
  evident audit store is left to your logging stack.
* **Secret management.** The token + API key still live in `<workspace>/.env`
  (chmod 600). Use full-disk encryption and/or a secrets manager for stronger
  protection; the script does not integrate one.
* **The DB role itself.** `db_query` is only as safe as the database account in
  its connection string. Always point it at a least-privilege, read-only DB
  role — that is the real backstop, independent of this host hardening.
* **Custom/site firewalls, intrusion detection, OS patching** — out of scope.

## Notable non-defaults (deliberate omissions)

* **`ProtectHome` is not set.** The workspace lives under the operator's home
  (`~/rushworks/agents/<name>`), and `ProtectHome=true` would hide it. For a
  stricter setup, relocate the workspace to `/opt/rushworks/agents/<name>` (or
  `/var/lib/...`), point the unit there, and add `ProtectHome=true`.
* **`MemoryDenyWriteExecute` is not set.** Node/V8's JIT needs writable+
  executable memory; enabling it would crash the agent.

## Adapting to other distributions / init systems

The script assumes Ubuntu/Debian-style tooling, but the principles are portable:

* **Node path** — the unit uses the absolute `node` path resolved at install
  time. On hosts using `nvm`, install a system-wide Node (or hardcode the
  absolute interpreter path) so the service user can execute it.
* **ACLs** — `setfacl` requires the `acl` package and a filesystem mounted with
  ACL support (default on ext4/xfs). RHEL/Fedora: `dnf install acl`. If ACLs
  are unavailable, achieve the same with a shared group + group permissions, or
  by relocating the workspace to a world-traversable path under `/opt`.
* **systemd** — directive names above are systemd-specific. Without systemd:
  - run the agent under a dedicated user via your init (`s6`, `runit`,
    OpenRC, `supervisord`);
  - apply resource limits with cgroups directly or `ulimit`;
  - get sandbox-equivalent isolation with `firejail`, a container
    (Docker/Podman with `--read-only`, `--cap-drop=ALL`, `--memory`,
    `--pids-limit`, a restricted seccomp profile), or a VM.
* **RHEL/SELinux** — keep the systemd unit; additionally write/confine with an
  SELinux policy module rather than relying on the namespace sandbox alone.
* **Resource sizing** — `MemoryMax`/`CPUQuota` are conservative defaults; tune
  to the agent's workload and the host's capacity.

## Verifying

```bash
systemctl status rushworks-agent-<name>          # active (running)?
journalctl -u rushworks-agent-<name> -n 30       # look for "agent ready" + "realtime connected"
systemd-analyze security rushworks-agent-<name>  # sandbox exposure score
```
