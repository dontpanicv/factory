import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { Board } from "../board.ts";
import { databaseFile, Settings } from "../config.ts";
import type { FactoryParts } from "./api.ts";
import { makeModels } from "./models.ts";
import { startRunner } from "./runner.ts";
import { docker } from "./sandbox.ts";
import { Store, secretKey } from "./store.ts";

/** The agents of Factory in this process: their definitions, their sandboxes and their runs. */
export class Factory extends Context.Service<Factory, FactoryParts>()(
  "factory/Factory"
) {}

/**
 * The passphrase that seals the secrets: `FACTORY_SECRET_KEY`, or a key file that Factory makes in
 * its data directory. With the key file, a copy of the database alone does not give the secrets;
 * with `FACTORY_SECRET_KEY`, a copy of the whole data directory does not.
 */
const sealPassphrase = (dataDir: string) => {
  const fromEnv = process.env.FACTORY_SECRET_KEY;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const file = join(dataDir, "secret.key");
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  return readFileSync(file, "utf8").trim();
};

export const FactoryLive = Layer.effect(
  Factory,
  Effect.gen(function* () {
    const settings = yield* Settings;
    const board = yield* Board;
    // The migrations made the tables of the store.
    yield* SqlClient.SqlClient;
    const store = new Store(
      databaseFile(settings),
      secretKey(sealPassphrase(settings.dataDir))
    );
    store.sealSecrets();
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
