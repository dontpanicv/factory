import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import spa from "./app/client/index.html";
import { FactoryLive } from "./app/server/factory.ts";
import { migrations } from "./app/server/migrations.ts";
import { Routes } from "./app/server/routes.ts";
import { BoardLive } from "./board/server/board.ts";
import { AuthLive } from "./identity/server/auth.ts";
import { Settings, SettingsLive } from "./shared/server/config.ts";
import { databaseLayer } from "./shared/server/database.ts";

/**
 * The server of Factory: one process that serves the SPA and the REST API, and runs the agents.
 * Factory is a modular monolith: each directory of `src` is a slice of the domain with its
 * `server` and its `client` (AGENTS.md).
 */

/** Bun closes idle connections after this many seconds. The board's event stream pings every 15 seconds. */
const IDLE_TIMEOUT_SECONDS = 120;
const production = process.env.NODE_ENV === "production";

const HttpLive = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* Settings;
    yield* Effect.logInfo(
      `Factory listens on ${settings.baseUrl} (127.0.0.1:${settings.port}, ${settings.auth._tag === "Some" ? "Google sign-in" : "local mode"})`
    );
    return HttpRouter.serve(Routes).pipe(
      Layer.provide(
        BunHttpServer.layer({
          // Bun bundles the SPA: on the fly with hot reload in development, once in production.
          development: production ? false : { console: true, hmr: true },
          // A reverse proxy on the same host (portless) connects to it.
          hostname: "127.0.0.1",
          idleTimeout: IDLE_TIMEOUT_SECONDS,
          port: settings.port,
          routes: {
            "/": spa,
            "/agents": spa,
            "/agents/*": spa,
            "/board": spa,
            "/board/*": spa,
            "/flow": spa,
            "/login": spa,
            "/runs/*": spa,
            "/setup": spa,
            "/setup/*": spa,
          },
        })
      )
    );
  })
);

HttpLive.pipe(
  Layer.provide(FactoryLive),
  Layer.provideMerge(BoardLive),
  Layer.provideMerge(AuthLive),
  Layer.provide(databaseLayer(migrations)),
  Layer.provide(Layer.mergeAll(SettingsLive, BunServices.layer)),
  Layer.launch,
  BunRuntime.runMain
);
