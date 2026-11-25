import type { MessageView, ThreadView } from "@vercel/board";
import type { Agent, Project, Resource, Skill } from "./store.ts";

/** What an agent reads before its task: who it is, where it works, and how it reports. */

export interface SkillHead {
  readonly description: string;
  readonly name: string;
  /** The SKILL.md in the sandbox. */
  readonly path: string;
}

const ACTOR_PREFIX = /^(factory:user:|board:client:)/;

/** An actor's ID as a name: `factory:user:ann` and `board:client:sre` are `ann` and `sre`. */
export const actorName = (actor: string) => actor.replace(ACTOR_PREFIX, "");

const line = (message: MessageView) =>
  `[${actorName(message.by.actor)}, ${message.createdAt}] ${message.deleted ? "(removed)" : message.text}`;

/** A thread as text: the task, then its replies, oldest first. */
export const threadText = (thread: ThreadView) => {
  const root = thread.message;
  const labels = Object.entries(root.labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return [
    `Task #${root.id} in channel #${root.channel}, from ${actorName(root.by.actor)}:`,
    "",
    root.text,
    ...(labels === "" ? [] : ["", `Labels: ${labels}`]),
    ...(thread.replies.length === 0
      ? []
      : [
          "",
          "Replies in the thread, oldest first:",
          ...thread.replies.map(line),
        ]),
  ].join("\n");
};

const FRONT_MATTER = /^---\n([\s\S]*?)\n---/;
const FRONT_NAME = /^name:\s*(.*)$/m;
const FRONT_DESCRIPTION = /^description:\s*(.*)$/m;
const QUOTES = /^["']|["']$/g;

const field = (pattern: RegExp, front: string) => {
  const [, value = ""] = front.match(pattern) ?? [];
  return value.trim().replace(QUOTES, "");
};

/** The name and the description from the front matter of a SKILL.md, or null without a name. */
export const skillHead = (path: string, content: string): SkillHead | null => {
  const [, front = ""] = content.match(FRONT_MATTER) ?? [];
  const name = field(FRONT_NAME, front);
  return name === ""
    ? null
    : { description: field(FRONT_DESCRIPTION, front), name, path };
};

/** A skill of Factory as the SKILL.md that the sandbox gets. */
export const skillFile = (skill: Skill) =>
  `---\nname: ${skill.name}\ndescription: ${skill.description.replaceAll("\n", " ")}\n---\n\n${skill.body}\n`;

const section = (title: string, lines: readonly string[]) =>
  lines.length === 0 ? [] : ["", `# ${title}`, ...lines];

export const instructionsOf = (input: {
  readonly agent: Agent;
  /** Each channel, with the agents that do its tasks. */
  readonly channels: readonly {
    readonly agents: readonly string[];
    readonly path: string;
  }[];
  /** AGENTS.md of the repositories. */
  readonly contexts: readonly {
    readonly content: string;
    readonly path: string;
  }[];
  readonly projects: readonly Project[];
  readonly resources: readonly Resource[];
  readonly skills: readonly SkillHead[];
  readonly workspace: string;
}) =>
  [
    `You are "${input.agent.name}", an agent of a software factory.${input.agent.description === "" ? "" : ` Your role: ${input.agent.description}`}`,
    ...(input.agent.instructions.trim() === ""
      ? []
      : ["", input.agent.instructions.trim()]),
    ...section("How you work", [
      "- You do one task from the Factory board. The first message is the task with its thread.",
      "- Your tools (read, write, edit, bash) run in a sandbox, a container that is yours for this task. The sandbox is removed when you finish: push or report all that must stay.",
      "- Use read to examine files, not cat or sed. Use edit for targeted changes, and batch the changes to one file in one call. Each oldText must match the file exactly. Use write only for new files. Use bash for ls, rg, find and git.",
      "- Your last answer is posted to the thread of the task, and the task is then complete. Its first line is the result of the task on the board: make that line the conclusion. Then say in a few lines what you did, what you found, and where the result is (a branch, a pull request, a task).",
      "- People read the board. Use board_reply only for something that a person must know before you finish.",
      "- When the work must continue in a different channel (a fix, a review, a release), make a task there with board_task. Write it so that the agent or the person there can do it without this thread.",
      "- When you cannot continue without a decision or an answer from a person, call task_block with a clear question. When the task cannot be done, call task_fail with the reason. Do not guess.",
    ]),
    ...section(
      "Channels of the board",
      input.channels.map(
        (channel) =>
          `- #${channel.path}${channel.agents.length === 0 ? " (people)" : ` (agents: ${channel.agents.join(", ")})`}`
      )
    ),
    ...section(
      "Repositories in the sandbox",
      input.projects.map(
        (project) =>
          `- ${input.workspace}/${project.name}: ${project.url}, branch ${project.branch}${project.tokenSecret === "" ? "" : ". Git can push."}`
      )
    ),
    ...section(
      "Shared resources that the sandbox can reach",
      input.resources.map(
        (resource) =>
          `- host \`${resource.name}\` (${resource.image})${resource.description === "" ? "" : `: ${resource.description}`}`
      )
    ),
    ...section(
      "Environment variables with credentials",
      input.agent.secrets.map((name) => `- $${name}`)
    ),
    ...section("Skills", [
      ...(input.skills.length === 0
        ? []
        : [
            "A skill is a set of instructions for one kind of work. When a task matches a skill, read its file first and follow it.",
          ]),
      ...input.skills.map(
        (skill) => `- ${skill.name}: ${skill.description} (${skill.path})`
      ),
    ]),
    ...input.contexts.flatMap((context) => [
      "",
      `# Instructions of the repository (${context.path})`,
      context.content,
    ]),
  ].join("\n");
