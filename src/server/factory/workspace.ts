import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Board } from "@vercel/board";
import {
  instructionsOf,
  type SkillHead,
  skillFile,
  skillHead,
} from "./prompt.ts";
import { type Agent, consumes, type Project, type Store } from "./store.ts";

/**
 * A box made ready for an agent: its repositories checked out, its skills written. All of it goes
 * through the box's pi-env daemon, so it is the same for each sandbox provider.
 */

const context = BACKGROUND_CONTEXT;
const OUTPUT_MAX = 4000;
/** The most of one AGENTS.md that goes into the instructions. */
const CONTEXT_MAX = 50_000;
/** The instruction files of a directory, as Pi looks for them: the first that is there. */
const CONTEXT_FILES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
];
const FILE_MARK = "@@file ";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Run a script in the box. Throws with the end of the output when it fails. */
export const sh = async (env: ExecutionEnv, script: string, what: string) => {
  let output = "";
  const result = await env.exec(
    ["bash", "-c", script],
    {
      onOutput: (text) => {
        output += text;
      },
    },
    context
  );
  if (!result.ok || result.value.exitCode !== 0) {
    throw new Error(
      `${what} failed: ${(result.ok ? output : result.error.message).trim().slice(-OUTPUT_MAX)}`
    );
  }
  return output;
};

/** The files that a shell loop printed, each after a `@@file <path>` line. */
const files = (output: string) => {
  const found: { content: string; path: string }[] = [];
  for (const line of output.split("\n")) {
    const last = found.at(-1);
    if (line.startsWith(FILE_MARK)) {
      found.push({ content: "", path: line.slice(FILE_MARK.length).trim() });
    } else if (last !== undefined) {
      last.content += `${line}\n`;
    }
  }
  return found;
};

/** Print the first part of each file that matches, after a `@@file` line. */
const print = (globs: readonly string[], reader: string) =>
  `for f in ${globs.join(" ")}; do if [ -f "$f" ]; then echo "${FILE_MARK}$f"; ${reader} "$f"; echo; fi; done; true`;

const checkout = async (
  env: ExecutionEnv,
  workspace: string,
  agent: Agent,
  projects: readonly Project[]
) => {
  await sh(
    env,
    [
      `mkdir -p ${quote(workspace)}`,
      `git config --global user.name ${quote(`${agent.name} (Factory agent)`)}`,
      `git config --global user.email ${quote(`${agent.name}@factory.local`)}`,
      "git config --global --add safe.directory '*'",
      // Git asks this helper for the password: the token stays in the environment.
      ...projects
        .filter((project) => project.tokenSecret !== "")
        .map(
          (project) =>
            `git config --global credential.${quote(new URL(project.url).origin)}.helper ${quote(`!f() { echo username=x-access-token; echo "password=$${project.tokenSecret}"; }; f`)}`
        ),
    ].join(" && "),
    "The setup of Git"
  );
  await Promise.all(
    projects.map((project) => {
      const directory = quote(`${workspace}/${project.name}`);
      return sh(
        env,
        [
          `{ [ -d ${directory}/.git ] || git clone --branch ${quote(project.branch)} -- ${quote(project.url)} ${directory}; }`,
          ...(project.setup.trim() === ""
            ? []
            : [`cd ${directory}`, `{ ${project.setup.trim()}\n}`]),
        ].join(" && "),
        `The checkout of ${project.name}`
      );
    })
  );
};

/** Write the agent's skills of Factory to the box, and find the skills of the repositories. */
const skillsOf = async (
  env: ExecutionEnv,
  workspace: string,
  agent: Agent,
  store: Store
) => {
  const own = agent.skills.flatMap((name) => store.get("skills", name) ?? []);
  const written: SkillHead[] = await Promise.all(
    own.map(async (skill) => {
      const directory = `${workspace}/.factory/skills/${skill.name}`;
      await sh(env, `mkdir -p ${quote(directory)}`, "The skills directory");
      await env.writeFile(`${directory}/SKILL.md`, skillFile(skill), context);
      return {
        description: skill.description,
        name: skill.name,
        path: `${directory}/SKILL.md`,
      };
    })
  );
  const root = quote(workspace);
  const found = files(
    await sh(
      env,
      print(
        [
          `${root}/*/.agents/skills/*/SKILL.md`,
          `${root}/*/.pi/skills/*/SKILL.md`,
          `${root}/*/.claude/skills/*/SKILL.md`,
        ],
        "head -n 20"
      ),
      "The search for skills"
    )
  ).flatMap((file) => skillHead(file.path, file.content) ?? []);
  // `.claude/skills` is often a link to `.agents/skills`: one skill, one row.
  const byName = new Map(
    [...found.toReversed(), ...written].map((skill) => [skill.name, skill])
  );
  return [...byName.values()];
};

/** Put the repositories and the skills in the box. Answers the agent's instructions and its working directory. */
export const prepare = async (input: {
  readonly agent: Agent;
  readonly board: Board;
  readonly env: ExecutionEnv;
  readonly store: Store;
  readonly workspace: string;
}) => {
  const { agent, env, store, workspace } = input;
  const projects = agent.projects.flatMap(
    (name) => store.get("projects", name) ?? []
  );
  await checkout(env, workspace, agent, projects);
  const skills = await skillsOf(env, workspace, agent, store);
  const contexts = files(
    await sh(
      env,
      `for d in ${quote(workspace)}/*/; do for n in ${CONTEXT_FILES.join(" ")}; do if [ -f "$d$n" ]; then echo "${FILE_MARK}$d$n"; head -c ${CONTEXT_MAX} "$d$n"; echo; break; fi; done; done; true`,
      "The search for AGENTS.md"
    )
  );
  // With one repository the agent works in it, as Pi does when it starts in a repository.
  const [only] = projects;
  const cwd =
    projects.length === 1 && only !== undefined
      ? `${workspace}/${only.name}`
      : workspace;
  const others = store.list("agents").filter((other) => other.enabled);
  const channels = (await input.board.channels()).channels.map((channel) => ({
    agents: others
      .filter((other) => consumes(other, channel.path))
      .map((other) => other.name),
    path: channel.path,
  }));
  const instructions = instructionsOf({
    agent,
    channels,
    contexts,
    cwd,
    projects,
    resources: agent.resources.flatMap(
      (name) => store.get("resources", name) ?? []
    ),
    skills,
    workspace,
  });
  return { cwd, instructions };
};
