import { useCallback, useEffect, useState } from "preact/hooks";
import { errorText } from "../../shared/client/api.ts";
import { navigate } from "../../shared/client/route.ts";
import { useNow } from "../../shared/client/time.ts";
import {
  type BoardData,
  BoardMain,
  BoardSide,
  type Connection,
  loadBoard,
  type Run,
} from "./board.tsx";
import type { Sent } from "./composer.tsx";
import { type BoardQuery, boardHref, knownLabels } from "./model.ts";
import { loadThread, type ThreadData, ThreadPane } from "./pane.tsx";

/** The Board page: the channels, the feed or the tasks of the view, and the pane of the open thread. */

/** Board events come in bursts (a task and its reply): one reload for each burst. */
const RELOAD_DELAY_MS = 150;
const TOAST_MS = 8000;

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

export const BoardPage = (props: {
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
