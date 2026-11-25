import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Settings } from "../../shared/server/config.ts";
import { Auth } from "./auth.ts";

/** The endpoints of the sign-in: the session, the Better Auth endpoints, and the start of the Google sign-in. */

const toWeb = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerRequest.toWeb(request).pipe(Effect.orDie);

/** The signed-in person, or 401: the SPA then shows the sign-in page. */
const session = Effect.gen(function* () {
  const auth = yield* Auth;
  const settings = yield* Settings;
  const web = yield* toWeb(yield* HttpServerRequest.HttpServerRequest);
  const user = yield* auth.currentUser(web.headers);
  if (user === null) {
    return HttpServerResponse.jsonUnsafe(
      {
        error:
          auth.mode === "local"
            ? {
                code: "local_only",
                message:
                  "Factory runs in local mode. Open it on this computer (localhost).",
              }
            : { code: "unauthorized", message: "Sign in first." },
        mode: auth.mode,
        workspaceDomain:
          settings.auth._tag === "Some"
            ? settings.auth.value.workspaceDomain
            : null,
      },
      { status: 401 }
    );
  }
  return HttpServerResponse.jsonUnsafe({ mode: auth.mode, user });
});

const betterAuth = Effect.gen(function* () {
  const auth = yield* Auth;
  const web = yield* toWeb(yield* HttpServerRequest.HttpServerRequest);
  return HttpServerResponse.fromWeb(yield* auth.handler(web));
});

/** Start the Google sign-in: Better Auth answers the Google URL and sets its state cookie. */
const googleSignIn = Effect.gen(function* () {
  const auth = yield* Auth;
  const settings = yield* Settings;
  const response = yield* auth.handler(
    new Request(`${settings.baseUrl}/api/auth/sign-in/social`, {
      body: JSON.stringify({
        callbackURL: "/",
        errorCallbackURL: "/login",
        provider: "google",
      }),
      headers: {
        "content-type": "application/json",
        origin: new URL(settings.baseUrl).origin,
      },
      method: "POST",
    })
  );
  const body = (yield* Effect.promise(() => response.json())) as {
    url?: string;
  };
  const headers = new Headers({
    location: body.url ?? "/login?error=google_unavailable",
  });
  for (const cookie of response.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return HttpServerResponse.fromWeb(
    new Response(null, { headers, status: 303 })
  );
});

export const IdentityRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/session", session),
  HttpRouter.add("*", "/api/auth/*", betterAuth),
  HttpRouter.add("GET", "/login/google", googleSignIn)
);
