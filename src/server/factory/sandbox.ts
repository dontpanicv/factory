import daemonArm64 from "../../../node_modules/@earendil-works/pi-env/bin/pi-env-linux-arm64/pi-env" with {
  type: "file",
};
import daemonX64 from "../../../node_modules/@earendil-works/pi-env/bin/pi-env-linux-x64/pi-env" with {
  type: "file",
};

/**
 * The hands of an agent: a box that runs its tools. The agent itself (Pi Durable, the model calls,
 * the secrets of Factory) stays in the Factory process and reaches the box only through a pi-env
 * daemon. A provider makes boxes and the shared resources that boxes can reach; `docker()` is the
 * first one. All work in a box (checkouts, skills, tools) goes through the daemon, so another
 * provider needs only these methods.
 */

export interface BoxSpec {
  /** Environment variables of the box: the agent's secrets. */
  readonly env: Readonly<Record<string, string>>;
  /** Names the box. The same id gives the same box. */
  readonly id: string;
  /** The image, or empty for the provider's own. */
  readonly image: string;
  /** The shared resources that the box can reach, each by its name as the host name. */
  readonly resources: readonly string[];
}

export interface Box {
  /** The command that starts the pi-env daemon in the box. */
  readonly daemon: readonly string[];
  readonly id: string;
  /** The directory in the box where the repositories are. */
  readonly workspace: string;
}

export interface ResourceSpec {
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
  readonly image: string;
  readonly name: string;
}

export interface SandboxProvider {
  /** The ids of the boxes that exist. */
  readonly boxes: () => Promise<string[]>;
  readonly kind: string;
  /** Remove a shared resource. */
  readonly resourceDown: (name: string) => Promise<void>;
  /** The state of each shared resource that exists: `running`, `exited`. */
  readonly resourceStates: () => Promise<Record<string, string>>;
  /** Start a shared resource, if it does not run. */
  readonly resourceUp: (spec: ResourceSpec) => Promise<void>;
  /** Make the box, or find it again, with the daemon in it. */
  readonly start: (spec: BoxSpec) => Promise<Box>;
  readonly stop: (id: string) => Promise<void>;
}

export const DEFAULT_IMAGE = "factory-sandbox:1";

/** The Factory image: small, with the tools that an agent needs for a Git repository. */
const DOCKERFILE = `FROM debian:bookworm-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git curl ca-certificates openssh-client ripgrep jq unzip \\
 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
CMD ["sleep", "infinity"]
`;

const DAEMON_PATH = "/usr/local/bin/pi-env";
const BOX = "factory-box-";
const RESOURCE = "factory-res-";

const run = async (
  args: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly stdin?: Blob;
  } = {}
) => {
  const child = Bun.spawn(["docker", ...args], {
    env: { ...process.env, ...options.env },
    stderr: "pipe",
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr: stderr.trim(), stdout: stdout.trim() };
};

const must = async (
  args: readonly string[],
  options?: Parameters<typeof run>[1]
) => {
  const result = await run(args, options);
  if (result.code !== 0) {
    throw new Error(
      `docker ${args[0]} ${args[1] ?? ""}: ${result.stderr || result.stdout || `exit ${result.code}`}`
    );
  }
  return result.stdout;
};

/** `-e NAME` for each variable: Docker takes the value from its own environment, not from the command line. */
const envFlags = (env: Readonly<Record<string, string>>) =>
  Object.keys(env).flatMap((name) => ["-e", name]);

const state = async (container: string) => {
  const result = await run([
    "inspect",
    "--format",
    "{{.State.Status}}",
    container,
  ]);
  return result.code === 0 ? result.stdout : null;
};

const ensureImage = async (image: string) => {
  if (
    image === DEFAULT_IMAGE &&
    (await run(["image", "inspect", image])).code !== 0
  ) {
    await must(["build", "-q", "-t", image, "-"], {
      stdin: new Blob([DOCKERFILE]),
    });
  }
};

const ensureNetwork = async (network: string) => {
  if ((await run(["network", "inspect", network])).code !== 0) {
    await must(["network", "create", network]);
  }
};

const deployDaemon = async (container: string) => {
  if ((await run(["exec", container, "test", "-x", DAEMON_PATH])).code === 0) {
    return;
  }
  const machine = await must(["exec", container, "uname", "-m"]);
  const daemon =
    machine === "aarch64" || machine === "arm64" ? daemonArm64 : daemonX64;
  await must(
    [
      "exec",
      "-i",
      container,
      "sh",
      "-c",
      `cat > ${DAEMON_PATH} && chmod +x ${DAEMON_PATH}`,
    ],
    { stdin: Bun.file(daemon) }
  );
};

/**
 * Boxes and shared resources as Docker containers on this computer. Each shared resource has its
 * own network, and a box joins only the networks of the resources that its agent can use.
 */
export const docker = (): SandboxProvider => ({
  boxes: async () => {
    const names = await must([
      "ps",
      "-a",
      "--filter",
      "label=factory=box",
      "--format",
      "{{.Names}}",
    ]);
    return names === ""
      ? []
      : names.split("\n").map((name) => name.slice(BOX.length));
  },
  kind: "docker",
  resourceDown: async (name) => {
    await run(["rm", "-f", `${RESOURCE}${name}`]);
  },
  resourceStates: async () => {
    const lines = await must([
      "ps",
      "-a",
      "--filter",
      "label=factory=resource",
      "--format",
      "{{.Names}}\t{{.State}}",
    ]);
    const states: Record<string, string> = {};
    for (const line of lines === "" ? [] : lines.split("\n")) {
      const [name, value] = line.split("\t");
      if (name !== undefined && value !== undefined) {
        states[name.slice(RESOURCE.length)] = value;
      }
    }
    return states;
  },
  resourceUp: async (spec) => {
    const container = `${RESOURCE}${spec.name}`;
    const now = await state(container);
    if (now === "running") {
      return;
    }
    if (now !== null) {
      await must(["start", container]);
      return;
    }
    await ensureNetwork(container);
    await must(
      [
        "run",
        "-d",
        "--name",
        container,
        "--label",
        "factory=resource",
        "--network",
        container,
        "--network-alias",
        spec.name,
        "--restart",
        "unless-stopped",
        ...envFlags(spec.env),
        spec.image,
        ...(spec.command.trim() === "" ? [] : ["sh", "-c", spec.command]),
      ],
      { env: spec.env }
    );
  },
  start: async (spec) => {
    const container = `${BOX}${spec.id}`;
    const now = await state(container);
    if (now === null) {
      const image = spec.image === "" ? DEFAULT_IMAGE : spec.image;
      await ensureImage(image);
      const [first, ...rest] = spec.resources.map(
        (name) => `${RESOURCE}${name}`
      );
      await must(
        [
          "run",
          "-d",
          "--init",
          "--name",
          container,
          "--label",
          "factory=box",
          ...(first === undefined ? [] : ["--network", first]),
          ...envFlags(spec.env),
          image,
          "sleep",
          "infinity",
        ],
        { env: spec.env }
      );
      await Promise.all(
        rest.map((network) => must(["network", "connect", network, container]))
      );
    } else if (now !== "running") {
      await must(["start", container]);
    }
    await deployDaemon(container);
    return {
      daemon: ["docker", "exec", "-i", container, DAEMON_PATH],
      id: spec.id,
      workspace: "/workspace",
    };
  },
  stop: async (id) => {
    await run(["rm", "-f", `${BOX}${id}`]);
  },
});
