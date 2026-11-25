# Factory

A personal software factory. People and agents work together on a **Board**: a
[Vercel Board](https://vercel.com/docs/board) (`@vercel/board`) that Factory keeps itself in SQLite, with no Vercel
service. **Agents** take the tasks of their channels, work in sandboxes, and hand work to other channels.
One Bun process serves the SPA and the REST API, and runs the agents.

## Stack

| Part | What |
| --- | --- |
| Runtime, package manager, bundler, tests | [Bun](https://bun.sh) |
| Server | [Effect](https://effect.website) 4 (`effect/http` router on `@effect/platform-bun`) |
| Database | SQLite: `@effect/sql-sqlite-bun` with migrations (`src/server/db.ts`), file `<FACTORY_DATA_DIR>/factory.sqlite` |
| Board | `@vercel/board` with the `local()` backend: SQLite at `<FACTORY_DATA_DIR>/board/local.db` |
| Agents | [Pi Durable](https://github.com/earendil-works/pi) (`@earendil-works/pi-durable`): the model loop in the Factory process, stored in `<FACTORY_DATA_DIR>/agents.sqlite` |
| Sandboxes | Docker containers, reached through `@earendil-works/pi-env` |
| Sign-in | [Better Auth](https://better-auth.com) with Google, or local mode |
| UI | Preact SPA (`src/client`), bundled by Bun's HTML imports, Factory design tokens (`src/client/css`) |
| Quality | TypeScript (`tsc --noEmit`), Biome via Ultracite, lefthook pre-commit |

## Layout

```text
src/server/main.ts      HTTP server: the SPA routes and the Effect router
src/server/routes.ts    REST API: /api/board/* (the board), /api/session, /api/auth/*, /login/google
src/server/board.ts     the board: local() backend, the person from the Factory session
src/server/auth/        Better Auth + Google sign-in, Google group check, local mode
src/server/config.ts    settings from the environment (.env.example)
src/server/db.ts        SQLite and its migrations
src/server/factory/     the agents: store.ts (definitions, secrets, runs), runner.ts (tasks to agents, schedules),
                        sandbox.ts (the sandbox provider), workspace.ts (checkouts, skills), tools.ts (board tools),
                        models.ts (model credentials), flow.ts, api.ts (/api/factory)
src/client/             the SPA: board.tsx (sidebar, feeds, tasks), composer.tsx, message.tsx, pane.tsx (thread pane),
                        agents.tsx, setup.tsx, flow.tsx, run.tsx
test/                   bun test
```

## REST API

- `/api/board/*` is the board's own HTTP API ([reference](node_modules/@vercel/board/docs/04-reference/03-http.md)):
  channels, threads, messages, tasks and their states, the event feed (SSE). The SPA calls it directly. The board
  knows the person from the Factory session; a request without one gets 401.
- `/api/factory`: the agents. `GET /api/factory` is all definitions with their state. `POST /api/factory/<kind>`
  saves a definition and `DELETE /api/factory/<kind>/<name>` removes it (`agents`, `projects`, `resources`,
  `skills`). `POST /api/factory/secrets` sets a secret; no endpoint answers a secret's value.
  `GET /api/factory/runs` and `/runs/<id>` are the runs and their logs, `POST /runs/<id>/stop` stops one, and
  `GET /api/factory/flow?days=30` is the flow.
- `GET /api/session`: the signed-in person, or 401 with the sign-in mode.
- `/api/auth/*`: Better Auth. `GET /login/google` starts the Google sign-in.

Writes from another origin are refused. In local mode, only requests for this computer's names are accepted.

## Board

Channels hold threads; a task is a thread with a state (`waiting`, `ready`, `claimed`, `blocked`, `completed`,
`failed`, `canceled`), labels and the tasks it waits for. The UI has the layout of the Board viewer (`vb inspect`) in
the Factory design:

- **Sidebar:** Latest, Tasks (open count), Needs a person, and the channels grouped by the first part of their path,
  with `+` for a new channel.
- **Main column:** a head with the open tasks by state (each a link to its list) and the `live` state of the event
  feed. Latest is the newest messages of every channel; a channel shows its threads with their replies; Tasks is a
  grid with state tabs. Each task's root has a task line: state, who holds it and the time left of the claim, what it
  waits for, the result or the reason. The composer below is the Board viewer's: a dashed box with the
  channel (`#`), the text, and a toolbar: attach (or paste) files, labels, start it as a task (and the tasks it
  needs), send later (a schedule), and send. Enter sends, Shift+Enter breaks a line, lists continue, ⌘B / ⌘I / ⌘E
  format, and each place keeps its draft in the tab. In the tasks view it always starts a task.
- **Thread pane:** the task card (facts, and what a person can do now: continue, done with a result, hold for a
  person, cancel with a reason, reopen, make a thread a task), the thread, and the same composer for replies (a reply to
  a task that needs a person continues it). Esc closes the pane; typing outside a field goes to the open composer.

The UI shows the states in the words of people (to do, working, needs a person, waits for tasks, done, failed,
canceled). Views live in the URL: `/board`, `/board?channel=<path>`, `/board/tasks?state=<state>&channel=<path or
prefix/>`, `?thread=<id>` for the pane, and `/board/tasks/<id>` as a task's permalink. The UI loads again on each
board event (`/api/board/events`, SSE).

The Board skill for coding agents is in `.agents/skills/board` (`bunx skills add vercel/board --skill board`).

## Agents

An agent is defined on the **Agents** page: its role and instructions, its model, the channels whose tasks it
does, and what its sandbox gets.

- **Brain and hands.** The agent itself is a Pi Durable conversation in the Factory process: the model calls, the
  transcript and the board tools. Its coding tools (`read`, `write`, `edit`, `bash`) run in a sandbox, through a
  pi-env daemon. Factory's own secrets and the board's credentials never enter a sandbox.
- **As the Pi coding agent.** Pi Durable has no system prompt of its own. Factory gives each agent what the Pi
  coding agent gives its model, in Pi's words: the tool list, the rules of the tools (`read` not `cat`, exact
  `edit` matches), the `AGENTS.md` or `CLAUDE.md` of each repository, the skills (`.agents/skills`, `.pi/skills`,
  `.claude/skills`), and the working directory (the repository, when the agent has one). `read` prepares images
  as Pi does, and compaction and retries use Pi's defaults. MCP servers are not there yet.
- **Tasks.** When a task is ready in a channel of an agent, the agent claims it, gets a new sandbox, and works. Its
  last answer is posted to the thread and completes the task. With the board tools it can read threads, list
  tasks, reply, make a task in another channel (`board_task`), give its task to a person (`task_block`) or fail
  it (`task_fail`). A task with the label `factory.agent=<name>` is only for that agent.
- **Schedules.** A schedule (cron, with a time zone) makes a task for its agent: "each day at 08:00, check the
  logs". The run then shows on the board as each other task. A schedule that was due while Factory did not run
  fires one time at the start.
- **Chains.** A task that an agent makes knows how long its chain of agents' tasks is. At 12 the chain stops, and
  the agent gives the work to a person.
- **Durable.** A run continues after a restart of Factory, in the same sandbox. A tool call that the restart cut
  off is not run again: the model sees that it was interrupted, and decides. After a stop that is longer than
  the lease of a task (3 minutes), the task goes back to the board and an agent takes it again.
- **Given back.** When a person answers a task that an agent gave to them, the agent goes on in the same
  conversation, in a new sandbox.
- **Audit.** A task's pane shows its runs. A run's page shows each step in one line: what the agent said, each
  tool call, and the output of a call when you open it.

**Setup** has what agents work with:

- **Projects**: Git repositories. Each project of an agent is checked out in its sandbox at
  `/workspace/<name>`. A token (a secret) lets Git read a private repository and push. `AGENTS.md` of a
  repository goes into the agent's instructions, and the skills in `.agents/skills` are found without a setting.
- **Shared resources**: containers that run one time for all sandboxes (PostgreSQL, Elasticsearch, an OIDC
  server). Each has its own network, and a sandbox joins only the networks of its agent's resources. The name of
  a resource is its host name. A resource can also be a container that runs already: Factory then only lets the
  sandboxes reach it.
- **Skills**: instructions for one kind of work, written in Factory or uploaded as `SKILL.md`. An agent sees the
  name and the description of its skills, and reads a skill when a task needs it.
- **Secrets**: credentials by the name of an environment variable. A sandbox gets only the secrets of its agent.
  The values are sealed in the database (AES-256-GCM) with `FACTORY_SECRET_KEY`, or with a key file that Factory
  makes in the data directory.

**Models.** A provider key is a secret with the provider's variable name (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).
A subscription uses a login of this computer: for ChatGPT the login of the Codex CLI (`codex login`,
`~/.codex/auth.json`), for other providers Pi's (`pi`, then `/login`).

**Sandboxes.** `SandboxProvider` (`src/server/factory/sandbox.ts`) is the only part that knows Docker: it starts
a box with the pi-env daemon in it, and starts shared resources. Another provider (a VM, a remote host) needs
only these methods. The default image `factory-sandbox:2` is built on first use (Debian with git, curl, ripgrep,
jq, Python and Bun); an agent can name another image, which needs bash and git.

**Flow** shows how tasks move: a box for each channel, a line for each way that tasks went, as thick as the
number of tasks. A line that goes back to an earlier channel is rework.

## Run

```bash
bun install
cp .env.example .env     # optional: Google sign-in
bun run dev              # portless + bun --watch, Bun bundles the SPA with hot reload: https://factory.localhost
bun run start            # the same, production mode
bun run build            # one executable with the SPA inside: dist/factory
bun run serve            # run dist/factory under portless
bun run verify           # typecheck, lint, tests
```

Without portless: `PORT=4310 bun src/server/main.ts`, then open http://localhost:4310.

For Google sign-in, set the Google values in `.env` and serve Factory on a host name that Google accepts as a
redirect (not `*.localhost`), with `FACTORY_URL` set to it.
