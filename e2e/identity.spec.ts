import { expect, test } from "@playwright/test";
import { api, BOARD, FACTORY } from "./factory.ts";

/** Who may use the API: a person on this computer, with requests from Factory's own pages. */

const FOREIGN_HOST = { host: "factory.example.com" };
const FOREIGN_ORIGIN = { origin: "https://factory.example.com" };

test("the session is the person of this computer", async ({ request }) => {
  const session = await api(request).get("/api/session");
  expect(session.status).toBe(200);
  expect(session.body.mode).toBe("local");
  expect(session.body.user.local).toBe(true);
  expect(session.body.user.name).toContain("(this computer)");
});

test("a request for a foreign host name has no session", async ({
  request,
}) => {
  const session = await request.get("/api/session", { headers: FOREIGN_HOST });
  expect(session.status()).toBe(401);
  expect((await session.json()).error.code).toBe("local_only");
  const factory = await request.get(FACTORY, { headers: FOREIGN_HOST });
  expect(factory.status()).toBe(401);
  expect((await factory.json()).error.code).toBe("unauthorized");
  const runs = await request.get(`${FACTORY}/runs`, { headers: FOREIGN_HOST });
  expect(runs.status()).toBe(401);
  const board = await request.get(`${BOARD}/channels`, {
    headers: FOREIGN_HOST,
  });
  expect(board.status()).toBe(401);
});

test("a write from a foreign origin is refused, and a read is not", async ({
  request,
}) => {
  const factory = await request.post(`${FACTORY}/skills`, {
    data: { name: "from-elsewhere" },
    headers: FOREIGN_ORIGIN,
  });
  expect(factory.status()).toBe(403);
  expect((await factory.json()).error.code).toBe("forbidden");
  const board = await request.post(`${BOARD}/channels`, {
    data: { path: "from-elsewhere" },
    headers: FOREIGN_ORIGIN,
  });
  expect(board.status()).toBe(403);
  const overview = await api(request).get(FACTORY);
  expect(
    overview.body.skills.map((skill: { name: string }) => skill.name)
  ).not.toContain("from-elsewhere");
  expect(overview.body.channels).not.toContain("from-elsewhere");
  const read = await request.get(FACTORY, { headers: FOREIGN_ORIGIN });
  expect(read.status()).toBe(200);
});

test("an address that Factory does not have answers 404", async ({
  request,
}) => {
  const factory = api(request);
  for (const path of ["/nothing", "/agents/x/y/z", "/runs/no-such-run"]) {
    const answer = await factory.get(`${FACTORY}${path}`);
    expect(answer.status, path).toBe(404);
    expect(answer.body.error.code).toBe("not_found");
  }
  expect((await factory.del(`${FACTORY}/runs/x`)).status).toBe(404);
});
