import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Board as BoardHandle, board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { Context, Effect, Layer } from "effect";
import { Auth, type User } from "../../identity/server/auth.ts";
import { Settings } from "../../shared/server/config.ts";

/**
 * The board: a Vercel Board (`@vercel/board`) that Factory keeps itself, in SQLite under
 * `<data dir>/board` (`local()` backend), and serves at `/api/board`. It uses no Vercel service.
 * The SPA calls the board's REST API directly; the board knows the person from the Factory session.
 */

export const BOARD_PATH = "/api/board";

export interface BoardShape {
  readonly fetch: (request: Request) => Promise<Response>;
  /** The board's own code: reads, and the writes that Factory makes as itself. */
  readonly team: BoardHandle;
}

export class Board extends Context.Service<Board, BoardShape>()(
  "factory/Board"
) {}

const NOT_PRINCIPAL = /[^a-z0-9@._-]+/g;
const EDGE_DASHES = /^-+|-+$/g;

/** A board handle from an email or a name: `v-this-computer`. A handle has no spaces. */
export const principalName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(NOT_PRINCIPAL, "-")
    .replace(EDGE_DASHES, "");

/** The board in this process. `dir` null keeps it in memory (tests). */
export const makeBoard = (options: {
  /** The signed-in person of a request, or null. */
  readonly currentUser: (headers: Headers) => Promise<User | null>;
  readonly dir: string | null;
  readonly url: string;
}): BoardShape => {
  if (options.dir !== null) {
    mkdirSync(options.dir, { recursive: true });
  }
  const team = board({
    authenticate: async ({ headers }) => {
      const user = await options.currentUser(headers);
      if (user === null) {
        return null;
      }
      const handle = principalName(user.email);
      return { handle, id: `factory:user:${handle}`, kind: "person" };
    },
    backend:
      options.dir === null
        ? local({ memory: true })
        : local({ dir: options.dir }),
    basePath: BOARD_PATH,
    url: options.url,
  });
  return { fetch: (request) => team.fetch(request), team };
};

export const BoardLive = Layer.effect(
  Board,
  Effect.gen(function* () {
    const settings = yield* Settings;
    const auth = yield* Auth;
    // The board calls back outside an Effect: the call runs with the services of this layer.
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    return makeBoard({
      currentUser: (headers) => runPromise(auth.currentUser(headers)),
      dir: join(settings.dataDir, "board"),
      url: `${settings.baseUrl}${BOARD_PATH}`,
    });
  })
);
