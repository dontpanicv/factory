/** The sign-in page, and who is signed in. */

export interface User {
  readonly email: string;
  readonly local: boolean;
  readonly name: string;
}

export interface Session {
  readonly error?: { readonly code: string; readonly message: string };
  readonly mode: "google" | "local";
  readonly user?: User;
  readonly workspaceDomain?: string | null;
}

const LOGIN_ERRORS: Record<string, string> = {
  not_in_group:
    "Your account is not in the Factory access group. Ask an administrator to add you.",
  wrong_domain: "Use your Google Workspace account.",
};

export const LoginPage = (props: {
  readonly error: string | null;
  readonly session: Session;
}) => (
  <div class="login">
    <div class="card card--feature login__card">
      <div class="stack">
        <span class="brand">
          <span class="brand__mark">F</span>
          Factory
        </span>
        <h1 class="title">
          Software <em>Factory</em>
        </h1>
        {props.session.mode === "local" ? (
          <div class="notice notice--bad">{props.session.error?.message}</div>
        ) : (
          <>
            <p class="lede">
              {`Sign in with your ${props.session.workspaceDomain ?? "Google"} account.`}
            </p>
            {props.error === null ? null : (
              <div class="notice notice--bad">
                {LOGIN_ERRORS[props.error] ??
                  `The sign-in failed (${props.error}).`}
              </div>
            )}
            <a class="button button--primary" href="/login/google">
              Sign in with Google
            </a>
          </>
        )}
      </div>
    </div>
  </div>
);

export const signOut = async () => {
  await fetch("/api/auth/sign-out", {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  location.assign("/login");
};
