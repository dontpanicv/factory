import type { MessageView, ThreadView } from "@vercel/board";
import type { Project } from "../../projects/server/projects.ts";
import type { Resource } from "../../sandbox/server/resources.ts";
import type { Skill } from "../../skills/server/skills.ts";
import type { Agent } from "./agents.ts";

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
const FRONT_HIDDEN = /^disable-model-invocation:\s*true\s*$/m;
const QUOTES = /^["']|["']$/g;

const field = (pattern: RegExp, front: string) => {
  const [, value = ""] = front.match(pattern) ?? [];
  return value.trim().replace(QUOTES, "");
};

/**
 * The name and the description from the front matter of a SKILL.md. Null without a name, and for
 * a skill that the model must not load by itself (`disable-model-invocation`), as in Pi.
 */
export const skillHead = (path: string, content: string): SkillHead | null => {
  const [, front = ""] = content.match(FRONT_MATTER) ?? [];
  const name = field(FRONT_NAME, front);
  return name === "" || FRONT_HIDDEN.test(front)
    ? null
    : { description: field(FRONT_DESCRIPTION, front), name, path };
};

/** A skill of Factory as the SKILL.md that the sandbox gets. */
export const skillFile = (skill: Skill) =>
  `---\nname: ${skill.name}\ndescription: ${skill.description.replaceAll("\n", " ")}\n---\n\n${skill.body}\n`;

const section = (title: string, lines: readonly string[]) =>
  lines.length === 0 ? [] : ["", `# ${title}`, ...lines];

const tagged = (tag: string, lines: readonly string[]) =>
  lines.length === 0 ? [] : ["", `<${tag}>`, ...lines, `</${tag}>`];

const XML: Record<string, string> = {
  "'": "&apos;",
  '"': "&quot;",
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};
const XML_SPECIAL = /[&<>"']/g;
const escapeXml = (text: string) =>
  text.replace(XML_SPECIAL, (character) => XML[character] ?? character);

/**
 * The parts of the system prompt that the Pi coding agent builds itself and Pi Durable does not
 * (pi's `core/system-prompt.ts`, `core/skills.ts` and the tools' prompt lines): the tool list, the
 * rules of the tools, the instructions of the repositories, the skills and the working directory.
 * The texts are Pi's, so a model works here as it does in Pi.
 */
const PI_TOOLS = [
  "- read: Read file contents",
  "- bash: Execute bash commands (ls, grep, find, etc.)",
  "- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
  "- write: Create or overwrite files",
];
const PI_RULES = [
  "- Use bash for file operations like ls, rg, find",
  "- Use read to examine files instead of cat or sed.",
  "- Use edit for targeted changes. Batch changes to one file in a single call.",
  "- Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
  "- Use write only for new files or complete rewrites.",
  "- Be concise in your responses",
  "- Show file paths clearly when working with files",
];
const BOARD_TOOLS = [
  "- board_read: Read a thread or a task of the board by its number",
  "- board_tasks: List tasks of the board",
  "- board_reply: Write a reply in the thread of your task",
  "- board_task: Make a task in a channel, to hand work on",
  "- task_block: Give your task to a person and stop",
  "- task_fail: Say that your task cannot be done, and stop",
];

const skillsBlock = (skills: readonly SkillHead[]) =>
  skills.length === 0
    ? []
    : [
        "The following skills provide specialized instructions for specific tasks.",
        "Use the read tool to load a skill's file when the task matches its description.",
        "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
        "",
        "<available_skills>",
        ...skills.flatMap((skill) => [
          "  <skill>",
          `    <name>${escapeXml(skill.name)}</name>`,
          `    <description>${escapeXml(skill.description)}</description>`,
          `    <location>${escapeXml(skill.path)}</location>`,
          "  </skill>",
        ]),
        "</available_skills>",
      ];

export const instructionsOf = (input: {
  readonly agent: Agent;
  /** Each channel, with the agents that do its tasks. */
  readonly channels: readonly {
    readonly agents: readonly string[];
    readonly path: string;
  }[];
  /** AGENTS.md (or CLAUDE.md) of the repositories. */
  readonly contexts: readonly {
    readonly content: string;
    readonly path: string;
  }[];
  /** The working directory of the tools. */
  readonly cwd: string;
  readonly projects: readonly Project[];
  readonly resources: readonly Resource[];
  readonly skills: readonly SkillHead[];
  readonly workspace: string;
}) =>
  [
    `You are "${input.agent.name}", a coding agent of a software factory, running inside Pi Durable, a coding agent harness. You inspect files, run commands, and modify code to do one task of the Factory board.${input.agent.description === "" ? "" : ` Your role: ${input.agent.description}`}`,
    ...tagged("tools", [
      ...PI_TOOLS,
      ...BOARD_TOOLS,
      "",
      "Additional tools may be available.",
    ]),
    ...tagged("rules", PI_RULES),
    ...(input.agent.instructions.trim() === ""
      ? []
      : ["", "# Your instructions", input.agent.instructions.trim()]),
    ...section("How you work in the factory", [
      "- The first message is your task with its thread. Your instructions above say what your role does with a task.",
      "- Your tools (read, write, edit, bash) run in a sandbox, a container that is yours for this task. The sandbox is removed when you finish: push or report all that must stay.",
      "- Before you say that a change is done, check it: run the tests and the checks that the repository has, when the sandbox can run them. Say what you did not check.",
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
    ...tagged(
      "project_context",
      input.contexts.length === 0
        ? []
        : [
            "Project-specific instructions and guidelines:",
            ...input.contexts.flatMap((context) => [
              "",
              `<project_instructions path="${context.path}">`,
              context.content.trim(),
              "</project_instructions>",
            ]),
          ]
    ),
    ...tagged("skills", skillsBlock(input.skills)),
    ...tagged("cwd", [input.cwd]),
  ].join("\n");
