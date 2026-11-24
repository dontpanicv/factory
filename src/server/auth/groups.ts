import { Data, Effect, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { GoogleAuth } from "google-auth-library";
import type { AuthSettings } from "../config.ts";

export class GroupCheckError extends Data.TaggedError("GroupCheckError")<{
  readonly cause: unknown;
}> {}

const MINUTE_MS = 60 * 1000;
const ALLOWED_TTL_MS = 10 * MINUTE_MS;
const ALLOWED_MAX_AGE_MS = 24 * 60 * MINUTE_MS;
const DENIED_TTL_MS = MINUTE_MS;

export interface AccessCheck {
  readonly allowed: boolean;
  readonly checkedAt: number;
}

/**
 * How to use a cached check. "fresh": use it. "stale": use it, and check again in the background, so
 * that no request waits for Google (about 0.5 to 1 second). "expired": check again now.
 * Allowed: fresh for 10 minutes, stale until 24 hours. Denied: fresh for 1 minute.
 */
export const cacheUse = (
  check: AccessCheck,
  now: number
): "fresh" | "stale" | "expired" => {
  const age = now - check.checkedAt;
  if (age < (check.allowed ? ALLOWED_TTL_MS : DENIED_TTL_MS)) {
    return "fresh";
  }
  return check.allowed && age < ALLOWED_MAX_AGE_MS ? "stale" : "expired";
};

export interface GroupAccessShape {
  /** Is the user a member (direct or nested) of the access group? Uses the cache. */
  readonly isAllowed: (
    email: string
  ) => Effect.Effect<boolean, GroupCheckError>;
}

const SCOPE =
  "https://www.googleapis.com/auth/admin.directory.group.member.readonly";

interface HasMemberResponse {
  readonly isMember?: boolean;
}

/**
 * Google Directory API `members.hasMember`, called as the service account.
 * The service account needs the "Groups Reader" admin role. No domain-wide delegation.
 */
export const makeGroupAccess = (auth: AuthSettings) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const scope = yield* Scope.Scope;
    /** The emails with a background check that runs now. */
    const refreshing = new Set<string>();
    const google = new GoogleAuth({
      keyFile: auth.serviceAccountKeyFile,
      scopes: [SCOPE],
    });
    const group = encodeURIComponent(auth.accessGroup);

    const hasMember = (email: string) =>
      Effect.tryPromise({
        catch: (cause) => new GroupCheckError({ cause }),
        try: async () => {
          const client = await google.getClient();
          const response = await client.request<HasMemberResponse>({
            url: `https://admin.googleapis.com/admin/directory/v1/groups/${group}/hasMember/${encodeURIComponent(email)}`,
          });
          return response.data.isMember === true;
        },
      });

    /** Ask Google and store the result. */
    const check = (email: string) =>
      Effect.gen(function* () {
        const allowed = yield* hasMember(email);
        yield* sql`INSERT INTO access_checks (email, allowed, checked_at)
          VALUES (${email}, ${allowed ? 1 : 0}, ${Date.now()})
          ON CONFLICT (email) DO UPDATE SET allowed = excluded.allowed, checked_at = excluded.checked_at`.pipe(
          Effect.orDie
        );
        if (!allowed) {
          yield* Effect.logWarning(`${email} is not in ${auth.accessGroup}`);
        }
        return allowed;
      });

    const refreshInBackground = (email: string) =>
      Effect.gen(function* () {
        if (refreshing.has(email)) {
          return;
        }
        refreshing.add(email);
        // A failure keeps the cached result.
        yield* check(email).pipe(
          Effect.ignore,
          Effect.ensuring(Effect.sync(() => refreshing.delete(email))),
          Effect.forkIn(scope)
        );
      });

    const isAllowed = Effect.fn("GroupAccess.isAllowed")(function* (
      email: string
    ) {
      const [cached] = yield* sql<{ allowed: number; checked_at: number }>`
        SELECT allowed, checked_at FROM access_checks WHERE email = ${email}`.pipe(
        Effect.orDie
      );
      const use =
        cached === undefined
          ? "expired"
          : cacheUse(
              { allowed: cached.allowed === 1, checkedAt: cached.checked_at },
              Date.now()
            );
      if (use === "fresh") {
        return cached?.allowed === 1;
      }
      if (use === "stale") {
        yield* refreshInBackground(email);
        return true;
      }
      return yield* check(email);
    });

    return { isAllowed } satisfies GroupAccessShape;
  });
