import "@xyflow/react/dist/style.css"
import { useMemo } from "react"
import type { PlanGraph, PlanNode, PlanNodeKind } from "@starbase/core"
import Dagre from "@dagrejs/dagre"
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider
} from "@xyflow/react"
import { GitBranch, Waypoints } from "lucide-react"
import { cn } from "../lib/cn.js"

const NODE_W = 190
const NODE_H = 60

/** Per-kind accent (border + dot) so decisions stand out from the flow. */
const KIND_ACCENT: Record<PlanNodeKind, { ring: string; dot: string; text: string }> = {
  start: { ring: "border-green/50", dot: "bg-green", text: "text-green" },
  decision: { ring: "border-yellow/55", dot: "bg-yellow", text: "text-yellow" },
  action: { ring: "border-line-strong", dot: "bg-line-strong", text: "text-muted-foreground" },
  io: { ring: "border-cyan/50", dot: "bg-cyan", text: "text-cyan" },
  terminal: { ring: "border-blue/50", dot: "bg-blue", text: "text-blue" },
  note: { ring: "border-purple/50", dot: "bg-purple", text: "text-purple" }
}

interface NodeData extends Record<string, unknown> {
  readonly node: PlanNode
  readonly selected: boolean
}

/** A single flow node — decisions get a diamond-ish accent + branch glyph. */
function FlowNode({ data }: NodeProps<Node<NodeData>>) {
  const { node, selected } = data
  const accent = KIND_ACCENT[node.kind]
  const isDecision = node.kind === "decision"
  return (
    <div
      style={{ width: NODE_W, minHeight: NODE_H }}
      className={cn(
        "flex flex-col justify-center gap-0.5 rounded-lg border bg-panel px-3 py-2 shadow-sm transition-colors",
        selected ? "border-blue bg-blue/10 ring-1 ring-blue/40" : accent.ring,
        node.stepId && "cursor-pointer"
      )}
    >
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !bg-line-strong" />
      <div className="flex items-center gap-1.5">
        <span className={cn("size-1.5 flex-none rounded-full", accent.dot)} />
        {isDecision && <GitBranch className="size-3 flex-none text-yellow" />}
        <span className={cn("truncate text-[9px] font-semibold uppercase tracking-[0.4px]", accent.text)}>
          {node.kind}
        </span>
      </div>
      <span className="truncate text-[12px] font-medium text-text">{node.label}</span>
      {node.detail && (
        <span className="truncate font-mono text-[9px] text-muted-foreground">{node.detail}</span>
      )}
      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !bg-line-strong" />
    </div>
  )
}

const nodeTypes = { planNode: FlowNode }

/** Lay the graph out top-down with dagre; returns react-flow nodes + edges. */
const layout = (graph: PlanGraph, selectedStepId: string | null | undefined) => {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: "TB", nodesep: 48, ranksep: 64, marginx: 16, marginy: 16 })
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H })
  for (const e of graph.edges) g.setEdge(e.from, e.to)
  Dagre.layout(g)

  const nodes: Array<Node<NodeData>> = graph.nodes.map((node) => {
    const pos = g.node(node.id)
    return {
      id: node.id,
      type: "planNode",
      position: { x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2 },
      data: { node, selected: node.stepId != null && node.stepId === selectedStepId }
    }
  })

  const edges = graph.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    label: e.label ?? undefined,
    type: "smoothstep",
    animated: false,
    labelBgPadding: [6, 2] as [number, number],
    labelBgBorderRadius: 4,
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }
  }))

  return { nodes, edges }
}

/**
 * A step's DECISION flow on a navigable react-flow canvas — how the logic and
 * its branches move through that step's change (a state machine / user flow, not
 * a linear action list). Nodes may link back to plan steps; clicking one calls
 * `onSelect`. Pan / zoom / fit. In `embedded` mode (rendered inside a step's
 * spec) the header + minimap are dropped to fit a compact panel.
 */
export function PlanFlow({
  graph,
  selectedId,
  onSelect,
  embedded = false,
  className
}: {
  /** The flow to render (a step's `graph`, or a legacy plan-level graph), or null. */
  graph: PlanGraph | null
  /** The selected STEP id (highlights nodes linked to it). */
  selectedId?: string | null
  /** Called with a node's linked step id when clicked. */
  onSelect?: (stepId: string) => void
  /** Compact variant for embedding in a step's spec (no header, no minimap). */
  embedded?: boolean
  className?: string
}) {
  const { nodes, edges } = useMemo(
    () => (graph ? layout(graph, selectedId) : { nodes: [], edges: [] }),
    [graph, selectedId]
  )

  const decisions = graph?.nodes.filter((n) => n.kind === "decision").length ?? 0

  if (!graph || graph.nodes.length === 0) {
    return (
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-editor text-center",
          className
        )}
      >
        <Waypoints className="size-8 text-line-strong" />
        <div className="max-w-xs text-[13px] leading-[1.5] text-muted-foreground">
          This step has no decision flow. Route a comment asking the agent to sketch how its logic
          branches, and it'll show up here.
        </div>
      </div>
    )
  }

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-editor", className)}>
      {!embedded && (
        <div className="flex flex-none items-center gap-2.5 border-b border-hairline px-3.5 py-2">
          <Waypoints className="size-3.5 text-muted-foreground" />
          <span className="text-[12px] font-semibold text-text">Decision flow</span>
          <span className="font-mono text-[10.5px] text-muted-foreground">
            {graph.nodes.length} nodes · {decisions} {decisions === 1 ? "decision" : "decisions"}
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode="dark"
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.3}
            maxZoom={1.75}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={false}
            edgesFocusable={false}
            onNodeClick={(_, node) => {
              const stepId = (node.data as NodeData).node.stepId
              if (stepId) onSelect?.(stepId)
            }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} className="!bg-editor" />
            <Controls showInteractive={false} />
            {!embedded && <MiniMap pannable zoomable nodeStrokeWidth={2} className="!bg-panel" />}
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  )
}
