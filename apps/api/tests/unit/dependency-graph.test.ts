import { createsParentCycle, findCycle } from '../../src/modules/tasks/dependency-graph';

const e = (taskId: string, dependsOnTaskId: string) => ({ taskId, dependsOnTaskId });

describe('findCycle', () => {
  it('allows edges that keep the graph acyclic', () => {
    const edges = [e('A', 'B'), e('B', 'C'), e('D', 'C')];
    expect(findCycle(edges, 'A', 'C')).toBeNull(); // shortcut, not a cycle
    expect(findCycle(edges, 'D', 'B')).toBeNull();
  });

  it('rejects self-dependency', () => {
    expect(findCycle([], 'A', 'A')).toEqual(['A', 'A']);
  });

  it('detects a direct cycle', () => {
    expect(findCycle([e('B', 'A')], 'A', 'B')).toEqual(['A', 'B', 'A']);
  });

  it('reports the full chain of a longer cycle', () => {
    const edges = [e('B', 'C'), e('C', 'D'), e('D', 'A'), e('B', 'X')];
    expect(findCycle(edges, 'A', 'B')).toEqual(['A', 'B', 'C', 'D', 'A']);
  });

  it('terminates on graphs with diamonds', () => {
    const edges = [e('B', 'C'), e('B', 'D'), e('C', 'E'), e('D', 'E')];
    expect(findCycle(edges, 'A', 'B')).toBeNull();
    expect(findCycle(edges, 'E', 'B')).toEqual(['E', 'B', expect.any(String), 'E']);
  });
});

describe('createsParentCycle', () => {
  const parents: Record<string, string | null> = { child: 'parent', grandchild: 'child', parent: null };
  const parentOf = (id: string) => parents[id];

  it('rejects nesting a task under itself or its descendants', () => {
    expect(createsParentCycle('parent', 'parent', parentOf)).toBe(true);
    expect(createsParentCycle('parent', 'grandchild', parentOf)).toBe(true);
  });

  it('allows unrelated nesting', () => {
    expect(createsParentCycle('other', 'grandchild', parentOf)).toBe(false);
  });
});
