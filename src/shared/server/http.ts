import type { Definitions } from "./database.ts";

/** What the slices share for their REST endpoints under `/api/factory`. */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** A state-changing request must come from the Factory origin. */
export const crossOrigin = (request: Request, baseUrl: string) => {
  const origin = request.headers.get("origin");
  return (
    !SAFE_METHODS.has(request.method) &&
    origin !== null &&
    origin !== new URL(baseUrl).origin
  );
};

/** A run's claim on its task is a credential: it stays in the server. */
export const json = (body: unknown, status = 200) =>
  new Response(
    JSON.stringify(body, (key, value) => (key === "claim" ? undefined : value)),
    { headers: { "content-type": "application/json" }, status }
  );

export const problem = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

/** One request of a signed-in person. `path` is the parts of the address after the slice's own part. */
export interface Call {
  readonly body: () => Promise<Record<string, unknown>>;
  /** Who asks. */
  readonly by: string;
  readonly method: string;
  readonly path: readonly string[];
  readonly query: URLSearchParams;
}

/** The answer of a route, or null when the route has no such endpoint. */
export type Answer = Promise<Response | null>;
export type Route = (call: Call) => Answer;

/**
 * The endpoints that each kind of definition has: `POST /` saves one and `DELETE /<name>` removes
 * one. `save` and `remove` replace the plain write when a slice does more.
 */
export const definitionRoute =
  <T>(
    store: Definitions<T>,
    options: {
      readonly remove?: (name: string) => Promise<void>;
      readonly save?: (input: Record<string, unknown>) => Promise<T>;
    } = {}
  ): Route =>
  async ({ body, method, path }) => {
    const [name, ...rest] = path;
    if (name === undefined && method === "POST") {
      const input = await body();
      return json(
        options.save === undefined
          ? store.put(input)
          : await options.save(input)
      );
    }
    if (name !== undefined && rest.length === 0 && method === "DELETE") {
      await (options.remove === undefined
        ? Promise.resolve(store.remove(name))
        : options.remove(name));
      return json({ ok: true });
    }
    return null;
  };
