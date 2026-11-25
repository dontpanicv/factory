import { useCallback, useEffect, useState } from "preact/hooks";
import { get } from "./api.ts";

/**
 * The view of Factory that the pages show: `GET /api/factory` answers all definitions with their
 * state now. Each page reads the part that it needs.
 */

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
