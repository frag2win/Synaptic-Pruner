import { ExecutionNode } from "../types/graph";

export function pruneDag(nodes: ExecutionNode[]): ExecutionNode[] {
    if (nodes.length === 0) return [];
    
    // 1. Filter out failed commands. This implicitly collapses retry loops, 
    // leaving only the final successful attempt.
    const successNodes = nodes.filter(n => n.exitCode === 0);
    
    if (successNodes.length === 0) return [];

    const readOnlyExploratory = ["ls", "pwd", "cat", "which", "whoami", "top", "htop", "echo"];
    const isExploratory = (cmd: string) => {
        const base = cmd.split(/\s+/)[0];
        return readOnlyExploratory.includes(base);
    };

    const isMutating = (n: ExecutionNode) => n.writes.length > 0;
    
    const causalNodes = new Set<string>();
    
    // 2. Identify terminal anchors: 
    // Any node that mutates state, PLUS the absolute final command in the success chain.
    const anchors = successNodes.filter(n => isMutating(n) || n.id === successNodes[successNodes.length - 1].id);
    
    for (const anchor of anchors) {
        causalNodes.add(anchor.id);
    }
    
    // 3. Backwards propagation: 
    // Trace causality up through strict data dependencies.
    let added = true;
    while(added) {
        added = false;
        for (const node of successNodes) {
            if (causalNodes.has(node.id)) continue;
            
            for (const childId of node.childIds) {
                if (causalNodes.has(childId)) {
                    const childNode = successNodes.find(n => n.id === childId);
                    if (childNode) {
                        const hasDataDep = node.writes.some(w => childNode.reads.includes(w));
                        if (hasDataDep) {
                            causalNodes.add(node.id);
                            added = true;
                        }
                    }
                }
            }
        }
    }
    
    // 4. Final filter: Keep nodes in causal path or sequence, but aggressively strip dead-end exploratory commands.
    return successNodes.filter(n => {
        // Exploratory commands are only kept if they explicitly produced data read by a causal child.
        if (isExploratory(n.command || "")) {
            const hasDataDepChild = n.childIds.some(cid => {
                if (!causalNodes.has(cid)) return false;
                const childNode = successNodes.find(c => c.id === cid);
                return childNode && n.writes.some(w => childNode.reads.includes(w));
            });
            return hasDataDepChild;
        }
        
        // Otherwise, if it was successful and wasn't purely exploratory, keep it in the play.
        return true;
    });
}
