import { expect, test } from "@playwright/test";
import { type Api, api, FACTORY, unique } from "./factory.ts";

/** What the agents work with: projects, skills, secrets and shared resources. */

test.describe.configure({ mode: "serial" });

const overview = async (factory: Api) => (await factory.get(FACTORY)).body;
// The tests read the JSON of the API as it comes.
const named = (list: any[], name: string) =>
  list.find((one) => one.name === name);

test("the overview has each kind of definition", async ({ request }) => {
  const body = await overview(api(request));
  expect(Object.keys(body).sort()).toEqual([
    "agents",
    "channels",
    "image",
    "models",
    "projects",
    "resources",
    "sandbox",
    "secrets",
    "skills",
  ]);
  expect(body.sandbox).toBe("docker");
  expect(body.image.startsWith("factory-sandbox:")).toBe(true);
});

test("a project is saved with its defaults, changed and removed", async ({
  request,
}) => {
  const factory = api(request);
  const name = unique("e2e-project");
  const url = "https://github.com/dontpanicv/factory.git";
  const saved = await factory.post(`${FACTORY}/projects`, { name, url });
  expect(saved.status).toBe(200);
  expect(saved.body).toEqual({
    branch: "main",
    name,
    setup: "",
    tokenSecret: "",
    url,
  });
  await factory.post(`${FACTORY}/projects`, {
    branch: "develop",
    name,
    setup: "bun install",
    url,
  });
  expect(named((await overview(factory)).projects, name)).toMatchObject({
    branch: "develop",
    setup: "bun install",
  });
  expect((await factory.del(`${FACTORY}/projects/${name}`)).status).toBe(200);
  expect(named((await overview(factory)).projects, name)).toBeUndefined();
});

test("a definition with a bad name or without a needed setting is refused", async ({
  request,
}) => {
  const factory = api(request);
  for (const [kind, body] of [
    ["projects", { name: "Bad Name", url: "https://example.com/a.git" }],
    ["projects", { name: "no-url" }],
    ["projects", { name: `${"x".repeat(41)}`, url: "https://example.com" }],
    ["skills", { name: "../etc" }],
    ["skills", {}],
    ["resources", { name: "no-image" }],
    ["resources", { image: "redis:7-alpine", name: "Bad_Name" }],
  ] as const) {
    const answer = await factory.post(`${FACTORY}/${kind}`, body);
    expect(answer.status, JSON.stringify(body)).toBe(400);
    expect(answer.body.error.code).toBe("invalid");
    expect(answer.body.error.message.length).toBeGreaterThan(0);
  }
  const body = await overview(factory);
  for (const name of ["no-url", "no-image"]) {
    expect(named(body.projects, name)).toBeUndefined();
    expect(named(body.resources, name)).toBeUndefined();
  }
});

test("a skill is saved, changed and removed", async ({ request }) => {
  const factory = api(request);
  const name = unique("e2e-skill");
  const saved = await factory.post(`${FACTORY}/skills`, {
    body: "1. Look.\n2. Report.",
    description: "How to look",
    name,
  });
  expect(saved.body).toEqual({
    body: "1. Look.\n2. Report.",
    description: "How to look",
    name,
  });
  await factory.post(`${FACTORY}/skills`, { body: "New.", name });
  expect(named((await overview(factory)).skills, name)).toEqual({
    body: "New.",
    description: "",
    name,
  });
  await factory.del(`${FACTORY}/skills/${name}`);
  expect(named((await overview(factory)).skills, name)).toBeUndefined();
});

test("a secret is set and listed by its name, and its value is never answered", async ({
  request,
}) => {
  const factory = api(request);
  const name = `E2E_${Date.now()}`;
  const value = `value-${Date.now()}-do-not-show`;
  for (const bad of ["lower", "1ST", "WITH SPACE", ""]) {
    const answer = await factory.post(`${FACTORY}/secrets`, {
      name: bad,
      value,
    });
    expect(answer.status, bad).toBe(400);
  }
  const set = await factory.post(`${FACTORY}/secrets`, { name, value });
  expect(set.body).toEqual({ ok: true });
  const body = await overview(factory);
  expect(body.secrets).toContain(name);
  expect(JSON.stringify(body)).not.toContain(value);
  // No endpoint reads a secret.
  expect((await factory.get(`${FACTORY}/secrets`)).status).toBe(404);
  expect((await factory.get(`${FACTORY}/secrets/${name}`)).status).toBe(404);
  // The same name again replaces the value: the list still has it one time.
  await factory.post(`${FACTORY}/secrets`, { name, value: "another" });
  expect(
    (await overview(factory)).secrets.filter((one: string) => one === name)
  ).toHaveLength(1);
  await factory.del(`${FACTORY}/secrets/${name}`);
  expect((await overview(factory)).secrets).not.toContain(name);
});

test("a shared resource starts, keeps running after a change, stops and is removed", async ({
  request,
}) => {
  const factory = api(request);
  const name = unique("e2e-res");
  const state = async () =>
    named((await overview(factory)).resources, name)?.state;
  const saved = await factory.post(`${FACTORY}/resources`, {
    description: "A Redis for the tests.",
    image: "redis:7-alpine",
    name,
  });
  expect(saved.status).toBe(200);
  expect(saved.body.container).toBe("");
  expect(await state()).toBe("stopped");
  expect(
    (await factory.post(`${FACTORY}/resources/${name}/start`)).status
  ).toBe(200);
  await expect.poll(state).toBe("running");
  // A saved change to a resource that runs starts it again with the change.
  await factory.post(`${FACTORY}/resources`, {
    description: "Changed.",
    env: "E2E=1",
    image: "redis:7-alpine",
    name,
  });
  await expect.poll(state).toBe("running");
  expect((await factory.post(`${FACTORY}/resources/${name}/stop`)).status).toBe(
    200
  );
  await expect.poll(state).toBe("stopped");
  expect(
    (await factory.post(`${FACTORY}/resources/no-such-resource/start`)).status
  ).toBe(404);
  await factory.del(`${FACTORY}/resources/${name}`);
  expect(await state()).toBeUndefined();
});
