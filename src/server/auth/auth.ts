import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { type AuthSettings, databaseFile, Settings } from "../config.ts";
import { makeGroupAccess } from "./groups.ts";

export interface User {
  readonly email: string;
  readonly id: string;
  readonly image: string | null;
  /** Local mode: the user is the person at this computer. */
  readonly local: boolean;
  readonly name: string;
}

export type AuthMode = "google" | "local";

export interface AuthShape {
  /** The signed-in user. In Google mode the session must be valid and the user must still be in the access group. */
  readonly currentUser: (headers: Headers) => Effect.Effect<User | null>;
  /** The better-auth handler for `/api/auth/*`. Local mode has no auth endpoints. */
  readonly handler: (request: Request) => Effect.Effect<Response>;
  readonly mode: AuthMode;
}

export class Auth extends Context.Service<Auth, AuthShape>()("factory/Auth") {}

const SESSION_DAYS = 7;
const DAY_SECONDS = 24 * 60 * 60;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True when the Host header names this computer (localhost, 127.0.0.1, ::1 or a *.localhost name). */
export const isLocalHost = (host: string | null) => {
  if (host === null) {
    return false;
  }
  const name = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : (host.split(":")[0] ?? "");
  return LOCAL_HOSTS.has(name) || name.endsWith(".localhost");
};

/**
 * Local mode, when Google sign-in is not configured. The server listens on 127.0.0.1 only, and a request
 * must name a local host (this also stops DNS rebinding). There is no sign-in.
 */
const localAuth = (name: string): AuthShape => ({
  currentUser: (headers) =>
    Effect.succeed(
      isLocalHost(headers.get("host"))
        ? { email: name, id: "local", image: null, local: true, name }
        : null
    ),
  handler: () =>
    Effect.succeed(new Response("Local mode has no sign-in.", { status: 404 })),
  mode: "local",
});

const googleAuth = (settings: AuthSettings, baseUrl: string, file: string) =>
  Effect.gen(function* () {
    const groups = yield* makeGroupAccess(settings);
    const domain = settings.workspaceDomain;

    const database = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const db = new Database(file);
        db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
        return db;
      }),
      (db) => Effect.sync(() => db.close())
    );

    const allowed = (email: string) =>
      groups
        .isAllowed(email)
        .pipe(
          Effect.catch((error) =>
            Effect.logError(
              "The group check failed. Access is denied.",
              error
            ).pipe(Effect.as(false))
          )
        );

    const auth = betterAuth({
      appName: "Factory",
      baseURL: baseUrl,
      database,
      onAPIError: { errorURL: "/login" },
      secret: Redacted.value(settings.secret),
      session: {
        expiresIn: SESSION_DAYS * DAY_SECONDS,
        updateAge: DAY_SECONDS,
      },
      socialProviders: {
        google: {
          clientId: settings.googleClientId,
          clientSecret: Redacted.value(settings.googleClientSecret),
          hd: domain,
          prompt: "select_account",
        },
      },
      trustedOrigins: [baseUrl],
      user: {
        validateUserInfo: async ({ user }) => {
          const email = typeof user.email === "string" ? user.email : "";
          if (!email.endsWith(`@${domain}`)) {
            return { error: "wrong_domain" };
          }
          const ok = await Effect.runPromise(allowed(email));
          return ok ? undefined : { error: "not_in_group" };
        },
      },
    });

    const migrations = yield* Effect.promise(() => getMigrations(auth.options));
    yield* Effect.promise(() => migrations.runMigrations());

    const currentUser = (headers: Headers) =>
      Effect.gen(function* () {
        const session = yield* Effect.tryPromise(() =>
          auth.api.getSession({ headers })
        ).pipe(Effect.orElseSucceed(() => null));
        if (session === null) {
          return null;
        }
        const { user } = session;
        if (!(yield* allowed(user.email))) {
          return null;
        }
        return {
          email: user.email,
          id: user.id,
          image: user.image ?? null,
          local: false,
          name: user.name,
        } satisfies User;
      });

    return {
      currentUser,
      handler: (request: Request) =>
        Effect.promise(() => auth.handler(request)),
      mode: "google",
    } satisfies AuthShape;
  });

export const AuthLive = Layer.effect(
  Auth,
  Effect.gen(function* () {
    const settings = yield* Settings;
    return Option.isSome(settings.auth)
      ? yield* googleAuth(
          settings.auth.value,
          settings.baseUrl,
          databaseFile(settings)
        )
      : localAuth(settings.localUser);
  })
);
