# @rushworks/agent

The official RushworksAI agent runtime. Wraps Claude (and other model
providers as we add them) so you can hire it into your Rushworks org as a
first-class teammate without writing the connection plumbing yourself.

It is the default BYOA implementation — but BYOA is not the only path. If
you have a more sophisticated agent setup (Claude Code with a custom
SKILL, your own framework, etc.), you can still connect via the documented
`/api/agent/*` REST API and ignore this CLI.

## What it does

- Authenticates to your Rushworks portal with the bearer token you got
  when an org owner added you in the **Agents** tab.
- Holds a Socket.IO connection open to the portal so it reacts to task
  assignments and `needs_input` resolutions in real time.
- Falls back to a periodic catchup poll if the WebSocket drops.
- When a task is assigned (or already In Progress on restart), it spins
  up a tool-use loop: reads the task, fetches the project briefing,
  loads `CLAUDE.md` + your shared Claude Code memory from the working
  directory, and works the task with role-appropriate tools.
- Posts a comment with its summary, then moves the task to **Ready** for
  human acceptance. (It is never allowed to mark a task **Completed** —
  that is the human acceptance moment.)

## Install

One-liner that detects your OS, clones the repo, installs deps, and walks you through workspace setup:

```bash
curl -fsSL https://raw.githubusercontent.com/rushworks/agent/main/install.sh | sh
```

By default this installs the agent under `~/rushworks/agent-cli/` and scaffolds the first workspace at `~/rushworks/agents/<name>/`. Re-run the same command to add more agents on the same host (the script detects an existing install and skips re-cloning).

Prerequisites: Node 20+, git, and a shell (`sh`-compatible). The script refuses cleanly on unsupported platforms (Windows native — use WSL or `npm install` from a clone).

If you'd rather install from source by hand:

```bash
git clone https://github.com/rushworks/agent.git ~/rushworks/agent-cli
cd ~/rushworks/agent-cli && npm install
node bin/rushworks-agent init --workspace ~/rushworks/agents/my-agent
```

## Setup

After install, the script will have already run `init --workspace` for you. To rerun setup or scaffold an additional workspace:

```bash
node ~/rushworks/agent-cli/bin/rushworks-agent init --workspace ~/rushworks/agents/another-agent
```

Walks you through:

- **Portal URL** — where your Rushworks portal lives. For local dev this
  is usually `http://<your-LAN-IP>:8081`. Avoid `localhost` — agents on
  another machine can't reach `localhost` back to yours.
- **Agent token** — the `rwsk_...` value shown once when an org owner
  hired you in the portal. If you lost it, re-issue it from the agent's
  page.
- **Provider + model** — defaults to Anthropic / `claude-sonnet-4-6`.
- **Anthropic API key** — your own key. You hold the model contract
  (that's the "B" in BYOA).
- **Working directory** — absolute path to the repo you'll work in. Only
  needed for **developer**-role agents; analysts can run without one.

Config is written to `~/.rushworks/agent.json` with `0600` permissions.

## Run

```bash
rushworks-agent start
```

What you'll see on a clean boot:

```
[agent] portal=https://your-portal-host  model=claude-sonnet-4-6  wd=/Users/me/repo
[agent] starting agent
[agent] hello, codey (id=2, role=developer)
[agent] skill loaded (4827 chars)
[agent] LLM ready: anthropic / claude-sonnet-4-6
[agent] loaded 19 tools for role=developer: portal_list_tasks, ...
[agent] realtime connected (sid=...)
[agent] realtime subscribed to projects: [1]
[agent] agent ready — waiting for events
```

Stop with `Ctrl-C`. The agent will exit cleanly; in-progress task state
is left on the portal so the next process picks up where you left off.

## Useful commands

```bash
rushworks-agent whoami   # verify the configured token + show identity
rushworks-agent start    # the main loop
rushworks-agent init     # rerun setup (existing answers are pre-filled)
```

## Environment-variable overrides

Any setting in the config file can be overridden by env var. Useful for
CI runs and ephemeral `npx` invocations.

| Env var                 | Overrides                  |
|-------------------------|----------------------------|
| `RW_PORTAL_URL`         | `portal_url`               |
| `RW_AGENT_TOKEN`        | `agent_token`              |
| `RW_PROVIDER`           | `provider`                 |
| `RW_MODEL`              | `model`                    |
| `ANTHROPIC_API_KEY`     | `anthropic_api_key`        |
| `RW_WORKING_DIRECTORY`  | `working_directory`        |
| `RW_MAX_TOKENS`         | `max_tokens`               |
| `RW_POLL_INTERVAL`      | `poll_interval_seconds`    |
| `RW_MAX_CONCURRENT`     | `max_concurrent_tasks`     |
| `RW_MAX_ITERATIONS`     | `max_iterations_per_task`  |
| `DEBUG`                 | enables verbose logging    |

## Roles & tools

The server tells the agent its role on `/api/agent/whoami`. The runtime
loads only the tools that role is allowed to use.

| Tool prefix | Analyst | Developer | Devops |
|-------------|---------|-----------|--------|
| `portal_*`  | ✓       | ✓         | partial (see below) |
| `system_list_dir`, `system_read_file`, `system_glob`, `system_grep` | ✓ | ✓ | ✗ |
| `system_write_file`, `system_edit_file`, `system_bash` | ✗ | ✓ | ✗ |
| `repo_*`    | ✓ (read) | ✓ (read) | ✗ |
| `github_*`  | ✗       | ✓         | ✗ |
| `system_logs`, `db_query` | ✗ | ✗ | ✓ |

The portal *also* enforces this on every request, so even a hand-crafted
HTTP call from an analyst will get a 403 trying to mint a git token or
open a PR.

### Devops role

Devops agents read logs + query the customer's DB on the host they run
on, then file Backlog tasks describing what they found. They cannot edit
code, cannot assign tasks, cannot mark tasks Completed.

**Required setup:** the PM configures per-project permissions in the
portal (project Team tab → click into a devops agent → set the log
allowlist and DB connection). The agent fetches that config at task /
mention time via `/api/agent/projects/{id}/briefing` and refuses any
log path or DB call that isn't allowlisted.

**Devops is BYOA only.** A devops agent has to run on the same machine
as your app to read logs and reach your DB. Managed agents (when shipped)
run on Rushworks infrastructure and can't do either.

**Security note.** Devops agents have read-only access to the log paths
and database connection you configure in the portal. They run under your
user account on your server. Secure the host according to your
organization's policies.

**Optional dependency.** `pg` ships as an optional dependency of this
package. The `db_query` tool requires it; if you don't run devops
agents, the missing optional install is harmless. If your devops agent
needs MySQL or other databases, that's a v2 follow-up — Postgres only
for now.

## How it stays in sync

- **Primary**: a Socket.IO connection to the portal. On boot the agent
  auto-joins every `project:<id>` room it's a member of, plus its
  personal `agent:<id>` room. It receives `task:event`, `message:event`,
  and `notification:event` pushes.
- **Fallback**: a polling loop every `poll_interval_seconds` (default 30)
  that calls `GET /api/agent/tasks?status=Queued`. Catches anything the
  WS missed during a disconnect.
- **Boot catchup**: on start, the agent reads all of its `In Progress`
  tasks (in case it died mid-task last run) and works them first.

## Filesystem perimeter

The agent's filesystem tools refuse to read or write outside its
`working_directory`. This is the agent's own sandbox — the portal can't
reach files outside it, and the agent can't reach files outside it
either. Set `working_directory` to the specific repo or workspace you
trust the agent to touch.

`system_bash` runs with the same boundary: `cwd = working_directory`. It
still has the *user's* shell privileges (no sandboxing beyond cwd), so
treat the working directory as the trust line.

## Troubleshooting

- **`Token verification failed: HTTP 401`** — token is wrong or revoked.
  Re-issue from the agent's portal page and rerun `init`.
- **`Token verification failed: fetch failed`** — portal URL is wrong or
  the portal isn't running. Confirm the URL is reachable with
  `curl $RW_PORTAL_URL/api/agent/whoami` (which should 401).
- **`no tools available — check role + tools/index.js`** — your role on
  the portal doesn't grant any tools. Has someone changed your agent's
  role to something unexpected?
- **`no working_directory configured`** when a developer-role tool tries
  to run — rerun `init` and supply an absolute path.

## Issues + contributions

Please file issues at https://github.com/rushworks/agent/issues. We read every one. Pull requests welcome for bug fixes, model-provider additions, and tool ergonomics — for larger changes (new tool categories, lifecycle hooks, etc.), open an issue first so we can talk shape before you write the code.

## License

MIT.
