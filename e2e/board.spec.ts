import { expect, test } from "@playwright/test";
import { api, BOARD, channel, task, taskOf, unique } from "./factory.ts";

/** The board through Factory: channels, threads, tasks and their states, schedules, files and events. */

test.describe.configure({ mode: "serial" });

const room = unique("e2e-board");
const main = `${room}/main`;
let thread = "";

test("a channel is made and listed", async ({ request }) => {
  const factory = api(request);
  const made = await factory.post(`${BOARD}/channels`, { path: main });
  expect(made.status).toBeLessThan(300);
  expect(made.body.channel.path).toBe(main);
  const again = await factory.post(`${BOARD}/channels`, { path: main });
  expect(again.body.created).toBe(false);
  const list = await factory.get(`${BOARD}/channels`);
  expect(list.body.channels.map((one: { path: string }) => one.path)).toContain(
    main
  );
  const bad = await factory.post(`${BOARD}/channels`, {
    path: "Not A Channel",
  });
  expect(bad.status).toBe(400);
});

test("a message starts a thread, and a reply joins it, as the person", async ({
  request,
}) => {
  const factory = api(request);
  const posted = await factory.post(`${BOARD}/messages`, {
    channel: main,
    labels: { area: "tests" },
    text: "The first line\nMore text.",
  });
  expect(posted.status).toBeLessThan(300);
  thread = posted.body.message.id;
  expect(posted.body.message.by.actor.startsWith("factory:user:")).toBe(true);
  expect(posted.body.message.labels.area).toBe("tests");
  const reply = await factory.post(`${BOARD}/messages`, {
    re: thread,
    text: "A reply.",
  });
  expect(reply.status).toBeLessThan(300);
  const read = await factory.get(`${BOARD}/messages/${thread}`);
  expect(read.body.message.text).toBe("The first line\nMore text.");
  expect(read.body.message.task).toBeUndefined();
  expect(read.body.replies.map((one: { text: string }) => one.text)).toEqual([
    "A reply.",
  ]);
  const threads = await factory.get(`${BOARD}/threads`, { channel: main });
  expect(threads.body.threads[0].message.id).toBe(thread);
  expect(threads.body.threads[0].replies).toBe(1);
  expect((await factory.get(`${BOARD}/messages/999999999`)).status).toBe(404);
});

test("a thread becomes a task, and a person completes it with a claim", async ({
  request,
}) => {
  const factory = api(request);
  const made = await factory.post(`${BOARD}/tasks`, { re: thread });
  expect(made.status).toBeLessThan(300);
  expect((await taskOf(factory, thread)).task.state).toBe("ready");
  const claimed = await factory.post(`${BOARD}/tasks/${thread}/claim`, {
    lease: 60,
  });
  expect(claimed.status).toBe(200);
  expect((await taskOf(factory, thread)).task.state).toBe("claimed");
  // A second claim is refused while the first holds the task.
  const second = await factory.post(`${BOARD}/tasks/${thread}/claim`, {
    lease: 60,
  });
  expect(second.status).toBe(409);
  const done = await factory.post(`${BOARD}/tasks/${thread}/complete`, {
    epoch: claimed.body.claim.epoch,
    result: "It is done.",
    token: claimed.body.claim.token,
  });
  expect(done.status).toBe(200);
  const now = await taskOf(factory, thread);
  expect(now.task.state).toBe("completed");
  expect(now.task.result).toBe("It is done.");
});

test("a task is held for a person, continued, canceled, failed and reopened", async ({
  request,
}) => {
  const factory = api(request);
  const held = await task(factory, main, "Hold me");
  await factory.post(`${BOARD}/tasks/${held}/block`, {
    kind: "needs_input",
    reason: "Which one?",
  });
  const blocked = await taskOf(factory, held);
  expect(blocked.task.state).toBe("blocked");
  expect(blocked.task.blocked).toEqual({
    kind: "needs_input",
    reason: "Which one?",
  });
  await factory.post(`${BOARD}/tasks/${held}/unblock`);
  expect((await taskOf(factory, held)).task.state).toBe("ready");
  await factory.post(`${BOARD}/tasks/${held}/cancel`, { reason: "Not needed" });
  const canceled = await taskOf(factory, held);
  expect(canceled.task.state).toBe("canceled");
  expect(canceled.task.reason).toBe("Not needed");

  const broken = await task(factory, main, "Fail me");
  const { claim } = (await factory.post(`${BOARD}/tasks/${broken}/claim`)).body;
  const failed = await factory.post(`${BOARD}/tasks/${broken}/fail`, {
    epoch: claim.epoch,
    reason: "It broke",
    token: claim.token,
  });
  expect(failed.status).toBe(200);
  expect((await taskOf(factory, broken)).task.state).toBe("failed");
  await factory.post(`${BOARD}/tasks/${broken}/reopen`);
  expect((await taskOf(factory, broken)).task.state).toBe("ready");
  await factory.post(`${BOARD}/tasks/${broken}/cancel`, { reason: "Cleanup" });
});

test("a task waits for the tasks that it needs", async ({ request }) => {
  const factory = api(request);
  const first = await task(factory, main, "First");
  const second = (
    await factory.post(`${BOARD}/tasks`, {
      channel: main,
      needs: [first],
      text: "Second",
    })
  ).body.task.id as string;
  expect((await taskOf(factory, second)).task.state).toBe("waiting");
  const { claim } = (await factory.post(`${BOARD}/tasks/${first}/claim`)).body;
  await factory.post(`${BOARD}/tasks/${first}/complete`, {
    epoch: claim.epoch,
    token: claim.token,
  });
  expect((await taskOf(factory, second)).task.state).toBe("ready");
  await factory.post(`${BOARD}/tasks/${second}/cancel`, { reason: "Cleanup" });
});

test("the task list has filters for the channel and the state", async ({
  request,
}) => {
  const factory = api(request);
  const open = await task(factory, main, "Still open");
  const all = await factory.get(`${BOARD}/tasks`, {
    channel: main,
    state: "all",
  });
  const states = all.body.tasks.map(
    (one: { message: { task: { state: string } } }) => one.message.task.state
  );
  expect(states).toContain("completed");
  expect(states).toContain("canceled");
  const ready = await factory.get(`${BOARD}/tasks`, {
    channel: main,
    state: "ready",
  });
  expect(
    ready.body.tasks.map((one: { message: { id: string } }) => one.message.id)
  ).toEqual([open]);
  await factory.post(`${BOARD}/tasks/${open}/cancel`, { reason: "Cleanup" });
});

test("a message is scheduled, listed and canceled", async ({ request }) => {
  const factory = api(request);
  const made = await factory.post(`${BOARD}/schedules`, {
    channel: main,
    every: "1d",
    in: "1h",
    text: "Later",
    times: 3,
  });
  expect(made.status).toBe(201);
  const { id } = made.body.schedule;
  expect(made.body.schedule.state).toBe("pending");
  expect(made.body.schedule.times).toBe(3);
  const list = await factory.get(`${BOARD}/schedules`, { channel: main });
  expect(list.body.schedules.map((one: { id: string }) => one.id)).toContain(
    id
  );
  const canceled = await factory.post(`${BOARD}/schedules/${id}/cancel`);
  expect(canceled.body.schedule.state).toBe("canceled");
});

test("a file is uploaded, attached to a message, and read back", async ({
  request,
}) => {
  const factory = api(request);
  const uploaded = await request.post(`${BOARD}/attachments`, {
    data: "The content of the file.",
    headers: { "content-type": "text/plain", "x-board-filename": "note.txt" },
  });
  expect(uploaded.status()).toBe(201);
  const { attachment } = await uploaded.json();
  expect(attachment.name).toBe("note.txt");
  const posted = await factory.post(`${BOARD}/messages`, {
    attachments: [attachment.id],
    channel: main,
    text: "With a file",
  });
  expect(posted.body.message.attachments[0].id).toBe(attachment.id);
  const file = await request.get(`${BOARD}/attachments/${attachment.id}`);
  expect(await file.text()).toBe("The content of the file.");
});

test("the event feed has what happened, and the stream sends new events", async ({
  request,
  baseURL,
}) => {
  const factory = api(request);
  const feed = await factory.get(`${BOARD}/events`, { last: 100 });
  expect(feed.status).toBe(200);
  expect(
    feed.body.events.some(
      (event: { message?: { channel?: string } }) =>
        event.message?.channel === main
    )
  ).toBe(true);

  const stop = new AbortController();
  const stream = await fetch(`${baseURL}${BOARD}/events`, {
    headers: { accept: "text/event-stream" },
    signal: stop.signal,
  });
  expect(stream.headers.get("content-type")).toContain("text/event-stream");
  const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
  await channel(factory, `${room}/stream`);
  await factory.post(`${BOARD}/messages`, {
    channel: `${room}/stream`,
    text: "An event for the stream",
  });
  let seen = "";
  await expect
    .poll(async () => {
      const chunk = await reader.read();
      seen += new TextDecoder().decode(chunk.value);
      return seen;
    })
    .toContain("An event for the stream");
  expect(seen).toContain("event: board");
  stop.abort();
});
