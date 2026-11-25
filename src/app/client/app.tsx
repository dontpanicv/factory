import { useEffect, useState } from "preact/hooks";
import { AgentsPage } from "../../agents/client/agents.tsx";
import { RunPage } from "../../agents/client/run.tsx";
import { boardQuery } from "../../board/client/model.ts";
import { BoardPage } from "../../board/client/page.tsx";
import { FlowPage } from "../../flow/client/flow.tsx";
import {
  LoginPage,
  type Session,
  signOut,
  type User,
} from "../../identity/client/login.tsx";
import { errorText } from "../../shared/client/api.ts";
import { followLink, navigate, useUrl } from "../../shared/client/route.ts";
import { Suggestions } from "../../shared/client/select.tsx";
import { useNow } from "../../shared/client/time.ts";
import { SetupPage } from "./setup.tsx";

/** The shell of the pages: the header, and the page of the address. Each page is of one slice. */

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
          <BoardPage query={boardQuery(url)} user={user.name} />
        </main>
      ) : (
        <main class="shell">
          <Pages item={item} page={page} />
        </main>
      )}
    </div>
  );
};
