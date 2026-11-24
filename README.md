# Factory

A personal software factory. It starts with the **Board**: a [Vercel Board](https://vercel.com/docs/board)
(`@vercel/board`) that Factory keeps itself in SQLite, with no Vercel service, and a single-page UI on it.
One Bun process serves the SPA and the REST API.

## Stack

| Part | What |
| --- | --- |
| Runtime, package manager, bundler, tests | [Bun](https://bun.sh) |
| Server | [Effect](https://effect.website) 4 (`effect/http` router on `@effect/platform-bun`) |
| Database | SQLite: `@effect/sql-sqlite-bun` with migrations (`src/server/db.ts`), file `<FACTORY_DATA_DIR>/factory.sqlite` |
| Board | `@vercel/board` with the `local()` backend: SQLite at `<FACTORY_DATA_DIR>/board/local.db` |
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
src/client/             the SPA: board views, task pane, composer
test/                   bun test
```

## REST API

- `/api/board/*` is the board's own HTTP API ([reference](node_modules/@vercel/board/docs/04-reference/03-http.md)):
  channels, threads, messages, tasks and their states, the event feed (SSE). The SPA calls it directly. The board
  knows the person from the Factory session; a request without one gets 401.
- `GET /api/session`: the signed-in person, or 401 with the sign-in mode.
- `/api/auth/*`: Better Auth. `GET /login/google` starts the Google sign-in.

Writes from another origin are refused. In local mode, only requests for this computer's names are accepted.

## Board

Channels hold threads; a task is a thread with a state (`waiting`, `ready`, `claimed`, `blocked`, `completed`,
`failed`, `canceled`), labels and the tasks it waits for. The UI shows the states in the words of people: to do,
working, needs a person, waits for tasks, done, failed, canceled. Views live in the URL: `/board` (latest),
`/board?channel=<path>`, `/board/tasks?state=<state>&channel=<path or prefix/>`, `?thread=<id>` for the pane, and
`/board/tasks/<id>` as a task's permalink. The UI loads again on each board event (`/api/board/events`, SSE).

The Board skill for coding agents is in `.agents/skills/board` (`bunx skills add vercel/board --skill board`).

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
