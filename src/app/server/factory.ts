import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { agentsOf } from "../../agents/server/agents.ts";
import { makeModels } from "../../agents/server/models.ts";
import { startRunner } from "../../agents/server/runner.ts";
import { runsOf } from "../../agents/server/runs.ts";
import { Board } from "../../board/server/board.ts";
import { projectsOf } from "../../projects/server/projects.ts";
import { resourcesOf } from "../../sandbox/server/resources.ts";
import { docker } from "../../sandbox/server/sandbox.ts";
import {
  sealPassphrase,
  secretKey,
  secretsOf,
} from "../../secrets/server/secrets.ts";
import { databaseFile, Settings } from "../../shared/server/config.ts";
import { openDatabase } from "../../shared/server/database.ts";
import { skillsOf } from "../../skills/server/skills.ts";
import type { FactoryParts } from "./api.ts";

/**
 * The composition root of the slices: each slice gets the database and the other slices that it
 * needs, and the runner of the agents starts.
 */
export class Factory extends Context.Service<Factory, FactoryParts>()(
  "factory/Factory"
) {}

export const FactoryLive = Layer.effect(
  Factory,
  Effect.gen(function* () {
    const settings = yield* Settings;
    const board = yield* Board;
    // The runner is not an Effect: its log lines run with the services of this layer.
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    // The migrations made the tables of the slices.
    yield* SqlClient.SqlClient;
    const db = openDatabase(databaseFile(settings));
    const secrets = secretsOf(db, secretKey(sealPassphrase(settings.dataDir)));
    secrets.sealAll();
    const stores = {
      agents: agentsOf(db),
      projects: projectsOf(db),
      resources: resourcesOf(db),
      runs: runsOf(db),
      secrets,
      skills: skillsOf(db),
    };
    const models = makeModels({ secret: secrets.value });
    const provider = docker();
    const runner = yield* Effect.acquireRelease(
      Effect.promise(() =>
        startRunner({
          board: board.team,
          file: join(settings.dataDir, "agents.sqlite"),
          log: (message) => runFork(Effect.logInfo(message)),
          models,
          provider,
          stores,
        })
      ),
      (started) => Effect.promise(() => started.close())
    );
    return { ...stores, board: board.team, models, provider, runner };
  })
);
