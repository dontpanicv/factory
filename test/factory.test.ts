import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageView } from "@vercel/board";
import { makeBoard } from "../src/server/board.ts";
import { FACTORY_SCHEMA, SCHEDULE_SCHEMA } from "../src/server/db.ts";
import { FACTORY_PATH, handle } from "../src/server/factory/api.ts";
import { flowOf } from "../src/server/factory/flow.ts";
import type { Runner } from "../src/server/factory/runner.ts";
import { type Run, Store, secretKey } from "../src/server/factory/store.ts";

const storeAt = (file: string) => {
  const store = new Store(file, secretKey("test"));
  store.createTables([...FACTORY_SCHEMA, ...SCHEDULE_SCHEMA]);
  return store;
};

test("a secret is sealed in the file, and a plain one of an older Factory is sealed at the start", () => {
  const file = join(mkdtempSync(join(tmpdir(), "factory-store-")), "f.sqlite");
  const store = storeAt(file);
  store.setSecret("API_TOKEN", "s3cret");
  const raw = new Database(file);
  const value = () =>
    raw
      .query<{ value: string }, []>("SELECT value FROM secrets ORDER BY name")
      .all()
      .map((row) => row.value);
  expect(value()[0]).toStartWith("v1:");
  expect(value()[0]).not.toContain("s3cret");
  expect(store.secret("API_TOKEN")).toBe("s3cret");

  raw.run(
    "INSERT INTO secrets (name, value, updated_at) VALUES ('OLD', 'plain', 0)"
  );
  expect(store.secret("OLD")).toBe("plain");
  store.sealSecrets();
  expect(value()[1]).toStartWith("v1:");
  expect(store.secret("OLD")).toBe("plain");
  // Another key does not open it.
  expect(() => new Store(file, secretKey("other")).secret("OLD")).toThrow();
});

const task = (
  id: string,
  channel: string,
  state: string,
  labels: Record<string, string> = {}
) =>
  ({
    channel,
    createdAt: new Date(1000).toISOString(),
    id,
    labels,
    task: { state },
  }) as unknown as MessageView;

const run = (
  taskId: string,
  channel: string,
  startedAt: number,
  endedAt: number
) => ({ channel, endedAt, startedAt, taskId }) as unknown as Run;

test("the flow counts each way of the tasks, with the waits and the run times", () => {
  const tasks = [
    task("1", "ops", "completed", { "factory.schedule": "1" }),
    task("2", "dev", "completed", { "factory.from": "1" }),
    task("3", "review", "completed", { "factory.from": "2" }),
    task("4", "dev", "ready", { "factory.from": "3" }),
    task("5", "dev", "failed"),
  ];
  const flow = flowOf(
    tasks,
    tasks,
    [run("2", "dev", 3000, 9000), run("5", "dev", 5000, 6000)],
    []
  );
  const ways = Object.fromEntries(
    flow.edges.map((edge) => [`${edge.from}>${edge.to}`, edge.count])
  );
  expect(ways).toEqual({
    "channel:dev>channel:review": 1,
    "channel:dev>end:failed": 1,
    "channel:ops>channel:dev": 1,
    // Rework: the review sent it back.
    "channel:review>channel:dev": 1,
    "source:people>channel:dev": 1,
    "source:schedule>channel:ops": 1,
  });
  const dev = flow.nodes.find((node) => node.id === "channel:dev");
  expect(dev?.total).toBe(3);
  expect(dev?.open).toBe(1);
  expect(dev?.medianRunMs).toBe(3500);
  expect(dev?.medianWaitMs).toBe(3000);
});

test("the API saves definitions, hides secrets and claims, and answers 404 for the rest", async () => {
  const store = storeAt(":memory:");
  const { team } = makeBoard({
    currentUser: () => Promise.resolve(null),
    dir: null,
    url: "http://localhost:4310/api/board",
  });
  const downs: string[] = [];
  const parts = {
    board: team,
    models: { getAvailable: () => Promise.resolve([]) },
    provider: {
      resourceDown: (spec: { name: string }) => {
        downs.push(spec.name);
        return Promise.resolve();
      },
      resourceStates: () => Promise.resolve({ db: "running" }),
      resourceUp: () => Promise.resolve(),
    },
    runner: {
      nextRuns: () => ({}),
      tick: () => Promise.resolve(),
    } as unknown as Runner,
    store,
  } as never;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handle(
      parts,
      new Request(`http://localhost${FACTORY_PATH}${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        method,
      }),
      "ada"
    );
    return { body: await response.json(), status: response.status };
  };
  expect((await call("POST", "/agents", { name: "Bad Name" })).status).toBe(
    400
  );
  expect((await call("POST", "/agents", { name: "sre" })).body.maxTurns).toBe(
    80
  );
  await call("POST", "/secrets", { name: "TOKEN", value: "s3cret" });
  expect((await call("POST", "/resources", { name: "db" })).status).toBe(400);
  await call("POST", "/resources", { image: "postgres:17", name: "db" });
  // A change to a resource that runs starts it again.
  await call("POST", "/resources", { image: "postgres:18", name: "db" });
  expect(downs).toEqual(["db"]);
  store.insertRun({
    agent: "sre",
    channel: "ops",
    claim: { epoch: 1, token: "claim-token" },
    id: "r1",
    startedAt: 1,
    state: "done",
    taskId: "1",
    title: "t",
  } as Run);
  const overview = await call("GET", "");
  expect(overview.body.secrets).toEqual(["TOKEN"]);
  expect(overview.body.resources[0].state).toBe("running");
  const text = JSON.stringify([
    overview.body,
    (await call("GET", "/runs")).body,
  ]);
  expect(text).not.toContain("s3cret");
  expect(text).not.toContain("claim-token");
  expect((await call("GET", "/nothing")).status).toBe(404);
  expect((await call("DELETE", "/agents/sre")).status).toBe(200);
  expect(store.list("agents")).toEqual([]);
});
