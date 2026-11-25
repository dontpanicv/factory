import type { Database } from "bun:sqlite";
import { Schema } from "effect";
import type { Secrets } from "../../secrets/server/secrets.ts";
import { definitions } from "../../shared/server/database.ts";
import { Name, names, text } from "../../shared/server/schema.ts";
import type { ResourceSpec } from "./sandbox.ts";

/**
 * Shared resources: containers that run one time for all sandboxes (a database, a search engine).
 * A sandbox reaches the resources of its agent by their names.
 */

export const Resource = Schema.Struct({
  /** The command of the container. Empty: the command of the image. */
  command: text(),
  /** A container that runs already and Factory does not start: sandboxes reach it by the resource's name. */
  container: text(),
  description: text(),
  /** `KEY=value` lines. */
  env: text(),
  image: text(),
  name: Name,
  /** Secrets that the container gets as environment variables. */
  secrets: names,
});
export type Resource = typeof Resource.Type;

export const resourcesOf = (db: Database) =>
  definitions<Resource>(db, "resources", Schema.decodeUnknownSync(Resource));

/** `KEY=value` lines as a record. Lines without `=` are ignored. */
export const parseEnv = (lines: string) => {
  const env: Record<string, string> = {};
  for (const line of lines.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) {
      env[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
  }
  return env;
};

/** A shared resource as its sandbox provider starts it: with its environment and its secrets. */
export const resourceSpec = (
  resource: Resource,
  secrets: Secrets
): ResourceSpec => ({
  command: resource.command,
  container: resource.container,
  env: { ...parseEnv(resource.env), ...secrets.values(resource.secrets) },
  image: resource.image,
  name: resource.name,
});
