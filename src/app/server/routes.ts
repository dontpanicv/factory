import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { BoardRoutes } from "../../board/server/routes.ts";
import { Auth } from "../../identity/server/auth.ts";
import { IdentityRoutes } from "../../identity/server/routes.ts";
import { Settings } from "../../shared/server/config.ts";
import { crossOrigin, problem } from "../../shared/server/http.ts";
import { FACTORY_PATH, handle, routesOf } from "./api.ts";
import { Factory } from "./factory.ts";

/** The REST API: the endpoints of each slice, behind one router. */

/** The endpoints of the slices under `/api/factory`. Only for a signed-in person. */
const FactoryRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* Auth;
    const routes = routesOf(yield* Factory);
    const settings = yield* Settings;
    const handler = Effect.gen(function* () {
      const web = yield* HttpServerRequest.toWeb(
        yield* HttpServerRequest.HttpServerRequest
      ).pipe(Effect.orDie);
      if (crossOrigin(web, settings.baseUrl)) {
        return HttpServerResponse.fromWeb(
          problem(403, "forbidden", "Cross-origin requests are not allowed.")
        );
      }
      const user = yield* auth.currentUser(web.headers);
      if (user === null) {
        return HttpServerResponse.fromWeb(
          problem(401, "unauthorized", "Sign in first.")
        );
      }
      return HttpServerResponse.fromWeb(
        yield* Effect.promise(() => handle(routes, web, user.name))
      );
    });
    return Layer.mergeAll(
      HttpRouter.add("*", FACTORY_PATH, handler),
      HttpRouter.add("*", `${FACTORY_PATH}/*`, handler)
    );
  })
);

export const Routes = Layer.mergeAll(
  BoardRoutes,
  FactoryRoutes,
  IdentityRoutes
);
