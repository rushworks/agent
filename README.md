# @rushworks/agent

The official RushworksAI agent runtime. Wraps Claude (and other model
providers as we add them) so you can hire it into your Rushworks org as a
first-class teammate without writing the connection plumbing yourself.

It is the default BYOA implementation — but BYOA is not the only path. If
you have a more sophisticated agent setup (Claude Code with a custom
SKILL, your own framework, etc.), you can still connect via the documented
`/api/agent/*` REST API and ignore this CLI.

## What it does

- Authenticates to your Rushworks portal with the bearer token an org owner
  issued you in the **Agents** tab.
- Polls for **work orders assigned to it**, claims one, works it in a
  tool-use loop, opens a pull request, and hands off for review.
- Narrates what it is doing into the project's Workspace, so the humans on
  the project can follow along without asking.
- Holds a Socket.IO connection open for messages and @-mentions, and falls
  back to polling when that connection drops.

It never decides *what* work exists and it never marks work complete. Both
of those are human decisions, enforced by the portal (see **How work reaches
you** below).

This is the default BYOA implementation, not the only path. If you already
have an agent setup you like (Claude Code with a custom skill, your own
framework), you can talk to the documented `/api/agent/*` REST API directly
and ignore this CLI.

## How work reaches you

Work is a **work order**: a branch-backed unit of work belonging to a wish.
The portal only offers you one once it has passed three gates:

| Gate | Meaning | Who clears it |
|---|---|---|
| **Sanctioned** | a human blessed this as real work | project manager / owner |
| **Activated** | released for pickup, not still being drafted | project manager / analyst |
| **Assigned** | routed specifically to you | project manager / analyst |

A work order missing any of the three is invisible to your queue. In
particular, **pushing a branch does not create work for yourself**: the
portal auto-creates a work order from an unrecognised branch but marks it
unsanctioned, so it waits for a human.

The loop, once one is assigned:

1. **Claim** it — a soft lease. Your claim is refreshed while you work; if
   the process dies, the portal releases it after a period of inactivity so
   the work order is not stuck forever.
2. **Read** the work order and the project briefing, plus `CLAUDE.md` and
   any shared memory in your working directory.
3. **Work** it on its branch with role-appropriate tools.
4. **Open a pull request.** That is the completion signal.
5. **Sign off** with a summary in the project conversation, and release the
   claim.

**You never set status.** Status is derived from the repository: commits move
a work order to In Progress, a PR to In Review, a merge to production to
Done. That is deliberate — the repo is the source of truth, not a field
somebody remembered to update.

## Which model it uses

Resolved at boot, widest to narrowest:

```
portal agent config   ->   RW_MODEL env / local config   ->   built-in default
```

If a project manager sets a model on your agent's config screen in the
portal, that wins on your next boot — no reinstall, no file to edit here.
The built-in default is `claude-opus-5`. When the portal's value differs
from your local one, the runtime logs which it chose.

Under BYOA the model runs on **your** Anthropic API key, so the cost and the
choice are both yours.

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
- **Provider + model** — defaults to Anthropic / `claude-opus-5`. A project
  manager can override the model per agent from the portal's agent config
  screen; the portal's value wins over this local setting on the next boot,
  so you do not need to reinstall or edit a file to change models.
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
[agent] portal=https://your-portal-host  model=claude-opus-5  wd=/Users/me/repo
[agent] starting agent
[agent] hello, codey (id=2, role=developer)
[agent] skill loaded (4827 chars)
[agent] LLM ready: anthropic / claude-opus-5
[agent] loaded 19 tools for role=developer: portal_list_tasks, ...
[agent] realtime connected (sid=...)
[agent] realtime subscribed to projects: [1]
[agent] agent ready — waiting for events
```

Stop with `Ctrl-C`. The agent exits cleanly. Any claim it held is left on
the portal and released after a period without a heartbeat, so the work
order returns to the queue rather than being stuck.

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
| `portal_*`  | ✓       | ✓         | ✓      |
| `system_list_dir`, `system_read_file`, `system_glob`, `system_grep` | ✓ | ✓ | ✓ (absolute paths, deny-list gated) |
| `system_write_file`, `system_edit_file` | ✗ | ✓ | PM toggle (`file_write`) |
| `system_bash` | ✗ | ✓ | PM toggle (`shell_access`) |
| `system_screenshot` | ✗ | PM toggle (`browser_access`) | ✗ |
| `repo_get`  | ✓       | ✓         | ✓      |
| `repo_search`, `repo_log` | ✓ | ✓ | ✗ |
| `github_list_pull_requests`, `github_get_pull_request`, `github_list_pull_request_files`, `github_list_commits`, `github_comment_on_pr` | ✓ | ✓ | ✗ |
| `github_get_check_runs`, `github_list_pr_comments`, `github_list_pr_reviews`, `github_list_issues`, `github_get_issue` | ✓ | ✓ | ✗ |
| `github_mint_token`, `github_open_pull_request` | ✗ | ✓ | ✗ |
| `code_definition`, `code_references`, `code_diagnostics` | ✗ | ✓ | ✗ |
| `web_search`, `web_fetch` | PM toggle (`web_access`) | PM toggle (`web_access`) | PM toggle (`web_access`) |
| `system_logs` | ✗ | ✗ | ✓ |
| `db_query` | ✗ | ✗ | ✓ (read-only default; PM toggle `db_write` enables writes) |

The portal *also* enforces this on every request, so even a hand-crafted
HTTP call from an analyst will get a 403 trying to mint a git token or
open a PR.

### Devops role

Devops agents have blanket read-only access to the host filesystem, the
project's GitHub repo, the backlog, and (optionally) the customer's
database. They report what they find in the project conversation. They
cannot create work orders, cannot assign work, and cannot mark anything
complete.

**Filesystem access.** Devops agents use the same read tools as
analyst/developer agents (`system_list_dir`, `system_read_file`,
`system_glob`, `system_grep`) but operate on absolute paths instead of
a working directory. A hardcoded deny-list blocks sensitive files
(.env, .ssh, *.key, *.pem, shadow, sudoers, etc.) regardless of
request. The `system_logs` tool provides `tail` and `grep` modes for
large log files beyond the 200KB read limit.

**Database access.** The PM configures a connection string per-project
via the Team tab. If set, `db_query` runs SELECT-only queries by
default (enforced via `SET TRANSACTION READ ONLY`).

**Write permissions.** The PM can enable three optional write
capabilities per-project via the Team tab:

| Toggle | Tools unlocked | Notes |
|--------|---------------|-------|
| `file_write` | `system_write_file`, `system_edit_file` | Absolute paths; deny-list still blocks writes to sensitive files |
| `shell_access` | `system_bash` | Full shell under the host user account; requires `cwd` param |
| `db_write` | `db_query` (removes READ ONLY) | INSERT/UPDATE/DELETE/DDL allowed |

All three default to off. The tools are visible in the agent's tool
list regardless, but they refuse execution unless the PM has enabled
the corresponding toggle.

**Devops is BYOA only.** A devops agent has to run on the same machine
as your app to read logs and reach your DB. Managed agents (when shipped)
run on Rushworks infrastructure and can't do either.

**Security note.** Devops agents have read-only access to the entire
host filesystem (minus the deny-list) and any database connection you
configure. Write permissions are off by default and must be explicitly
enabled per-project by the PM. They run under your user account on
your server. Secure the host according to your organization's policies.

**Optional dependency.** `pg` ships as an optional dependency of this
package. The `db_query` tool requires it; if you don't run devops
agents, the missing optional install is harmless. If your devops agent
needs MySQL or other databases, that's a v2 follow-up: Postgres only
for now.

### Developer role — optional capabilities

Developer agents work inside a `working_directory` (the repo checkout).
All file and git tools are available by default. One optional capability
requires a PM toggle:

**Browser access (`browser_access`).** Enables `system_screenshot` — the
agent can take a screenshot of a web page using headless Chromium. Useful
for verifying UI changes, debugging rendering issues, and visual QA.

The host must have Playwright installed:

```bash
npx playwright install chromium
```

`playwright` ships as an optional dependency of this package. If you
don't enable browser access, the missing install is harmless.

## How it stays in sync

- **Work discovery is polling.** Every `poll_interval_seconds` (default 30)
  the runtime asks `GET /api/agent/updates` for work orders assigned to it
  that are activated and sanctioned, and works them up to
  `max_concurrent_tasks`. On boot it does the same pass immediately, so a
  restart picks up whatever was already assigned.
- **Conversation is realtime.** A Socket.IO connection joins every
  `project:<id>` room the agent belongs to plus its own `agent:<id>` room,
  and receives `message:event` and `notification:event` pushes. This is how
  @-mentions reach you without waiting for a poll.
- **The socket is not required.** If it drops, the poll keeps work moving;
  only the responsiveness of chat degrades.
- **Your credentials can be revoked from the portal.** If an owner revokes
  or reissues your token, the portal drops your live connection immediately
  and the next request fails with a 401.

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
