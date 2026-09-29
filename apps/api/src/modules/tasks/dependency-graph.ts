// Gap 8: reject dependencies that would form a cycle (A → B → … → A).
// Edges read "task depends on dependsOn". Adding task → dependsOn closes a cycle
// exactly when `task` is already reachable from `dependsOn`.

export interface Edge {
  taskId: string;
  dependsOnTaskId: string;
}

// Returns the cycle as a list of task ids starting and ending at `taskId`
// (e.g. [A, B, C, A]), or null when the new edge is safe.
export function findCycle(edges: Edge[], taskId: string, dependsOnTaskId: string): string[] | null {
  if (taskId === dependsOnTaskId) return [taskId, taskId];

  const next = new Map<string, string[]>();
  for (const e of edges) {
    const list = next.get(e.taskId);
    if (list) list.push(e.dependsOnTaskId);
    else next.set(e.taskId, [e.dependsOnTaskId]);
  }

  // Iterative DFS from dependsOn, remembering how each node was reached.
  const parent = new Map<string, string | null>([[dependsOnTaskId, null]]);
  const stack = [dependsOnTaskId];
  while (stack.length) {
    const node = stack.pop()!;
    if (node === taskId) {
      const path: string[] = [];
      for (let cur: string | null = node; cur !== null; cur = parent.get(cur) ?? null) path.unshift(cur);
      return [taskId, ...path];
    }
    for (const n of next.get(node) ?? []) {
      if (!parent.has(n)) {
        parent.set(n, node);
        stack.push(n);
      }
    }
  }
  return null;
}

// Parent/sub-task hierarchy: making `parentId` the parent of `taskId` is a cycle
// if `taskId` is `parentId` or one of its ancestors.
export function createsParentCycle(taskId: string, parentId: string, parentOf: (id: string) => string | null | undefined): boolean {
  const seen = new Set<string>();
  for (let cur: string | null | undefined = parentId; cur; cur = parentOf(cur)) {
    if (cur === taskId) return true;
    if (seen.has(cur)) return true; // pre-existing corruption; refuse rather than loop
    seen.add(cur);
  }
  return false;
}
