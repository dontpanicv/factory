import { useCallback, useEffect, useState } from "preact/hooks";
import {
  type BoardData,
  BoardMain,
  BoardSide,
  Composer,
  loadBoard,
  NewChannel,
  type Run,
} from "./board.tsx";
import { type BoardQuery, boardHref, boardQuery } from "./model.ts";
import { loadThread, TaskPane, type ThreadData } from "./pane.tsx";
import { followLink, navigate, useUrl } from "./route.ts";

const TICK_MS = 15_000;
/** Board events come in bursts (a task and its reply): one reload for each burst. */
const RELOAD_DELAY_MS = 150;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A number that grows with each board event, so the views load again. */
const useBoardVersion = () => {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const events = new EventSource("/api/board/events");
    events.addEventListener("board", () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => setVersion((value) => value + 1),
        RELOAD_DELAY_MS
      );
    });
    return () => {
      clearTimeout(timer);
      events.close();
    };
  }, []);
  return [version, () => setVersion((value) => value + 1)] as const;
};

const useNow = () => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
};

const Board = (props: {
  readonly query: BoardQuery;
  readonly user: string;
}) => {
  const { query } = props;
  const now = useNow();
  const [version, reload] = useBoardVersion();
  const [data, setData] = useState<BoardData | null>(null);
  const [thread, setThread] = useState<ThreadData | null | undefined>(
    undefined
  );
  const [error, setError] = useState<string | null>(null);
  const listKey = boardHref(query, { thread: null });

  // biome-ignore lint/correctness/useExhaustiveDependencies: listKey stands for the query of the list.
  useEffect(() => {
    let current = true;
    loadBoard(query)
      .then((next) => current && setData(next))
      .catch((failure) => current && setError(errorText(failure)));
    return () => {
      current = false;
    };
  }, [listKey, version]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version is a board event, so the thread loads again.
  useEffect(() => {
    let current = true;
    if (query.thread === null) {
      setThread(undefined);
      return;
    }
    loadThread(query.thread)
      .then((next) => current && setThread(next))
      .catch((failure) => current && setError(errorText(failure)));
    return () => {
      current = false;
    };
  }, [query.thread, version]);

  const run: Run = useCallback(
    async (write) => {
      setError(null);
      try {
        await write();
        return true;
      } catch (failure) {
        setError(errorText(failure));
        return false;
      } finally {
        reload();
      }
    },
    [reload]
  );

  const pane = query.thread !== null && thread !== undefined;
  return (
    <>
      {error === null ? null : (
        <div class="notice notice--bad" role="alert">
          {error}
        </div>
      )}
      <div class={pane ? "board-app board-app--pane" : "board-app"}>
        <aside class="side">
          <div class="side__scroll">
            {data === null ? null : <BoardSide data={data} query={query} />}
          </div>
          <NewChannel query={query} run={run} />
        </aside>
        <section class="view">
          {data === null ? (
            <p class="hint view__empty">Loading…</p>
          ) : (
            <>
              <BoardMain data={data} now={now} query={query} />
              <Composer data={data} query={query} run={run} />
            </>
          )}
        </section>
        {pane ? (
          <aside class="pane">
            <TaskPane
              data={thread}
              now={now}
              query={query}
              run={run}
              user={props.user}
            />
          </aside>
        ) : null}
      </div>
    </>
  );
};

interface User {
  readonly email: string;
  readonly local: boolean;
  readonly name: string;
}

interface Session {
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

const LoginPage = (props: {
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

const signOut = async () => {
  await fetch("/api/auth/sign-out", {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  location.assign("/login");
};

const Header = (props: { readonly user: User }) => (
  <header class="header">
    <div class="header__inner">
      <a class="brand" href="/board">
        <span class="brand__mark">F</span>
        Factory
      </a>
      <nav class="nav">
        <a aria-current="page" href="/board">
          Board
        </a>
      </nav>
      <div class="header__end">
        <span class="label header__email">{props.user.email}</span>
        {props.user.local ? (
          <span
            class="chip chip--queued"
            title="Google sign-in is not configured"
          >
            local mode
          </span>
        ) : (
          <button
            class="button button--secondary button--small"
            onClick={signOut}
            type="button"
          >
            Sign out
          </button>
        )}
      </div>
    </div>
  </header>
);

export const App = () => {
  const url = useUrl();
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    fetch("/api/session")
      .then((response) => response.json() as Promise<Session>)
      .then(setSession)
      .catch((failure) =>
        setSession({
          error: { code: "error", message: errorText(failure) },
          mode: "local",
        })
      );
  }, []);
  const user = session?.user ?? null;
  const login = url.pathname === "/login";
  useEffect(() => {
    if (session === null) {
      return;
    }
    if (user === null && !login && session.mode === "google") {
      navigate("/login");
    } else if (user !== null && (login || url.pathname === "/")) {
      navigate("/board");
    }
  }, [session, user, login, url]);
  if (session === null) {
    return null;
  }
  if (user === null) {
    return (
      <LoginPage error={url.searchParams.get("error")} session={session} />
    );
  }
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: the links inside handle the keys; this only routes their clicks.
    <div class="app" onClick={followLink}>
      <Header user={user} />
      <main class="page page--compact">
        <Board query={boardQuery(url)} user={user.email} />
      </main>
    </div>
  );
};
