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
  /** A container that runs already. Empty: the provider starts a container from `image`. */
  readonly container: string;
  readonly env: Readonly<Record<string, string>>;
  readonly image: string;
  readonly name: string;
}

export interface SandboxProvider {
  /** The ids of the boxes that exist. */
  readonly boxes: () => Promise<string[]>;
  readonly kind: string;
  /** Stop a shared resource. A container that Factory did not start only leaves the resource's network. */
  readonly resourceDown: (spec: ResourceSpec) => Promise<void>;
  /** The state of each shared resource: `running`, `exited`, or `stopped` when sandboxes cannot reach it. */
  readonly resourceStates: (
    specs: readonly ResourceSpec[]
  ) => Promise<Record<string, string>>;
  /** Start a shared resource, if it does not run. */
  readonly resourceUp: (spec: ResourceSpec) => Promise<void>;
  /** Make the box, or find it again, with the daemon in it. */
  readonly start: (spec: BoxSpec) => Promise<Box>;
  readonly stop: (id: string) => Promise<void>;
}

export const DEFAULT_IMAGE = "factory-sandbox:2";

/** The Factory image: small, with what an agent needs for a Git repository, and Bun and Python for its checks. */
const DOCKERFILE = `FROM debian:bookworm-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git curl ca-certificates openssh-client ripgrep jq unzip python3 \\
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash \\
 && ln -s /root/.bun/bin/bun /usr/local/bin/bun \\
 && ln -s /root/.bun/bin/bun /usr/local/bin/bunx
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
  resourceDown: async (spec) => {
    const network = `${RESOURCE}${spec.name}`;
    await (spec.container === ""
      ? run(["rm", "-f", network])
      : run(["network", "disconnect", network, spec.container]));
  },
  resourceStates: async (specs) => {
    const states = await Promise.all(
      specs.map(async (spec) => {
        const network = `${RESOURCE}${spec.name}`;
        if (spec.container === "") {
          return [spec.name, (await state(network)) ?? "stopped"] as const;
        }
        // A container of someone else: sandboxes reach it only while it is on the resource's network.
        const joined = await run([
          "inspect",
          "--format",
          `{{if index .NetworkSettings.Networks "${network}"}}{{.State.Status}}{{end}}`,
          spec.container,
        ]);
        return [
          spec.name,
          joined.stdout === "" ? "stopped" : joined.stdout,
        ] as const;
      })
    );
    return Object.fromEntries(states);
  },
  resourceUp: async (spec) => {
    const container = `${RESOURCE}${spec.name}`;
    await ensureNetwork(container);
    if (spec.container !== "") {
      const joined = await run([
        "network",
        "connect",
        "--alias",
        spec.name,
        container,
        spec.container,
      ]);
      if (joined.code !== 0 && !joined.stderr.includes("already exists")) {
        throw new Error(`docker network connect: ${joined.stderr}`);
      }
      return;
    }
    const now = await state(container);
    if (now === "running") {
      return;
    }
    if (now !== null) {
      await must(["start", container]);
      return;
    }
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
