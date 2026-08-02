import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
  type Edge,
  type FitViewOptions,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { ActionButtons } from "./ActionButtons";
import { AcurastMark, PolkadotMark, RainbowMark, RecentreMark, TunnelMark, UserMark } from "./Logos";
import type { Health } from "../chain/health";
import { processorState, type Action, type ProcessorState } from "./processor";
import type { Step, StepId, StepState } from "./ProofRail";

/**
 * The proof trace, as the shape it actually is.
 *
 * The stepper this replaces was a straight line of six pips, and a straight
 * line is the one thing this system is not. Four parties are involved and the
 * work bounces between them — the app asks the Processor for a seed and the
 * Processor answers, the app sends a log and the Processor sends back a
 * signature — so a reader following the line left to right learned the order
 * of events and nothing about who was doing them. That was the actual gap:
 * "Seed issued" never said issued *by whom*, which is the entire claim.
 *
 * So it is drawn as the diagram: you, the app in your browser, the Acurast
 * Processor, and the leaderboard contract, with the six steps as the arrows
 * between them. The two round trips are visible as round trips. Everything
 * that happens somewhere the player cannot reach is on the right-hand side of
 * the picture, which is the point being made.
 *
 * The view can be panned and zoomed, and a Recentre button puts it back. The
 * picture itself is fixed though — nodes cannot be dragged and nothing is
 * selectable — so what moves is the camera, never the argument.
 */

/** State-to-class, shared by nodes and edges so one run colours the whole picture. */
const cls = (state: StepState) => `s-${state}`;

/**
 * The arrowhead, in the colour of the step it ends.
 *
 * Literal hex rather than the CSS variables the rest of the file uses, and not
 * by preference: React Flow hoists markers into a shared `<defs>` and keys them
 * by colour, so every edge sharing a colour shares one marker element. A class
 * on the edge cannot reach it, which is why the state has to be resolved to a
 * value here. These four are `--line`, `--primary`, `--ok` and `--bad` from
 * styles.css and must be changed with them.
 */
const ARROW_INK: Record<StepState, string> = {
  idle: "#d9e2ec",
  active: "#005fc8",
  done: "#0a7d4a",
  failed: "#c8102e",
};

const arrow = (state: StepState) => ({
  type: MarkerType.ArrowClosed,
  width: 15,
  height: 15,
  color: ARROW_INK[state],
});

interface BoxData extends Record<string, unknown> {
  /**
   * The box's own name, and the loudest thing in it — "Polkadot Product App",
   * "Acurast Processor". The party is the unit of this diagram: what sits
   * inside it is a property of it, not a peer of it. An earlier draft had this
   * the other way round, which made "Account" and "Verifier" look like the
   * four parties and the boxes look like decoration.
   */
  party: string;
  /**
   * The subheader: what kind of thing the party is, or what it holds —
   * "Polkadot Product App", "Verifier". Secondary, and read as detail.
   */
  detail: string;
  /** Its brand mark, if it has one. */
  mark?: React.ReactNode;
  /** A mark for the subheader, when the *kind* has its own brand. */
  detailMark?: React.ReactNode;
  /** How this party is doing, taken from the step that lives in it. */
  state: StepState;
  /** A further line of detail, when there is one worth saying. */
  note?: string;
  /** Which side its round-trip handles hang off. */
  side?: "app" | "processor";
  /** Liveness, for the party that can simply not be there. */
  health?: Health;
  /** What the status line says — decided in one place, see `processorState`. */
  healthText?: string;
  /** Whatever the current situation offers, in the order to offer it. */
  actions?: Action[];
}

/**
 * The app, and the Processor.
 *
 * Both are boxes with a name, what they hold, and four handles a side — one
 * per direction of each round trip. The handles are explicit rather than left
 * to default placement because two edges run each way between the same pair of
 * nodes, and defaults would stack all four on one point.
 */
function PartyNode({ data }: NodeProps<Node<BoxData>>) {
  const isApp = data.side === "app";
  const side = isApp ? Position.Right : Position.Left;
  const type = isApp ? "source" : "target";

  return (
    <div className={`flow-node ${cls(data.state)}`}>
      <strong className="flow-party">
        {data.mark && (
          <span className="glyph" aria-hidden="true">
            {data.mark}
          </span>
        )}
        {data.party}
      </strong>
      <span className="flow-detail">
        {data.detailMark && (
          <span className="glyph" aria-hidden="true">
            {data.detailMark}
          </span>
        )}
        {data.detail}
      </span>
      {data.note && <span className="flow-note">{data.note}</span>}

      {data.healthText && (
        <span className={`flow-health h-${data.health ?? "unknown"}`}>
          <span className="dot" aria-hidden="true" />
          {data.healthText}
        </span>
      )}

      {/* Absolutely positioned, so offering these does not make the box taller.
          The four round-trip handles sit at percentages of that height, and a
          box that grew when the Processor went down would tilt all four edges
          at exactly the moment the picture needs to stay readable. */}
      {data.actions && data.actions.length > 0 && (
        <span className="flow-offline-action">
          <ActionButtons actions={data.actions} />
        </span>
      )}

      {/* Top to bottom: ask, answer, ask, answer. */}
      <Handle type={type} position={side} id="req" style={{ top: "24%" }} isConnectable={false} />
      <Handle
        type={type === "source" ? "target" : "source"}
        position={side}
        id="seed"
        style={{ top: "41%" }}
        isConnectable={false}
      />
      <Handle type={type} position={side} id="log" style={{ top: "60%" }} isConnectable={false} />
      <Handle
        type={type === "source" ? "target" : "source"}
        position={side}
        id="signed"
        style={{ top: "77%" }}
        isConnectable={false}
      />

      {/* You are to the left, so you arrive on the left edge; the score leaves
          downwards and turns right into the leaderboard, so it departs from
          the bottom. One handle each, no offsets needed. */}
      {isApp && (
        <>
          <Handle type="target" position={Position.Left} id="play" isConnectable={false} />
          <Handle type="source" position={Position.Bottom} id="chain" isConnectable={false} />
        </>
      )}
    </div>
  );
}

/** You. The only party here that is not a machine. */
function YouNode({ data }: NodeProps<Node<BoxData>>) {
  return (
    <div className={`flow-you ${cls(data.state)}`}>
      <span className="glyph" aria-hidden="true">
        <UserMark />
      </span>
      <strong>{data.party}</strong>
      <Handle type="source" position={Position.Right} id="play" isConnectable={false} />
    </div>
  );
}

/**
 * The tunnel the app and the Processor talk through.
 *
 * Not a party — nothing here is addressed to it — so it is drawn as the
 * boundary the four arrows cross rather than as a fifth box. That is also what
 * it is in fact: an Acurast Processor is a phone, with no public address of its
 * own, so it attaches as a connector to a tunnel and reaches the world through
 * that hostname. Every request between the two columns goes through here.
 *
 * Worth drawing because leaving it out implied a direct line that does not
 * exist. Worth drawing *as a line* because of what it can and cannot do: it
 * carries the traffic and can therefore drop it, but the signature is made by a
 * key inside the secure element, so a tunnel that tampered would produce a
 * score the contract rejects rather than one it believes.
 */
function TunnelNode({ data }: NodeProps<Node<BoxData>>) {
  return (
    <div className={`flow-tunnel ${cls(data.state)}`}>
      <span className="flow-tunnel-label">
        <span className="glyph" aria-hidden="true">
          <TunnelMark />
        </span>
        {data.party}
      </span>
      {data.detail && <span className="flow-tunnel-host">{data.detail}</span>}
      <span className="flow-tunnel-line" aria-hidden="true" />
    </div>
  );
}

/** The leaderboard contract, which is the only party that decides anything. */
function ChainNode({ data }: NodeProps<Node<BoxData>>) {
  return (
    <div className={`flow-node flow-chain ${cls(data.state)}`}>
      <strong className="flow-party">
        <span className="glyph" aria-hidden="true">
          <PolkadotMark />
        </span>
        {data.party}
      </strong>
      <span className="flow-detail">
        {data.detailMark && (
          <span className="glyph" aria-hidden="true">
            {data.detailMark}
          </span>
        )}
        {data.detail}
      </span>
      {/* Left, not top: it sits directly under the Verifier in the same
          column, and an arrow arriving on its top edge would read as coming
          down out of the Processor — which is the one path a score must never
          take. It comes from the App, from the side. */}
      <Handle type="target" position={Position.Left} id="chain" isConnectable={false} />
    </div>
  );
}

const NODE_TYPES = { party: PartyNode, you: YouNode, chain: ChainNode, tunnel: TunnelNode };

/**
 * What sits between the app and the Processor, named from the URL in use.
 *
 * Deliberately generic. This deployment happens to reach its Processor through
 * a Cloudflare named tunnel, but nothing in the design requires that one — the
 * Processor is a phone with no public address, and *any* service that gives it
 * a reachable hostname does the job. Naming a vendor here would read as a
 * dependency the architecture does not have, so the label says what the thing
 * is and the hostname underneath says which one is actually in use.
 *
 * A verifier on localhost has no tunnel at all, and the verifier URL is
 * editable in the settings panel precisely so it can be pointed there.
 */
const tunnelName = (verifier: string | null): { label: string; host: string } => {
  // The simulator answers from this tab. There is no tunnel, no Processor and
  // no network — drawing one anyway would be the diagram's only lie.
  if (verifier === null) return { label: "Simulated", host: "in this tab" };

  let host: string;
  try {
    host = new URL(verifier).hostname;
  } catch {
    return { label: "Tunnel service", host: "" };
  }
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) {
    return { label: "Direct — no tunnel", host };
  }
  return { label: "Tunnel service", host };
};

/**
 * How the picture sits in its box.
 *
 * `maxZoom: 1` is the important half. Without it a container wider than the
 * diagram does not centre it — `fitView` fills the space instead, scaling the
 * drawing up to twice size and turning 10px labels into 20px ones. Capped at
 * 1:1, a surplus of width becomes margin on both sides, which is what being
 * centred means. The centring itself is unconditional either way: the fit is
 * computed as `width / 2 - boundsCentre * zoom`, so the drawing is placed
 * about the middle whatever the zoom works out to.
 *
 * The padding is per side and taken from the *container*, not the content —
 * 0.06 spends 12% of the available width in total. It was 0.12, which spent
 * 24% and shrank the whole diagram to fit the remaining three quarters.
 */
const FIT: FitViewOptions = { padding: 0.06, maxZoom: 1 };

/**
 * Keeps the diagram centred for the whole of its life, not just at birth.
 *
 * The `fitView` prop fits once, on mount. After that React Flow's resize
 * observer updates the measured width and height in its store but deliberately
 * leaves the viewport alone — so every later change of size (the window, the
 * panel, coming back out of fullscreen, a phone turning landscape) left the
 * drawing pinned wherever it happened to be and increasingly off-centre.
 *
 * Watching the store's own dimensions rather than adding a second
 * ResizeObserver means this reacts to exactly what React Flow itself measured,
 * so the re-fit cannot race the measurement it depends on.
 *
 * Rendered as a child of `<ReactFlow>` because that is what puts it inside the
 * provider the hooks need.
 */
function KeepCentred({ paused }: { paused: boolean }) {
  const { fitView } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);

  useEffect(() => {
    // Once someone has panned or zoomed, the view is theirs. Re-centring on
    // the next resize would snatch it back mid-inspection, so the automatic
    // fit stands down until Recentre is pressed.
    if (paused || !width || !height) return;
    void fitView(FIT);
  }, [width, height, fitView, paused]);

  return null;
}

/**
 * Zoom out, zoom in, recentre.
 *
 * Explicit buttons rather than relying on the gestures alone, because the one
 * gesture people reach for first — the wheel — is deliberately not wired to
 * zoom here (see the pane props below), and a diagram you cannot obviously
 * zoom is worse than one you cannot zoom at all.
 */
function FlowControls({ onRecentre }: { onRecentre: () => void }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  return (
    <Panel position="top-right" className="flow-controls">
      <button type="button" onClick={() => void zoomOut()} title="Zoom out" aria-label="Zoom out">
        <span aria-hidden="true">−</span>
      </button>
      <button type="button" onClick={() => void zoomIn()} title="Zoom in" aria-label="Zoom in">
        <span aria-hidden="true">+</span>
      </button>
      <button
        type="button"
        onClick={() => {
          void fitView(FIT);
          onRecentre();
        }}
        title="Recentre the diagram"
        aria-label="Recentre the diagram"
      >
        <RecentreMark />
      </button>
    </Panel>
  );
}

export function ProofFlow({
  steps,
  address,
  verifier,
  health,
  simulated,
  simulationForced,
  onToggleSimulation,
  onRecheck,
}: {
  steps: Step[];
  address: string | null;
  /** The verifier URL, or null when the enclave is simulated in this tab. */
  verifier: string | null;
  /** Liveness of the real Processor — probed even while simulating. */
  health: Health;
  /** Whether the enclave is currently being simulated in this tab. */
  simulated: boolean;
  /**
   * True when the tier gives no choice about that — a guest, who has no account
   * to open a session with the deployed enclave. The Processor is then not
   * probed at all, so this box must not report on it either way.
   */
  simulationForced: boolean;
  onToggleSimulation: () => void;
  onRecheck: () => void;
}) {
  // By id rather than by position: the six steps arrive in the order the rail
  // lists them, which is not the order they appear around this diagram.
  const at = (id: StepId): StepState => steps.find((s) => s.id === id)?.state ?? "idle";
  const account = at("account");
  const seed = at("seed");
  const run = at("run");
  const log = at("log");
  const signed = at("signed");
  const chain = at("chain");

  // The tunnel is carrying whenever either round trip is in flight, and has
  // carried once the signature is back. It has no step of its own — it is the
  // medium three of them travel over.
  const traffic: StepState[] = [seed, log, signed];
  const tunnel: StepState = traffic.includes("failed")
    ? "failed"
    : traffic.includes("active")
      ? "active"
      : signed === "done"
        ? "done"
        : "idle";

  const { label: tunnelLabel, host: tunnelHost } = tunnelName(verifier);

  /**
   * Everything the Processor box says about itself.
   *
   * The ladder itself lives in `processor.ts`, because the cabinet's own strip
   * has to offer the same way out of the same dead end — see the note there.
   * What is local is the memo, and it has to be: `actions` is an array literal,
   * so an unmemoised call returns a fresh reference on every render. That
   * reference is a dependency of `nodes` below, and `Play` re-renders ten times
   * a second while a run is going — the HUD sample. So the node array was being
   * rebuilt at 10 Hz for the whole length of every run, and the diagram
   * flickered from the first frame of play to the last.
   */
  const processor: ProcessorState = useMemo(
    () => processorState({ health, simulated, simulationForced, onRecheck, onToggleSimulation }),
    [simulationForced, simulated, health, onRecheck, onToggleSimulation],
  );

  /**
   * Whether the view has been moved by hand.
   *
   * React Flow reports programmatic moves with a null event and user gestures
   * with the real one, so this distinguishes "they dragged it" from "we just
   * re-fitted it" — without which every automatic re-centre would immediately
   * mark the view as touched and disable itself.
   */
  const [touched, setTouched] = useState(false);
  const onMoveStart = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (event) setTouched(true);
  }, []);

  const nodes = useMemo<Node<BoxData>[]>(
    () => [
      // Positions are hand-set rather than laid out automatically: this is a
      // fixed six-step story, and the gaps are sized for the edge labels that
      // sit in them. Three columns left to right — you, the app, the Processor
      // — with the leaderboard under the Processor in its column. Each gap is
      // ~150px because the widest label between two boxes is about 100.
      //
      // The row is what makes the picture argue its case: the further right a
      // thing sits, the less say you have over it.
      {
        id: "you",
        // y=89 rather than the app's 62: the pill is shorter than the boxes,
        // and this is the offset that puts its centre level with theirs, so
        // the ③ arrow runs flat instead of sloping.
        position: { x: 0, y: 89 },
        type: "you",
        data: { party: "You", detail: "", state: run },
        draggable: false,
      },
      {
        id: "app",
        type: "party",
        position: { x: 200, y: 62 },
        data: {
          // Three tiers, narrowing: what this is called, what kind of thing it
          // is, and who is signed into it. The app is Rainbow — a name — and
          // "Polkadot Product App" is its category, so it reads as the aside
          // it is rather than competing with the name for the same line.
          party: "Rainbow",
          mark: <RainbowMark />,
          detail: "(Polkadot Product App)",
          detailMark: <PolkadotMark />,
          // The address is the whole content of step one: connected or not.
          // A guest reaches the second branch, which is the true statement —
          // they are playing, and no account is connected.
          note: address ? `Account · ${address}` : "Account · not connected",
          state: account,
          side: "app",
        },
        draggable: false,
      },
      {
        id: "processor",
        type: "party",
        position: { x: 540, y: 62 },
        data: {
          party: "Acurast Processor",
          mark: <AcurastMark />,
          // While simulating, the box has to stop describing a phone it is not
          // talking to. The name stays — it is still the seat of that role in
          // the picture — but everything under it says where the answers are
          // really coming from.
          detail: simulated ? "(Simulated in this tab)" : "(Verifier)",
          note: simulated ? "dev key — cannot land" : "TEE enclave",
          // The Processor is busy for as long as either round trip is open.
          state: signed === "idle" ? seed : signed,
          side: "processor",
          health: processor.tone,
          healthText: processor.text,
          actions: processor.actions,
        },
        draggable: false,
      },
      {
        id: "chain",
        type: "chain",
        // Same x as the Processor: they share a column, which is the whole
        // point of the arrangement — everything you cannot reach is over here.
        position: { x: 540, y: 262 },
        data: { party: "Leaderboard contract", detail: "(Asset Hub)", state: chain },
        draggable: false,
      },
      {
        id: "tunnel",
        type: "tunnel",
        // Centred in the gap between the two columns, and started above them
        // so its caption sits in the empty band over the boxes rather than in
        // among the four edge labels it would otherwise land on.
        position: { x: 394, y: 8 },
        data: { party: tunnelLabel, detail: tunnelHost, state: tunnel },
        draggable: false,
        selectable: false,
      },
    ],
    [
      account,
      seed,
      run,
      signed,
      chain,
      address,
      tunnel,
      tunnelLabel,
      tunnelHost,
      simulated,
      processor,
    ],
  );

  const edges = useMemo<Edge[]>(
    () => [
      {
        id: "req",
        source: "app",
        target: "processor",
        sourceHandle: "req",
        targetHandle: "req",
        label: "① Request a seed",
        className: cls(seed),
        animated: seed === "active",
        markerEnd: arrow(seed),
      },
      {
        id: "seed",
        source: "processor",
        target: "app",
        sourceHandle: "seed",
        targetHandle: "seed",
        label: "② Seed issued",
        className: cls(seed),
        animated: seed === "active",
        markerEnd: arrow(seed),
      },
      {
        id: "play",
        source: "you",
        target: "app",
        sourceHandle: "play",
        targetHandle: "play",
        label: "③ Play the run",
        className: cls(run),
        animated: run === "active",
        markerEnd: arrow(run),
      },
      {
        id: "log",
        source: "app",
        target: "processor",
        sourceHandle: "log",
        targetHandle: "log",
        label: "④ Log, no score",
        className: cls(log),
        animated: log === "active",
        markerEnd: arrow(log),
      },
      {
        id: "signed",
        source: "processor",
        target: "app",
        sourceHandle: "signed",
        targetHandle: "signed",
        label: "⑤ Replayed + signed",
        className: cls(signed),
        animated: signed === "active",
        markerEnd: arrow(signed),
      },
      {
        id: "chain",
        source: "app",
        target: "chain",
        sourceHandle: "chain",
        targetHandle: "chain",
        // The one step a simulated run can never take, said on the arrow
        // itself rather than only in prose somewhere below. The signature on
        // offer is from a key printed in this repository; the contract's
        // verifier set does not contain it, so this submit would spend a
        // transaction to be told what is already known. Struck through in red
        // so the picture cannot be misread as "six of six".
        label: simulated ? "✕ cannot be submitted" : "⑥ Score + signature",
        className: simulated ? "s-blocked" : cls(chain),
        animated: !simulated && chain === "active",
        markerEnd: arrow(simulated ? "failed" : chain),
      },
    ],
    [seed, run, log, signed, chain, simulated],
  );

  return (
    <div className="proof-flow">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        defaultEdgeOptions={{ type: "smoothstep" }}
        fitView
        fitViewOptions={FIT}
        onMoveStart={onMoveStart}
        minZoom={0.4}
        maxZoom={2.5}
        // Drag to pan, pinch or double-click or the buttons to zoom.
        panOnDrag
        zoomOnPinch
        zoomOnDoubleClick
        // The wheel is deliberately NOT a zoom, and `preventScrolling={false}`
        // is what guarantees it: this diagram sits in the middle of a page
        // people scroll past, and the default behaviour swallows the wheel to
        // zoom the graph. That leaves someone scrolling the page stuck the
        // moment the pointer crosses it, having to fling the mouse aside to
        // get out — a much worse cost than the convenience of wheel-zoom.
        zoomOnScroll={false}
        panOnScroll={false}
        preventScrolling={false}
        // The picture is still not editable; only the view of it moves.
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: false }}
      >
        <KeepCentred paused={touched} />
        <FlowControls onRecentre={() => setTouched(false)} />
      </ReactFlow>
    </div>
  );
}
