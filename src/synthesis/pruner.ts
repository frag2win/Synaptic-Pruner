import { ExecutionNode } from "../types/graph";

export function pruneDag(nodes: ExecutionNode[], explicitAnchors?: string[]): ExecutionNode[] {
    if (nodes.length === 0) return [];

    const nodesById = new Map(nodes.map(n => [n.id, n]));

    // 1. Determine anchors
    const anchors = [...(explicitAnchors ?? [])];

    // Validate explicit anchors
    for (const anchor of anchors) {
        if (!nodesById.has(anchor)) {
            throw new Error(`Unknown anchor: ${anchor}`);
        }
    }

    if (anchors.length === 0) {
        // Default to the last successful command
        const lastSuccess = [...nodes].reverse().find(n => n.exitCode === 0);
        if (lastSuccess) {
            anchors.push(lastSuccess.id);
        }
    }

    // 2. Backward Causal Traversal
    const retained = new Set<string>();
    const stack = [...anchors];

    while (stack.length > 0) {
        const id = stack.pop()!;
        if (retained.has(id)) continue;
        
        retained.add(id);
        
        const node = nodesById.get(id);
        if (!node) continue;

        // Traverse all causal dependencies (data, directory, ordering, etc.)
        for (const parentId of node.parentIds) {
            stack.push(parentId);
        }
    }

    // 3. Mathematical Closure Filter
    // Note: We maintain the original execution order by filtering the original array
    return nodes.filter(node => retained.has(node.id));
}
