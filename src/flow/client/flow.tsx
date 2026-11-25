import { useEffect, useState } from "preact/hooks";
import { get } from "../../shared/client/api.ts";
import { FACTORY } from "../../shared/client/overview.ts";
import { duration } from "../../shared/client/time.ts";

/**
 * How tasks move through the factory, as a graph: a box for each channel, and a line for each
 * way that tasks went, as thick as the number of tasks. A line that goes back to an earlier box
 * is rework.
 */

export interface FlowNode {
  readonly agents: readonly string[];
  readonly id: string;
  readonly kind: "channel" | "end" | "source";
  readonly label: string;
  readonly medianRunMs: number | null;
  readonly medianWaitMs: number | null;
  readonly open: number;
  readonly total: number;
}

export interface FlowEdge {
  readonly count: number;
  readonly from: string;
  readonly tasks: readonly string[];
  readonly to: string;
}

export interface Flow {
  readonly edges: readonly FlowEdge[];
  readonly nodes: readonly FlowNode[];
}

export interface PlacedNode extends FlowNode {
  /** How many of its tasks ended there, and how. */
  readonly ended: { readonly done: number; readonly not: number };
  readonly layer: number;
  /** Its place in its column, from the top. */
  readonly row: number;
  readonly x: number;
  readonly y: number;
}

export interface PlacedEdge extends FlowEdge {
  /** It goes to a box that is not later in the flow: rework. */
  readonly back: boolean;
  /** Where its count shows. */
  readonly labelX: number;
  readonly labelY: number;
  readonly path: string;
  readonly width: number;
}

const NODE_W = 200;
const NODE_H = 84;
const COLUMN_GAP = 96;
const ROW_GAP = 30;
const PAD = 24;
const LOOP_RISE = 34;
/** The first lane of the lines over and below the boxes, and the room of each next lane. */
const ARC_BASE = 36;
const ARC_STEP = 20;
/** Half of a count's box, and some air. */
const COUNT_ROOM = 16;
const WIDTH_MIN = 1.5;
const WIDTH_RANGE = 12;

/** The middle of a cubic curve. */
const middle = (a: number, b: number, c: number, d: number) =>
  (a + 3 * b + 3 * c + d) / 8;

/** The edges that close a circle. Depth first, the busiest way first: such an edge goes to a box that is still open. */
const circles = (flow: Flow, out: Map<string, FlowEdge[]>) => {
  const back = new Set<FlowEdge>();
  const state = new Map<string, "done" | "open">();
  const order: string[] = [];
  const visit = (id: string) => {
    state.set(id, "open");
    const ways = (out.get(id) ?? []).toSorted((a, b) => b.count - a.count);
    for (const edge of ways) {
      if (state.get(edge.to) === "open") {
        back.add(edge);
      } else if (state.get(edge.to) === undefined) {
        visit(edge.to);
      }
    }
    state.set(id, "done");
    order.unshift(id);
  };
  const starts = [
    ...flow.nodes.filter((node) => node.kind === "source"),
    ...flow.nodes
      .filter((node) => node.kind === "channel")
      .toSorted((a, b) => b.total - a.total),
  ];
  for (const node of starts) {
    if (state.get(node.id) === undefined) {
      visit(node.id);
    }
  }
  return { back, order };
};

/** The column of each box: one after the last box that sends tasks to it. The ends are in the last column. */
const columnsOf = (flow: Flow, out: Map<string, FlowEdge[]>) => {
  const { back, order } = circles(flow, out);
  const layer = new Map<string, number>();
  for (const id of order) {
    const here = layer.get(id) ?? 0;
    layer.set(id, here);
    for (const edge of out.get(id) ?? []) {
      if (!back.has(edge)) {
        layer.set(edge.to, Math.max(layer.get(edge.to) ?? 0, here + 1));
      }
    }
  }
  const last = Math.max(
    0,
    ...flow.nodes
      .filter((node) => node.kind !== "end")
      .map((node) => layer.get(node.id) ?? 0)
  );
  // A source stands one column before the first box that it sends tasks to.
  for (const node of flow.nodes.filter((one) => one.kind === "source")) {
    const first = Math.min(
      ...(out.get(node.id) ?? []).map((edge) => layer.get(edge.to) ?? 1)
    );
    layer.set(node.id, Math.max(0, first - 1));
  }
  const columns: FlowNode[][] = [];
  for (const node of flow.nodes) {
    const column = node.kind === "end" ? last + 1 : (layer.get(node.id) ?? 0);
    columns[column] = [...(columns[column] ?? []), node];
  }
  const sorted = columns.map((column) =>
    (column ?? []).toSorted((a, b) => b.total - a.total)
  );
  // A source stands at the height of the box that it sends most tasks to, so its line does not cross the others.
  const [sources = [], next = []] = sorted;
  const row = (node: FlowNode) => {
    const [most] = (out.get(node.id) ?? []).toSorted(
      (a, b) => b.count - a.count
    );
    const at = next.findIndex((one) => one.id === most?.to);
    return at < 0 ? next.length : at;
  };
  return [
    sources.every((node) => node.kind === "source")
      ? sources.toSorted((a, b) => row(a) - row(b))
      : sources,
    ...sorted.slice(1),
  ];
};

/** A line from one side of a box to the same side of the other box, through `far`. */
const arc = (x1: number, y1: number, x2: number, y2: number, far: number) => ({
  labelX: middle(x1, x1, x2, x2),
  labelY: middle(y1, far, far, y2),
  path: `M${x1},${y1} C${x1},${far} ${x2},${far} ${x2},${y2}`,
});

/** How far from the boxes the line of a lane turns: each lane is one step farther. */
const reach = (lane: number) => ARC_BASE + lane * ARC_STEP;

/**
 * The line of an edge between two placed boxes: straight to the next column, over the boxes to a
 * later column, below the boxes to an earlier one, and a loop on a box to itself. Lines over and
 * below the boxes each have a lane, so their counts do not cover each other.
 */
const line = (
  from: PlacedNode,
  to: PlacedNode,
  lane: number,
  top: number,
  bottom: number
) => {
  if (from === to) {
    const x1 = from.x + NODE_W * 0.55;
    const x2 = from.x + NODE_W * 0.85;
    return {
      back: true,
      ...arc(x1, from.y, x2, from.y, from.y - LOOP_RISE),
      labelY: from.y - LOOP_RISE * 0.75,
    };
  }
  if (to.layer <= from.layer) {
    return {
      back: true,
      ...arc(
        from.x + NODE_W / 2,
        from.y + NODE_H,
        to.x + NODE_W / 2,
        to.y + NODE_H,
        bottom + reach(lane)
      ),
    };
  }
  if (to.layer > from.layer + 1) {
    const far = top - reach(lane);
    const x2 = to.x + NODE_W * 0.25;
    if (from.row === 0) {
      return {
        back: false,
        ...arc(from.x + NODE_W * 0.75, from.y, x2, to.y, far),
      };
    }
    // A box below the top of its column: its line leaves at the side and goes up between the columns.
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H * 0.25;
    const turn = x1 + COLUMN_GAP / 2;
    return {
      back: false,
      labelX: middle(x1, turn, x2, x2),
      labelY: middle(y1, far, far, to.y),
      path: `M${x1},${y1} C${turn},${far} ${x2},${far} ${x2},${to.y}`,
    };
  }
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const y2 = to.y + NODE_H / 2;
  const bend = (to.x - x1) / 2;
  return {
    back: false,
    labelX: middle(x1, x1 + bend, to.x - bend, to.x),
    labelY: middle(y1, y1, y2, y2),
    path: `M${x1},${y1} C${x1 + bend},${y1} ${to.x - bend},${y2} ${to.x},${y2}`,
  };
};

/**
 * Put the boxes in columns from left to right, and draw the lines. A line that would make a
 * circle goes back below the boxes, and does not move its box.
 */
export const layout = (all: Flow) => {
  // The picture has the channels and where their tasks came from. How the tasks of a channel
  // ended is in its box: lines from each channel to three ends would cover the flow.
  const flow: Flow = {
    edges: all.edges.filter((edge) => !edge.to.startsWith("end:")),
    nodes: all.nodes.filter((node) => node.kind !== "end"),
  };
  const ended = (id: string, ...ends: string[]) =>
    all.edges
      .filter(
        (edge) =>
          edge.from === id && ends.includes(edge.to.slice("end:".length))
      )
      .reduce((sum, edge) => sum + edge.count, 0);
  const out = new Map<string, FlowEdge[]>();
  for (const edge of flow.edges) {
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge]);
  }
  const columns = columnsOf(flow, out);
  const column = new Map(
    columns.flatMap((list, index) => list.map((node) => [node.id, index]))
  );
  const span = (edge: FlowEdge) =>
    (column.get(edge.to) ?? 0) - (column.get(edge.from) ?? 0);
  // The shortest line has the lane next to the boxes, so lines do not cross more than they must.
  const over = flow.edges
    .filter((edge) => span(edge) > 1)
    .toSorted((a, b) => span(a) - span(b));
  const under = flow.edges
    .filter((edge) => edge.from !== edge.to && span(edge) <= 0)
    .toSorted((a, b) => span(b) - span(a));
  // A line turns at three quarters of its reach: the room is for the farthest lane and its count.
  const room = (lanes: number) =>
    lanes === 0 ? 0 : reach(lanes - 1) * 0.75 + COUNT_ROOM;
  const sky = Math.max(LOOP_RISE, room(over.length));
  const ground = room(under.length);
  const tallest = Math.max(1, ...columns.map((list) => list.length));
  const height = tallest * (NODE_H + ROW_GAP) - ROW_GAP;
  const top = PAD + sky;
  const nodes: PlacedNode[] = columns.flatMap((list, index) => {
    const offset = (height - (list.length * (NODE_H + ROW_GAP) - ROW_GAP)) / 2;
    return list.map((node, row) => ({
      ...node,
      ended: {
        done: ended(node.id, "done"),
        not: ended(node.id, "failed", "canceled"),
      },
      layer: index,
      row,
      x: PAD + index * (NODE_W + COLUMN_GAP),
      y: top + offset + row * (NODE_H + ROW_GAP),
    }));
  });
  const at = new Map(nodes.map((node) => [node.id, node]));
  const most = Math.max(1, ...flow.edges.map((edge) => edge.count));
  const bottom = top + height;
  const edges: PlacedEdge[] = flow.edges.flatMap((edge) => {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    const lane = Math.max(over.indexOf(edge), under.indexOf(edge), 0);
    return from === undefined || to === undefined
      ? []
      : {
          ...edge,
          ...line(from, to, lane, top, bottom),
          width: WIDTH_MIN + (WIDTH_RANGE * edge.count) / most,
        };
  });
  return {
    edges,
    height: bottom + ground + PAD,
    nodes,
    width: PAD * 2 + columns.length * (NODE_W + COLUMN_GAP) - COLUMN_GAP,
  };
};

const PERIODS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];
const LABEL_MAX = 26;
/** A wait of a channel shows in its box when it is this long. */
const WAIT_SHOWN_MS = 60_000;
const PERCENT = 100;

const nodeName = (id: string) => {
  const at = id.indexOf(":");
  return id.startsWith("channel:") ? `#${id.slice(at + 1)}` : id.slice(at + 1);
};

const cut = (text: string) =>
  text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;

const edgeKind = (edge: PlacedEdge) => (edge.back ? "back" : "forward");

const NodeBox = (props: { readonly node: PlacedNode }) => {
  const { node } = props;
  if (node.kind !== "channel") {
    return (
      <g
        class={`flow-node flow-node--${node.kind} flow-node--${node.label}`}
        transform={`translate(${node.x},${node.y})`}
      >
        <rect height={NODE_H} width={NODE_W} />
        <text class="flow-node__title" x={NODE_W / 2} y={NODE_H / 2 + 5}>
          {node.label}
        </text>
      </g>
    );
  }
  const facts = [
    ...(node.agents.length === 0 ? ["people"] : node.agents),
    ...(node.medianRunMs === null
      ? []
      : [`~${duration(node.medianRunMs)} run`]),
    ...(node.medianWaitMs !== null && node.medianWaitMs >= WAIT_SHOWN_MS
      ? [`~${duration(node.medianWaitMs)} wait`]
      : []),
  ];
  return (
    <a
      href={`/board/tasks?channel=${encodeURIComponent(node.label)}&state=all`}
    >
      <g class="flow-node" transform={`translate(${node.x},${node.y})`}>
        <rect
          class="flow-node__shadow"
          height={NODE_H}
          width={NODE_W}
          x="4"
          y="4"
        />
        <rect height={NODE_H} width={NODE_W} />
        <text class="flow-node__title" x="12" y="22">
          {cut(`#${node.label}`)}
        </text>
        <text class="flow-node__fact" x="12" y="40">
          {`${node.total} ${node.total === 1 ? "task" : "tasks"}${node.open > 0 ? ` · ${node.open} open` : ""}`}
        </text>
        <text class="flow-node__fact flow-node__fact--agents" x="12" y="56">
          {cut(facts.join(" · "))}
        </text>
        <text class="flow-node__fact" x="12" y="72">
          {node.ended.done + node.ended.not === 0
            ? "none ended yet"
            : `ended: ${node.ended.done} done`}
          {node.ended.not === 0 ? null : (
            <tspan class="flow-node__not">{` · ${node.ended.not} not`}</tspan>
          )}
        </text>
      </g>
    </a>
  );
};

const Graph = (props: { readonly flow: Flow }) => {
  const placed = layout(props.flow);
  return (
    <div class="flow-graph">
      <svg
        aria-label="The flow of tasks between channels"
        height={placed.height}
        role="img"
        viewBox={`0 0 ${placed.width} ${placed.height}`}
        width={placed.width}
      >
        <defs>
          {["forward", "back"].map((kind) => (
            <marker
              class={`flow-arrow flow-arrow--${kind}`}
              id={`arrow-${kind}`}
              key={kind}
              markerHeight="10"
              markerUnits="userSpaceOnUse"
              markerWidth="10"
              orient="auto"
              refX="9"
              refY="5"
              viewBox="0 0 10 10"
            >
              <path d="M0,0 L10,5 L0,10 z" />
            </marker>
          ))}
        </defs>
        {placed.edges.map((edge) => (
          <path
            class={`flow-edge flow-edge--${edgeKind(edge)}`}
            d={edge.path}
            key={`${edge.from}>${edge.to}`}
            style={{
              markerEnd: `url(#arrow-${edgeKind(edge)})`,
              strokeWidth: edge.width,
            }}
          />
        ))}
        {placed.nodes.map((node) => (
          <NodeBox key={node.id} node={node} />
        ))}
        {placed.edges.map((edge) => (
          <g
            class={`flow-count flow-count--${edgeKind(edge)}`}
            key={`${edge.from}>${edge.to}`}
            transform={`translate(${edge.labelX},${edge.labelY})`}
          >
            <rect height="18" width="28" x="-14" y="-9" />
            <text y="4">{edge.count}</text>
          </g>
        ))}
      </svg>
    </div>
  );
};

const Stat = (props: { readonly label: string; readonly value: string }) => (
  <div class="stat">
    <span class="stat__value">{props.value}</span>
    <span class="label">{props.label}</span>
  </div>
);

const Paths = (props: { readonly flow: Flow }) => {
  const rework = new Set(
    layout(props.flow)
      .edges.filter((edge) => edge.back)
      .map((edge) => `${edge.from}>${edge.to}`)
  );
  const ways = props.flow.edges.map((edge) => ({
    ...edge,
    back: rework.has(`${edge.from}>${edge.to}`),
  }));
  const total = ways.reduce((sum, edge) => sum + edge.count, 0);
  return (
    <section class="card">
      <header class="card__head">
        <h2 class="card__title">Ways</h2>
        <span class="hint">the busiest first</span>
      </header>
      <div class="table-wrap">
        <table class="table">
          <tbody>
            {ways
              .toSorted((a, b) => b.count - a.count)
              .map((edge) => (
                <tr key={`${edge.from}>${edge.to}`}>
                  <td class="nowrap mono small">
                    {`${nodeName(edge.from)} → ${nodeName(edge.to)}`}
                  </td>
                  <td class="nowrap">
                    {edge.back ? (
                      <span class="chip chip--running">rework</span>
                    ) : null}
                  </td>
                  <td class="nowrap mono">{edge.count}</td>
                  <td>
                    <div class="meter meter--compact">
                      <div class="meter__bar">
                        <div
                          class="meter__fill"
                          style={{
                            width: `${(edge.count / total) * PERCENT}%`,
                          }}
                        />
                      </div>
                    </div>
                  </td>
                  <td class="table__fill small">
                    {edge.tasks.map((task) => (
                      <a class="need" href={`/board/tasks/${task}`} key={task}>
                        {`#${task}`}
                      </a>
                    ))}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export const FlowPage = () => {
  const [days, setDays] = useState(30);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<Flow>(`${FACTORY}/flow`, { days })
      .then(setFlow)
      .catch((failure: Error) => setError(failure.message));
  }, [days]);
  const pick = (event: MouseEvent) =>
    setDays(Number((event.currentTarget as HTMLButtonElement).value));
  const channels = flow?.nodes.filter((node) => node.kind === "channel") ?? [];
  const tasks = channels.reduce((sum, node) => sum + node.total, 0);
  const open = channels.reduce((sum, node) => sum + node.open, 0);
  const into = (end: string) =>
    (flow?.edges ?? [])
      .filter((edge) => edge.to === `end:${end}`)
      .reduce((sum, edge) => sum + edge.count, 0);
  const rework =
    flow === null
      ? 0
      : layout(flow)
          .edges.filter((edge) => edge.back)
          .reduce((sum, edge) => sum + edge.count, 0);
  return (
    <div class="fpage stack">
      <div class="page-head page-head--tight">
        <div>
          <span class="eyebrow">Flow</span>
          <h1 class="title title--small">How tasks move</h1>
        </div>
        <div class="switch">
          {PERIODS.map((period) => (
            <button
              aria-pressed={period.days === days}
              key={period.days}
              onClick={pick}
              type="button"
              value={period.days}
            >
              {period.label}
            </button>
          ))}
        </div>
      </div>
      {error === null ? null : <div class="notice notice--bad">{error}</div>}
      {flow === null ? <p class="empty">Loading…</p> : null}
      {flow !== null && tasks === 0 ? (
        <p class="empty">
          No task was made in this time. Make a task on the board, and its way
          shows here.
        </p>
      ) : null}
      {flow !== null && tasks > 0 ? (
        <>
          <div class="stats">
            <Stat label="tasks" value={String(tasks)} />
            <Stat label="open now" value={String(open)} />
            <Stat label="ended as done" value={String(into("done"))} />
            <Stat
              label="ended as failed or canceled"
              value={String(into("failed") + into("canceled"))}
            />
            <Stat label="sent back (rework)" value={String(rework)} />
          </div>
          <section class="card">
            <Graph flow={flow} />
            <p class="flow-legend hint">
              A line is as thick as the number of tasks that went that way. A
              dashed purple line goes back: rework. Each box shows who does its
              tasks, the median time of a run, and how its tasks ended.
            </p>
          </section>
          <Paths flow={flow} />
        </>
      ) : null}
    </div>
  );
};
