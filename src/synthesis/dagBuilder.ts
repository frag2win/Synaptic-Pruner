import { TraceEvent } from "../types/trace";
import { ExecutionNode } from "../types/graph";

export function buildDag(events: TraceEvent[]): ExecutionNode[] {
    const nodes: ExecutionNode[] = events.map(e => {
        const tokens = e.command.split(/\s+/).slice(1); 
        const reads: string[] = [];
        const writes: string[] = [];
        
        // Heuristics to infer read/write dependencies
        if (e.command.includes('>')) {
            const parts = e.command.split('>');
            const target = parts[parts.length - 1].trim();
            writes.push(target);
            reads.push(...parts[0].split(/\s+/).slice(1).filter(p => !p.startsWith('-')));
        } else if (e.command.startsWith('mkdir') || e.command.startsWith('touch') || e.command.startsWith('rm')) {
            writes.push(...tokens.filter(t => !t.startsWith('-')));
        } else if (e.command.startsWith('npm install') || e.command.startsWith('npm i') || e.command.startsWith('yarn add')) {
            writes.push('package.json', 'package-lock.json', 'node_modules');
        } else if (e.command.startsWith('npm init')) {
            writes.push('package.json');
        } else if (e.command.startsWith('echo')) {
            // echo without redirection writes to stdout, not filesystem
        } else {
            // Default heuristic: non-flag arguments are treated as reads
            reads.push(...tokens.filter(t => !t.startsWith('-') && !t.includes('*')));
        }

        // Merge any explicit filesystem mutations from the parser
        for (const mut of e.fsMutations || []) {
            if (mut.action === 'CREATE' || mut.action === 'MODIFY' || mut.action === 'DELETE') {
                writes.push(mut.path);
            }
        }

        return {
            id: `node_${e.id}`,
            eventId: e.id,
            kind: "command",
            command: e.command,
            exitCode: e.exitCode,
            reads: [...new Set(reads)],
            writes: [...new Set(writes)],
            parentIds: [],
            childIds: [],
            causalScore: 1
        };
    });

    // Establish edges
    for (let i = 0; i < nodes.length; i++) {
        const current = nodes[i];
        
        // Data dependency edges (look backwards for writers of our reads)
        for (let j = i - 1; j >= 0; j--) {
            const previous = nodes[j];
            const overlap = current.reads.some(r => previous.writes.includes(r));
            if (overlap) {
                current.parentIds.push(previous.id);
                previous.childIds.push(current.id);
            }
        }
        
        // Sequential fallback edge (to preserve execution order for unrelated commands)
        if (current.parentIds.length === 0 && i > 0) {
            current.parentIds.push(nodes[i - 1].id);
            nodes[i - 1].childIds.push(current.id);
        }
    }
    
    return nodes;
}
