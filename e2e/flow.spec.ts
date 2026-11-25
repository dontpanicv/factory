import { expect, test } from "@playwright/test";
import { api, BOARD, channel, FACTORY, task, unique } from "./factory.ts";

/** The flow: how tasks moved between channels, from the labels that say where each task came from. */

const room = unique("e2e-flow");

const finish = async (
  factory: ReturnType<typeof api>,
  id: string,
  how: "complete" | "fail"
) => {
  const { claim } = (await factory.post(`${BOARD}/tasks/${id}/claim`)).body;
  await factory.post(`${BOARD}/tasks/${id}/${how}`, {
    epoch: claim.epoch,
    reason: "It broke",
    token: claim.token,
  });
};

test("the flow counts each way of the tasks, with the rework and the ends", async ({
  request,
}) => {
  const factory = api(request);
  const [ops, dev, review] = await Promise.all(
    ["ops", "dev", "review"].map((name) => channel(factory, `${room}/${name}`))
  );
  // A scheduled check finds a problem; the fix goes to review, comes back one time, and passes.
  const alert = await task(factory, ops as string, "Alert", {
    "factory.schedule": "1",
  });
  await finish(factory, alert, "complete");
  const fix = await task(factory, dev as string, "Fix", {
    "factory.from": alert,
  });
  await finish(factory, fix, "complete");
  const first = await task(factory, review as string, "Review", {
    "factory.from": fix,
  });
  await finish(factory, first, "complete");
  const rework = await task(factory, dev as string, "Fix again", {
    "factory.from": first,
  });
  await finish(factory, rework, "complete");
  const second = await task(factory, review as string, "Review again", {
    "factory.from": rework,
  });
  await finish(factory, second, "complete");
  const asked = await task(factory, dev as string, "A person asks");
  await finish(factory, asked, "fail");
  await task(factory, dev as string, "Still open");

  const flow = (await factory.get(`${FACTORY}/flow`, { days: 1 })).body;
  const ways = Object.fromEntries(
    flow.edges
      .filter(
        (edge: { from: string; to: string }) =>
          edge.from.includes(room) || edge.to.includes(room)
      )
      .map((edge: { count: number; from: string; to: string }) => [
        `${edge.from.replace(`${room}/`, "")} > ${edge.to.replace(`${room}/`, "")}`,
        edge.count,
      ])
  );
  expect(ways).toEqual({
    "channel:dev > channel:review": 2,
    "channel:dev > end:failed": 1,
    "channel:ops > channel:dev": 1,
    "channel:review > channel:dev": 1,
    "channel:review > end:done": 1,
    "source:people > channel:dev": 2,
    "source:schedule > channel:ops": 1,
  });
  const node = flow.nodes.find(
    (one: { id: string }) => one.id === `channel:${dev}`
  );
  expect(node.total).toBe(4);
  expect(node.open).toBe(1);
  expect(node.kind).toBe("channel");
  // No agent did these tasks: the channel has no run time.
  expect(node.medianRunMs).toBeNull();
});

test("the flow of a time without tasks is empty", async ({ request }) => {
  const flow = (await api(request).get(`${FACTORY}/flow`, { days: 0 })).body;
  expect(flow).toEqual({ edges: [], nodes: [] });
});
