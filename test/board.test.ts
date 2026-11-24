import { expect, test } from "bun:test";
import {
  boardHref,
  boardQuery,
  parseLabels,
  parseNeeds,
  stateNow,
  type TaskView,
} from "../src/client/model.ts";
import { makeBoard } from "../src/server/board.ts";
import { crossOrigin } from "../src/server/routes.ts";

const URL_BASE = "http://localhost:4310/api/board";
const person = {
  email: "ada@example.com",
  id: "1",
  image: null,
  local: false,
  name: "Ada",
};

const boardFor = (signedIn: boolean) =>
  makeBoard({
    currentUser: (headers) =>
      Promise.resolve(
        signedIn && headers.get("cookie") === "s=1" ? person : null
      ),
    dir: null,
    url: URL_BASE,
  });

const call = (
  board: ReturnType<typeof makeBoard>,
  path: string,
  body?: unknown
) =>
  board.fetch(
    new Request(`${URL_BASE}${path}`, {
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), method: "POST" }),
      headers: { "content-type": "application/json", cookie: "s=1" },
    })
  );

test("a signed-in person creates a task as themselves", async () => {
  const board = boardFor(true);
  expect((await call(board, "/channels", { path: "fix/web" })).status).toBe(
    201
  );
  const created = await call(board, "/tasks", {
    channel: "fix/web",
    text: "Fix it",
  });
  expect(created.status).toBe(201);
  const { task } = (await created.json()) as {
    task: { by: { actor: string }; task: { state: string } };
  };
  expect(task.by.actor).toBe("factory:user:ada@example.com");
  expect(task.task.state).toBe("ready");
});

test("a request without a session is refused", async () => {
  const response = await call(boardFor(false), "/tasks");
  expect(response.status).toBe(401);
});

test("writes from another origin are refused, reads are not", () => {
  const write = (origin: string) =>
    new Request(URL_BASE, { headers: { origin }, method: "POST" });
  expect(
    crossOrigin(write("https://evil.example"), "http://localhost:4310")
  ).toBe(true);
  expect(
    crossOrigin(write("http://localhost:4310"), "http://localhost:4310")
  ).toBe(false);
  expect(
    crossOrigin(
      new Request(URL_BASE, { headers: { origin: "https://evil.example" } }),
      "http://localhost:4310"
    )
  ).toBe(false);
});

test("the board URL round-trips", () => {
  const query = boardQuery(
    new URL("http://x/board/tasks?channel=fix/&state=blocked&thread=12")
  );
  expect(query).toEqual({
    channel: "fix/",
    state: "blocked",
    thread: "12",
    view: "tasks",
  });
  expect(boardHref(query)).toBe(
    "/board/tasks?channel=fix%2F&state=blocked&thread=12"
  );
  expect(boardQuery(new URL("http://x/board/tasks/7")).thread).toBe("7");
  expect(boardQuery(new URL("http://x/board?thread=abc")).thread).toBeNull();
});

test("composer fields parse", () => {
  expect(parseLabels("kind=code, team = web, junk")).toEqual({
    kind: "code",
    team: "web",
  });
  expect(parseNeeds("#12 14, x #9")).toEqual(["12", "14", "9"]);
});

test("a claim past its lease is ready", () => {
  const task = {
    claim: { actor: "a", until: "2026-01-01T00:00:00.000Z" },
    state: "claimed",
  } as TaskView;
  expect(stateNow(task, Date.parse("2026-01-01T00:01:00Z"))).toBe("ready");
  expect(stateNow(task, Date.parse("2025-12-31T23:59:00Z"))).toBe("claimed");
});
