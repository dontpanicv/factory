import type { Agent, RunState } from "../../shared/client/overview.ts";

/** How the runs and the channels of agents read on a page. */

export const LIVE_STATES: readonly RunState[] = ["starting", "running"];

/** How a run's state reads, and the chip that shows it. */
export const RUN_LABEL: Record<RunState, { chip: string; text: string }> = {
  blocked: { chip: "waiting", text: "asked a person" },
  done: { chip: "passed", text: "done" },
  error: { chip: "failed", text: "broke" },
  failed: { chip: "failed", text: "could not do it" },
  lost: { chip: "skipped", text: "task taken away" },
  running: { chip: "running", text: "working" },
  starting: { chip: "queued", text: "starting" },
  stopped: { chip: "halted", text: "stopped" },
};

/** Does the agent do the tasks of this channel? `pipes/` is `pipes` and all channels below it. */
export const consumes = (agent: Agent, channel: string) =>
  agent.channels.some((pattern) =>
    pattern.endsWith("/")
      ? channel === pattern.slice(0, -1) || channel.startsWith(pattern)
      : channel === pattern
  );
