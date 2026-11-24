import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Auth } from "./auth/auth.ts";
import { Board } from "./board.ts";
import { Settings } from "./config.ts";

/** The REST API: the board's own API, the session, and the Better Auth endpoints. */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const toWeb = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerRequest.toWeb(request).pipe(Effect.orDie);

/** A state-changing request must come from the Factory origin. */
export const crossOrigin = (request: Request, baseUrl: string) => {
  const origin = request.headers.get("origin");
  return (
    !SAFE_METHODS.has(request.method) &&
    origin !== null &&
    origin !== new URL(baseUrl).origin
  );
};

const forbidden = (message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: { code: "forbidden", message } },
    { status: 403 }
  );

/** The board's REST API. The board checks the session itself (`authenticate` in board.ts). */
const boardApi = Effect.gen(function* () {
  const board = yield* Board;
  const settings = yield* Settings;
  const web = yield* toWeb(yield* HttpServerRequest.HttpServerRequest);
  if (crossOrigin(web, settings.baseUrl)) {
    return forbidden("Cross-origin requests are not allowed.");
  }
  return HttpServerResponse.fromWeb(
    yield* Effect.promise(() => board.fetch(web))
  );
});

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

export const Routes = Layer.mergeAll(
  HttpRouter.add("*", "/api/board", boardApi),
  HttpRouter.add("*", "/api/board/*", boardApi),
  HttpRouter.add("GET", "/api/session", session),
  HttpRouter.add("*", "/api/auth/*", betterAuth),
  HttpRouter.add("GET", "/login/google", googleSignIn)
);
