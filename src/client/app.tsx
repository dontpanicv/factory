import { useCallback, useEffect, useState } from "preact/hooks";
import { AgentsPage } from "./agents.tsx";
import {
  type BoardData,
  BoardMain,
  BoardSide,
  type Connection,
  loadBoard,
  type Run,
} from "./board.tsx";
import type { Sent } from "./composer.tsx";
import { FlowPage } from "./flow.tsx";
import {
  type BoardQuery,
  boardHref,
  boardQuery,
  knownLabels,
} from "./model.ts";
import { loadThread, type ThreadData, ThreadPane } from "./pane.tsx";
import { followLink, navigate, useUrl } from "./route.ts";
import { RunPage } from "./run.tsx";
import { Suggestions } from "./select.tsx";
import { SetupPage } from "./setup.tsx";

const TICK_MS = 15_000;
/** Board events come in bursts (a task and its reply): one reload for each burst. */
const RELOAD_DELAY_MS = 150;
const TOAST_MS = 8000;

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * A number that grows with each board event, so the views load again, and the state of the feed's connection.
 * EventSource reconnects by itself after a drop.
 */
const useBoardEvents = () => {
  const [version, setVersion] = useState(0);
  const [connection, setConnection] = useState<Connection>("connecting");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const events = new EventSource("/api/board/events");
    events.addEventListener("open", () => setConnection("live"));
    events.addEventListener("error", () => setConnection("retrying"));
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
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { connection, reload, version };
};

const useNow = () => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
};

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));

/** Esc closes the thread pane; a key typed outside a field goes to the reply composer. */
const useKeys = (query: BoardQuery) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      if (event.key === "Escape" && query.thread !== null) {
        navigate(boardHref(query, { thread: null }));
        return;
      }
      const printable =
        event.key.length === 1 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey;
      // The open thread's composer first, as the viewer does.
      const composer =
        document.querySelector<HTMLElement>('[data-composer="reply"]') ??
        document.querySelector<HTMLElement>('[data-composer="main"]');
      if (printable && !isTyping(event.target) && composer !== null) {
        composer.focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [query]);
};

const Board = (props: {
  readonly query: BoardQuery;
  readonly user: string;
}) => {
  const { query } = props;
  const now = useNow();
  const { connection, reload, version } = useBoardEvents();
  useKeys(query);
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

  useEffect(() => {
    if (error === null) {
      return;
    }
    const timer = setTimeout(() => setError(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [error]);
  const dismiss = () => setError(null);

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

  /** After a post: open the new thread, and load the views again. */
  const sent = useCallback(
    ({ id }: Sent) => {
      if (id !== null) {
        navigate(boardHref(query, { thread: id }));
      }
      reload();
    },
    [query, reload]
  );
  const known = knownLabels(data?.open ?? []);

  // On a narrow screen the sidebar opens over the board, and closes when the view changes.
  const [side, setSide] = useState(false);
  const toggleSide = () => setSide((open) => !open);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new view closes the sidebar.
  useEffect(() => setSide(false), [listKey, query.thread]);

  const pane = query.thread !== null && thread !== undefined;
  const classes = ["board"];
  if (pane) {
    classes.push("board--pane");
  }
  if (side) {
    classes.push("board--side");
  }
  return (
    <div class={classes.join(" ")}>
      {data === null ? (
        <p class="empty">Loading…</p>
      ) : (
        <>
          <BoardSide data={data} query={query} run={run} user={props.user} />
          <BoardMain
            connection={connection}
            data={data}
            now={now}
            onError={setError}
            onMenu={toggleSide}
            onSent={sent}
            query={query}
          />
        </>
      )}
      {pane ? (
        <ThreadPane
          data={thread}
          known={known}
          now={now}
          onError={setError}
          onSent={sent}
          query={query}
          run={run}
        />
      ) : null}
      {error === null ? null : (
        <div class="toast" role="alert">
          <span>{error}</span>
          <button
            aria-label="Dismiss"
            class="toast__close"
            onClick={dismiss}
            type="button"
          >
            ×
          </button>
        </div>
      )}
    </div>
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

const PAGES = [
  { href: "/board", title: "Board" },
  { href: "/agents", title: "Agents" },
  { href: "/flow", title: "Flow" },
  { href: "/setup", title: "Setup" },
];

/** The page of an address: `/agents/sre` is `agents` with `sre`. A run's log belongs to Agents. */
const pageOf = (pathname: string) => {
  const [page = "board", item = null] = pathname.split("/").filter(Boolean);
  return { item: item === null ? null : decodeURIComponent(item), page };
};

const Header = (props: { readonly page: string; readonly user: User }) => (
  <header class="header">
    <div class="header__inner">
      <a class="brand" href="/board">
        <span class="brand__mark">F</span>
        Factory
      </a>
      <nav class="nav">
        {PAGES.map((page) => (
          <a
            aria-current={
              page.href === `/${props.page === "runs" ? "agents" : props.page}`
                ? "page"
                : undefined
            }
            href={page.href}
            key={page.href}
          >
            {page.title}
          </a>
        ))}
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

/** The pages of the agents. */
const Pages = (props: {
  readonly item: string | null;
  readonly page: string;
}) => {
  const now = useNow();
  if (props.page === "runs" && props.item !== null) {
    return <RunPage id={props.item} key={props.item} now={now} />;
  }
  if (props.page === "flow") {
    return <FlowPage />;
  }
  if (props.page === "setup") {
    return <SetupPage tab={props.item} />;
  }
  return <AgentsPage name={props.item} now={now} />;
};

export const App = () => {
  const url = useUrl();
  const { item, page } = pageOf(url.pathname);
  useEffect(() => {
    const title = PAGES.find(
      (one) => one.href === `/${page === "runs" ? "agents" : page}`
    )?.title;
    document.title = `${title ?? "Factory"} · Factory`;
  }, [page]);
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
      <Header page={page} user={user} />
      <Suggestions />
      {page === "board" ? (
        <main class="board-shell">
          <Board query={boardQuery(url)} user={user.name} />
        </main>
      ) : (
        <main class="shell">
          <Pages item={item} page={page} />
        </main>
      )}
    </div>
  );
};
