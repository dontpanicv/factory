import { useCallback, useEffect, useState } from "preact/hooks";
import { get } from "./api.ts";

/** Factory's own API at `/api/factory`: the agents and what they need. */

export const FACTORY = "/api/factory";

export interface Schedule {
  readonly channel: string;
  readonly cron: string;
  readonly text: string;
  readonly zone: string;
}

export type RunState =
  | "blocked"
  | "done"
  | "error"
  | "failed"
  | "lost"
  | "running"
  | "starting"
  | "stopped";

export interface AgentRun {
  readonly agent: string;
  readonly channel: string;
  readonly cost: number;
  readonly endedAt: number | null;
  readonly id: string;
  readonly note: string | null;
  readonly startedAt: number;
  readonly state: RunState;
  readonly steps: number;
  readonly taskId: string;
  readonly title: string;
  readonly tokens: number;
}

export interface Agent {
  readonly channels: readonly string[];
  readonly description: string;
  readonly enabled: boolean;
  readonly image: string;
  readonly instructions: string;
  readonly last: AgentRun | null;
  readonly live: readonly AgentRun[];
  readonly maxTurns: number;
  readonly model: string;
  readonly name: string;
  /** The next time of each schedule. */
  readonly next: readonly (number | null)[];
  readonly parallel: number;
  readonly projects: readonly string[];
  readonly resources: readonly string[];
  readonly schedules: readonly Schedule[];
  readonly secrets: readonly string[];
  readonly skills: readonly string[];
  readonly thinking: string;
}

export interface Project {
  readonly branch: string;
  readonly name: string;
  readonly setup: string;
  readonly tokenSecret: string;
  readonly url: string;
}

export interface Resource {
  readonly command: string;
  /** A container that runs already and Factory does not start. */
  readonly container: string;
  readonly description: string;
  readonly env: string;
  readonly image: string;
  readonly name: string;
  readonly secrets: readonly string[];
  readonly state: string;
}

export interface Skill {
  readonly body: string;
  readonly description: string;
  readonly name: string;
}

export interface Overview {
  readonly agents: readonly Agent[];
  readonly channels: readonly string[];
  /** The image of a sandbox when the agent names none. */
  readonly image: string;
  /** `provider/model` of each model that has credentials. */
  readonly models: readonly string[];
  readonly projects: readonly Project[];
  readonly resources: readonly Resource[];
  readonly sandbox: string;
  readonly secrets: readonly string[];
  readonly skills: readonly Skill[];
}

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

const SECOND = 1000;
const MINUTE = 60;
const HOUR = 3600;

/** A length of time in two units at most: `42s`, `3m 10s`, `2h 5m`. */
export const duration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / SECOND));
  if (seconds < MINUTE) {
    return `${seconds}s`;
  }
  if (seconds < HOUR) {
    return `${Math.floor(seconds / MINUTE)}m ${seconds % MINUTE}s`;
  }
  return `${Math.floor(seconds / HOUR)}h ${Math.floor((seconds % HOUR) / MINUTE)}m`;
};

const POLL_MS = 5000;

/** The overview, loaded again every few seconds and after `reload()`. */
export const useOverview = () => {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    get<Overview>(FACTORY)
      .then((overview) => {
        setData(overview);
        setError(null);
      })
      .catch((failure: Error) => setError(failure.message));
  }, []);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);
  return { data, error, reload };
};

/** The values of the checked boxes and the filled inputs with this name. */
export const values = (form: FormData, name: string) =>
  form
    .getAll(name)
    .map((value) => String(value).trim())
    .filter((value) => value !== "");

/** Does the agent do the tasks of this channel? `pipes/` is `pipes` and all channels below it. */
export const consumes = (agent: Agent, channel: string) =>
  agent.channels.some((pattern) =>
    pattern.endsWith("/")
      ? channel === pattern.slice(0, -1) || channel.startsWith(pattern)
      : channel === pattern
  );
