import { json, type Route } from "../../shared/server/http.ts";
import type { Secrets } from "./secrets.ts";

/** `POST /secrets` sets a secret and `DELETE /secrets/<name>` removes one. No endpoint answers a value. */
export const secretsRoute =
  (secrets: Secrets): Route =>
  async ({ body, method, path }) => {
    const [name] = path;
    if (name === undefined && method === "POST") {
      const input = await body();
      secrets.set(String(input.name ?? ""), String(input.value ?? ""));
      return json({ ok: true });
    }
    if (name !== undefined && method === "DELETE") {
      secrets.remove(name);
      return json({ ok: true });
    }
    return null;
  };
