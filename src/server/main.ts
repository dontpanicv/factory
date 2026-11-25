import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import spa from "../client/index.html";
import { AuthLive } from "./auth/auth.ts";
import { BoardLive } from "./board.ts";
import { Settings, SettingsLive } from "./config.ts";
import { DatabaseLive } from "./db.ts";
import { FactoryLive } from "./factory/factory.ts";
import { Routes } from "./routes.ts";

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
  Layer.provide(DatabaseLive),
  Layer.provide(Layer.mergeAll(SettingsLive, BunServices.layer)),
  Layer.launch,
  BunRuntime.runMain
);
