import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logins } from "../src/server/factory/models.ts";

const token = (exp: number) =>
  `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;

test("the ChatGPT login comes from the Codex CLI's file, and a renewed token goes back to it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "factory-logins-"));
  const codexFile = join(directory, "codex.json");
  const piFile = join(directory, "pi.json");
  writeFileSync(
    codexFile,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: token(2000),
        account_id: "acct",
        id_token: "id",
        refresh_token: "r1",
      },
    })
  );
  writeFileSync(
    piFile,
    JSON.stringify({
      anthropic: { key: "k", type: "api_key" },
      "openai-codex": {
        access: "old",
        expires: 1,
        refresh: "old",
        type: "oauth",
      },
    })
  );
  const store = logins(piFile, codexFile);
  expect(await store.read("openai-codex")).toEqual({
    access: token(2000),
    accountId: "acct",
    expires: 2_000_000,
    refresh: "r1",
    type: "oauth",
  });
  expect(await store.read("anthropic")).toEqual({ key: "k", type: "api_key" });
  expect((await store.list()).map((one) => one.providerId).toSorted()).toEqual([
    "anthropic",
    "openai-codex",
  ]);

  await store.modify("openai-codex", (current) =>
    Promise.resolve(
      current?.type === "oauth"
        ? { ...current, access: token(3000), refresh: "r2" }
        : undefined
    )
  );
  const written = JSON.parse(readFileSync(codexFile, "utf8"));
  expect(written.tokens).toEqual({
    access_token: token(3000),
    account_id: "acct",
    id_token: "id",
    refresh_token: "r2",
  });
  expect(written.auth_mode).toBe("chatgpt");
  // Pi's own file is not changed.
  expect(JSON.parse(readFileSync(piFile, "utf8"))["openai-codex"].refresh).toBe(
    "old"
  );

  // Without a Codex login, Pi's login is the one.
  const piOnly = logins(piFile, join(directory, "none.json"));
  expect((await piOnly.read("openai-codex"))?.type).toBe("oauth");
});
