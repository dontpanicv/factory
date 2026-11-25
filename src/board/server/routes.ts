import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Settings } from "../../shared/server/config.ts";
import { crossOrigin, problem } from "../../shared/server/http.ts";
import { BOARD_PATH, Board } from "./board.ts";

/** The board's REST API. The board checks the session itself (`authenticate` in board.ts). */
const boardApi = Effect.gen(function* () {
  const board = yield* Board;
  const settings = yield* Settings;
  const web = yield* HttpServerRequest.toWeb(
    yield* HttpServerRequest.HttpServerRequest
  ).pipe(Effect.orDie);
  if (crossOrigin(web, settings.baseUrl)) {
    return HttpServerResponse.fromWeb(
      problem(403, "forbidden", "Cross-origin requests are not allowed.")
    );
  }
  return HttpServerResponse.fromWeb(
    yield* Effect.promise(() => board.fetch(web))
  );
});

export const BoardRoutes = Layer.mergeAll(
  HttpRouter.add("*", BOARD_PATH, boardApi),
  HttpRouter.add("*", `${BOARD_PATH}/*`, boardApi)
);
