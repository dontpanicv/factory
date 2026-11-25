import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import lockfile from "proper-lockfile";

/**
 * The models that agents can use: all providers that Pi knows. A provider gets its key from a
 * Factory secret with the name of the provider's environment variable (`ANTHROPIC_API_KEY`), then
 * from Factory's own environment. A provider with a login (a subscription) uses a login of this
 * computer: for ChatGPT, the login of the Codex CLI (`codex login`), and for the others Pi's
 * (`pi`, then `/login`).
 */

export const PI_AUTH_FILE = join(homedir(), ".pi/agent/auth.json");
export const CODEX_AUTH_FILE = join(
  process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  "auth.json"
);
/** Pi's name of the provider that the ChatGPT login pays for. */
const CODEX_PROVIDER = "openai-codex";
const SECOND_MS = 1000;

const expand = (path: string) =>
  path.startsWith("~") ? join(homedir(), path.slice(1)) : path;

/** Change a JSON file under its lock: other programs that use the file see the old or the new one. */
const update = async <A>(
  file: string,
  change: (content: A) => Promise<A | undefined>
) => {
  const release = await lockfile.lock(file, { retries: 10 });
  try {
    const next = await change(JSON.parse(await readFile(file, "utf8")));
    if (next !== undefined) {
      const draft = `${file}.${process.pid}.tmp`;
      await writeFile(draft, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(draft, file);
    }
  } finally {
    await release();
  }
};

/** Pi's login file. Pi locks the file when it writes it, and so does Factory. */
const piLogins = (file: string): CredentialStore => {
  const read = async (): Promise<Record<string, Credential>> =>
    existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : {};
  return {
    // Factory does not log out of Pi.
    delete: () => Promise.resolve(),
    list: async () =>
      Object.entries(await read()).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      })),
    modify: async (providerId, change) => {
      let result: Credential | undefined;
      if (existsSync(file)) {
        await update<Record<string, Credential>>(file, async (all) => {
          const next = await change(all[providerId]);
          result = next ?? all[providerId];
          return next === undefined
            ? undefined
            : { ...all, [providerId]: next };
        });
      }
      return result;
    },
    read: async (providerId) => (await read())[providerId],
  };
};

/** The login file of the Codex CLI. */
interface CodexAuth {
  readonly last_refresh?: string;
  readonly tokens?: {
    readonly access_token: string;
    readonly account_id?: string;
    readonly refresh_token: string;
  };
}

/** When a token ends, from its own claims. */
const expiry = (token: string) => {
  try {
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString()
    ) as { exp?: number };
    return (claims.exp ?? 0) * SECOND_MS;
  } catch {
    return 0;
  }
};

const fromCodex = (auth: CodexAuth): Credential | undefined =>
  auth.tokens === undefined
    ? undefined
    : {
        access: auth.tokens.access_token,
        accountId: auth.tokens.account_id,
        expires: expiry(auth.tokens.access_token),
        refresh: auth.tokens.refresh_token,
        type: "oauth",
      };

/**
 * Pi's logins, with the ChatGPT login of the Codex CLI in front of Pi's own. A token that Factory
 * renews goes back to the Codex CLI's file, so the Codex CLI stays logged in.
 */
export const logins = (piFile: string, codexFile: string): CredentialStore => {
  const pi = piLogins(piFile);
  const codex = async () =>
    existsSync(codexFile)
      ? fromCodex(JSON.parse(await readFile(codexFile, "utf8")))
      : undefined;
  return {
    delete: pi.delete,
    list: async () => [
      ...(await pi.list()).filter((one) => one.providerId !== CODEX_PROVIDER),
      ...((await codex()) === undefined
        ? (await pi.list()).filter((one) => one.providerId === CODEX_PROVIDER)
        : [{ providerId: CODEX_PROVIDER, type: "oauth" as const }]),
    ],
    modify: async (providerId, change) => {
      if (providerId !== CODEX_PROVIDER || (await codex()) === undefined) {
        return pi.modify(providerId, change);
      }
      let result: Credential | undefined;
      await update<CodexAuth>(codexFile, async (auth) => {
        const next = await change(fromCodex(auth));
        result = next ?? fromCodex(auth);
        return next?.type === "oauth" && auth.tokens !== undefined
          ? {
              ...auth,
              last_refresh: new Date().toISOString(),
              tokens: {
                ...auth.tokens,
                access_token: next.access,
                refresh_token: next.refresh,
              },
            }
          : undefined;
      });
      return result;
    },
    read: async (providerId) =>
      (providerId === CODEX_PROVIDER ? await codex() : undefined) ??
      pi.read(providerId),
  };
};

export const makeModels = (options: {
  readonly codexAuthFile?: string;
  readonly piAuthFile?: string;
  readonly secret: (name: string) => string | undefined;
}): MutableModels => {
  // The login flows are in the executable: `bun build --compile` cannot load them later.
  registerBunOAuthFlows();
  return builtinModels({
    authContext: {
      env: (name) => Promise.resolve(options.secret(name) ?? process.env[name]),
      fileExists: (path) => Promise.resolve(existsSync(expand(path))),
    },
    credentials: logins(
      options.piAuthFile ?? PI_AUTH_FILE,
      options.codexAuthFile ?? CODEX_AUTH_FILE
    ),
  });
};

/** `provider/model` of each model that has its credentials. */
export const availableModels = async (models: MutableModels) =>
  (await models.getAvailable()).map((model) => `${model.provider}/${model.id}`);
