import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Board } from "../board.ts";
import { databaseFile, Settings } from "../config.ts";
import type { FactoryParts } from "./api.ts";
import { makeModels } from "./models.ts";
import { startRunner } from "./runner.ts";
import { docker } from "./sandbox.ts";
import { Store } from "./store.ts";

/** The agents of Factory in this process: their definitions, their sandboxes and their runs. */
export class Factory extends Context.Service<Factory, FactoryParts>()(
  "factory/Factory"
) {}

export const FactoryLive = Layer.effect(
  Factory,
  Effect.gen(function* () {
    const settings = yield* Settings;
    const board = yield* Board;
    // The migrations made the tables of the store.
    yield* SqlClient.SqlClient;
    const store = new Store(databaseFile(settings));
    const models = makeModels({ secret: (name) => store.secret(name) });
    const provider = docker();
    const runner = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startRunner({
          board: board.team,
          file: join(settings.dataDir, "agents.sqlite"),
          log: (message) => Effect.runFork(Effect.logInfo(message)),
          models,
          provider,
          store,
        })
      ),
      (started) => Effect.promise(() => started.close())
    );
    return { board: board.team, models, provider, runner, store };
  })
);
