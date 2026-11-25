import type { Board } from "@vercel/board";
import type { Agent } from "../../agents/server/agents.ts";
import type { Runs } from "../../agents/server/runs.ts";
import type { Definitions } from "../../shared/server/database.ts";
import { json, type Route } from "../../shared/server/http.ts";
import { loadFlow } from "./flow.ts";

const DAY_MS = 86_400_000;
const RUNS_MAX = 5000;

/** `GET /flow?days=30` is the flow of the tasks of the last days. */
export const flowRoute =
  (parts: {
    readonly agents: Definitions<Agent>;
    readonly board: Board;
    readonly runs: Runs;
  }): Route =>
  async ({ query }) => {
    const since = Date.now() - Number(query.get("days") ?? "30") * DAY_MS;
    return json(
      await loadFlow(
        parts.board,
        parts.runs.list({ since }, RUNS_MAX),
        parts.agents.list(),
        since
      )
    );
  };
