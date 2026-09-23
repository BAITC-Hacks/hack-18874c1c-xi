import type { AnalysisResult, GraphNode } from "@money-graph/contracts";
import type { ElementDefinition } from "cytoscape";
import { ROLES_PRESENTATION } from "./presentation";

const NODE_SPACING = 82;
const RING_SPACING = 100;
const CLUSTER_GAP = 150;

/** Compact directional view only. These positions do not alter graph or role data. */
export function createNeighborhoodPositions(gid: string, incoming: string[], outgoing: string[]) {
  const incomingIds = new Set(incoming.filter((id) => id !== gid));
  const outgoingIds = new Set(outgoing.filter((id) => id !== gid));
  const both = [...incomingIds].filter((id) => outgoingIds.has(id)).sort();
  const left = [...incomingIds].filter((id) => !outgoingIds.has(id)).sort();
  const right = [...outgoingIds].filter((id) => !incomingIds.has(id)).sort();
  const positions = new Map<string, { x: number; y: number }>([[gid, { x: 0, y: 0 }]]);
  let sideHeight = 0;
  for (const [ids, direction] of [[left, -1], [right, 1]] as const) {
    const rows = Math.min(ids.length, Math.max(3, Math.ceil(Math.sqrt(ids.length) * 1.3)));
    sideHeight = Math.max(sideHeight, (rows - 1) * 92 / 2);
    ids.forEach((id, index) => positions.set(id, {
      x: direction * (250 + Math.floor(index / rows) * 180),
      y: ((index % rows) - (rows - 1) / 2) * 92,
    }));
  }
  const columns = Math.min(6, Math.max(1, Math.ceil(Math.sqrt(both.length) * 1.5)));
  both.forEach((id, index) => positions.set(id, {
    x: ((index % columns) - (Math.min(columns, both.length) - 1) / 2) * 175,
    y: -Math.max(180, sideHeight + 145) - Math.floor(index / columns) * 92,
  }));
  return positions;
}

/** A bounded display layout, not a new clustering or scoring algorithm. */
export function createGraphElements(result: AnalysisResult): ElementDefinition[] {
  const groups = new Map<number, GraphNode[]>();
  const byGid = new Map(result.nodes.map((node) => [node.gid, node]));
  const adjacent = new Map(result.nodes.map((node) => [node.gid, [] as string[]]));
  for (const node of result.nodes) {
    const group = groups.get(node.cluster_id);
    if (group) group.push(node);
    else groups.set(node.cluster_id, [node]);
  }
  for (const edge of result.edges) {
    if (byGid.get(edge.src)?.cluster_id !== byGid.get(edge.dst)?.cluster_id || edge.src === edge.dst) continue;
    adjacent.get(edge.src)?.push(edge.dst);
    adjacent.get(edge.dst)?.push(edge.src);
  }

  const clusters = [...groups].map(([clusterId, nodes]) => {
    // Supplied priority/degree only guide drawing; analytical values never change.
    const ranked = [...nodes].sort((a, b) => b.priority_score - a.priority_score
      || (b.metrics.in_degree + b.metrics.out_degree) - (a.metrics.in_degree + a.metrics.out_degree)
      || (a.gid < b.gid ? -1 : a.gid > b.gid ? 1 : 0));
    // Transpose the symmetric adjacency lists in rank order: linear in edges,
    // even for dense stars, and independent of API edge ordering.
    const orderedAdjacent = new Map(ranked.map((node) => [node.gid, [] as string[]]));
    for (const node of ranked) {
      for (const neighbor of adjacent.get(node.gid)!) orderedAdjacent.get(neighbor)!.push(node.gid);
    }
    const ordered: GraphNode[] = [];
    const visited = new Set<string>();
    // Breadth-first ordering keeps connected branches close around each ring.
    // Queue indexing avoids repeated shift(), including on high-degree stars.
    for (const root of ranked) {
      if (visited.has(root.gid)) continue;
      const queue = [root.gid];
      visited.add(root.gid);
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const gid = queue[cursor];
        ordered.push(byGid.get(gid)!);
        for (const neighbor of orderedAdjacent.get(gid)!) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    const positions = new Map<string, { x: number; y: number }>();
    positions.set(ordered[0].gid, { x: 0, y: 0 });
    let cursor = 1;
    let radius = 0;
    for (let ring = 1; cursor < ordered.length; ring += 1) {
      radius = ring * RING_SPACING;
      const capacity = Math.floor((2 * Math.PI * radius) / NODE_SPACING);
      const count = Math.min(capacity, ordered.length - cursor);
      const phase = -Math.PI / 2 + (ring % 2 ? 0 : Math.PI / capacity);
      for (let index = 0; index < count; index += 1) {
        const angle = phase + (index / count) * 2 * Math.PI;
        positions.set(ordered[cursor + index].gid, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
      }
      cursor += count;
    }
    return { clusterId, nodes: ordered, positions, radius: Math.max(radius, 30) };
  }).sort((a, b) => b.radius - a.radius || a.clusterId - b.clusterId);

  // Shelf packing of disjoint cluster discs is O(C log C); no force simulation.
  const area = clusters.reduce((sum, cluster) => sum + (cluster.radius * 2 + CLUSTER_GAP) ** 2, 0);
  const targetWidth = Math.max(clusters[0]?.radius * 2 + CLUSTER_GAP || 0, Math.sqrt(area) * 1.45);
  const elements: ElementDefinition[] = [];
  let originX = 0;
  let originY = 0;
  let rowHeight = 0;
  for (const cluster of clusters) {
    const diameter = cluster.radius * 2 + CLUSTER_GAP;
    if (originX > 0 && originX + diameter > targetWidth) {
      originX = 0;
      originY += rowHeight;
      rowHeight = 0;
    }
    const center = { x: originX + diameter / 2, y: originY + diameter / 2 };
    const parentId = `cluster:${cluster.clusterId}`;
    elements.push({
      data: { id: parentId, clusterId: cluster.clusterId, label: `Кластер ${cluster.clusterId} · ${cluster.nodes.length}`, nNodes: cluster.nodes.length },
      classes: "cluster", selectable: false, grabbable: false,
    });
    for (const node of cluster.nodes) {
      const local = cluster.positions.get(node.gid)!;
      elements.push({
        data: {
          id: node.gid, gid: node.gid, parent: parentId, clusterId: cluster.clusterId,
          role: node.role, size: 20 + node.priority_score * 8,
          label: `${node.gid}\n${ROLES_PRESENTATION[node.role].label} · К${cluster.clusterId}`,
        },
        position: { x: center.x + local.x, y: center.y + local.y },
        classes: node.is_seed ? "client seed" : "client", grabbable: false,
      });
    }
    originX += diameter;
    rowHeight = Math.max(rowHeight, diameter);
  }
  result.edges.forEach((edge, index) => {
    const crossCluster = byGid.get(edge.src)?.cluster_id !== byGid.get(edge.dst)?.cluster_id;
    elements.push({
      data: { id: `edge:${index}`, source: edge.src, target: edge.dst },
      classes: crossCluster ? "cross-cluster" : "local-edge",
    });
  });
  return elements;
}
