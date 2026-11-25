import type { Secrets } from "../../secrets/server/secrets.ts";
import type { Definitions } from "../../shared/server/database.ts";
import {
  definitionRoute,
  json,
  problem,
  type Route,
} from "../../shared/server/http.ts";
import { type Resource, resourceSpec } from "./resources.ts";
import type { SandboxProvider } from "./sandbox.ts";

/**
 * The endpoints of the shared resources: save, remove, and `POST /resources/<name>/start` or
 * `/stop`.
 */

interface Parts {
  readonly provider: SandboxProvider;
  readonly resources: Definitions<Resource>;
  readonly secrets: Secrets;
}

/** The shared resources with the state of each: `running`, `stopped`, or `unknown` without a provider. */
export const resourceStates = async ({
  provider,
  resources,
  secrets,
}: Parts) => {
  const all = resources.list();
  const states = await provider
    .resourceStates(all.map((resource) => resourceSpec(resource, secrets)))
    .catch(() => null);
  return all.map((resource) => ({
    ...resource,
    state: states === null ? "unknown" : (states[resource.name] ?? "stopped"),
  }));
};

/** Save a shared resource. One that runs starts again, so the change applies at once. */
const save = async (parts: Parts, input: Record<string, unknown>) => {
  const { provider, resources, secrets } = parts;
  if ((input.image ?? "") === "" && (input.container ?? "") === "") {
    throw new Error(
      "A shared resource needs an image, or the name of a container that runs."
    );
  }
  const before = resources.get(String(input.name ?? ""));
  const old = before === null ? null : resourceSpec(before, secrets);
  const states: Record<string, string> =
    old === null ? {} : await provider.resourceStates([old]).catch(() => ({}));
  const saved = resources.put(input);
  if (old !== null && states[old.name] === "running") {
    await provider.resourceDown(old);
    await provider.resourceUp(resourceSpec(saved, secrets));
  }
  return saved;
};

export const resourcesRoute = (parts: Parts): Route => {
  const { provider, resources, secrets } = parts;
  const definition = definitionRoute(resources, {
    remove: async (name) => {
      const resource = resources.get(name);
      resources.remove(name);
      if (resource !== null) {
        await provider.resourceDown(resourceSpec(resource, secrets));
      }
    },
    save: (input) => save(parts, input),
  });
  return async (call) => {
    const [name, action] = call.path;
    if (name === undefined || action === undefined || call.method !== "POST") {
      return definition(call);
    }
    const resource = resources.get(name);
    if (resource === null) {
      return problem(404, "not_found", "No such resource.");
    }
    // A start makes a new container, so a saved change applies.
    const spec = resourceSpec(resource, secrets);
    await provider.resourceDown(spec);
    if (action === "start") {
      await provider.resourceUp(spec);
    }
    return json({ ok: true });
  };
};
