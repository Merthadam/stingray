import { clusterNodes, type MapNode, type MapRange, type MapTile } from './repo-map-model';
export type Rect = { x: number; y: number; width: number; height: number };
export type LayoutTile = MapTile & Rect & { parent: string; depth: number; terminal: boolean; folder: string };
// Ordered squarification: no sorting by transient Git state or count. Preserve
// sibling name order, accepting imperfect aspect ratios as weights change.
export function squarify(weights: number[], bounds: Rect): Rect[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum || !weights.length) return [];
  const areas = weights.map(w => w / sum * bounds.width * bounds.height);
  const result: Rect[] = [];
  let { x, y, width, height } = bounds;
  let at = 0;
  const worst = (total: number, min: number, max: number, side: number) => total && side && min ? Math.max(side * side * max / (total * total), total * total / (side * side * min)) : Infinity;
  while (at < areas.length) {
    const first = at; let total = areas[at]; let min = total; let max = total;
    const side = Math.min(width, height);
    let score = worst(total, min, max, side); at++;
    while (at < areas.length) {
      const next = worst(total + areas[at], Math.min(min, areas[at]), Math.max(max, areas[at]), side);
      if (next > score) break;
      total += areas[at]; min = Math.min(min, areas[at]); max = Math.max(max, areas[at]); score = next; at++;
    }
    const vertical = width >= height;
    const thickness = Math.min(vertical ? width : height, total / Math.max(side, Number.EPSILON));
    let cursor = vertical ? y : x;
    for (let i = first; i < at; i++) {
      const length = i === at - 1 ? Math.max(0, (vertical ? y + height : x + width) - cursor) : areas[i] / Math.max(thickness, Number.EPSILON);
      result.push(vertical ? { x, y: cursor, width: thickness, height: length } : { x: cursor, y, width: length, height: thickness });
      cursor += length;
    }
    if (vertical) { x += thickness; width = Math.max(0, width - thickness); }
    else { y += thickness; height = Math.max(0, height - thickness); }
  }
  return result;
}
export function treemap(nodes: MapNode[], width: number, height: number, folder = '', budget = 2000): LayoutTile[] {
  if (width <= 0 || height <= 0 || !nodes.length) return [];
  const result: LayoutTile[] = [];
  const stack = [{ nodes, bounds: { x: 3, y: 3, width: Math.max(0, width - 6), height: Math.max(0, height - 6) }, folder, parent: '', depth: 0, budget: Math.max(2, Math.min(2000, budget)) }];
  while (stack.length) {
    const task = stack.pop()!;
    const capacity = Math.max(2, Math.min(task.budget, Math.floor(task.bounds.width * task.bounds.height / 100)));
    const tiles = clusterNodes(task.nodes, capacity);
    const rectangles = squarify(tiles.map(tile => tile.totals.weight), task.bounds);
    let remaining = task.budget - tiles.length;
    let descendants = tiles.reduce((n, tile) => n + (!tile.node?.file && tile.node ? tile.node.total : 0), 0);
    tiles.forEach((tile, i) => {
      const rect = rectangles[i];
      const gap = Math.min(1.5, rect.width / 5, rect.height / 5);
      const bounds = { x: rect.x + gap, y: rect.y + gap, width: Math.max(0, rect.width - gap * 2), height: Math.max(0, rect.height - gap * 2) };
      const item: LayoutTile = { ...tile, ...bounds, parent: task.parent, depth: task.depth, terminal: true, folder: task.folder };
      result.push(item);
      if (tile.node && !tile.node.file) {
        const allowance = Math.floor(remaining * tile.node.total / Math.max(1, descendants));
        descendants -= tile.node.total;
        if (allowance >= 2 && bounds.width > 44 && bounds.height > 48) {
          remaining -= allowance; item.terminal = false;
          stack.push({ nodes: tile.node.children, bounds: { x: bounds.x + 3, y: bounds.y + 21, width: bounds.width - 6, height: bounds.height - 24 }, folder: tile.node.path, parent: tile.id, depth: task.depth + 1, budget: allowance });
        }
      }
    });
  }
  return result;
}
export type MapScope = { folder: string; range?: MapRange; file?: string };
