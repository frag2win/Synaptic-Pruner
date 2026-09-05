import { TraceEvent } from "../types/trace";
import { ExecutionNode } from "../types/graph";
import * as path from "path";

type EdgeKind = "data" | "filesystem" | "directory" | "process" | "ordering";

interface DependencyEdge {
    from: string;
    to: string;
    kind: EdgeKind;
    confidence: number;
}

interface ResourceEffect {
    path: string;
    type: "read" | "write" | "delete";
    resourceKind?: "file" | "directory" | "environment";
}

/**
 * Unknown commands intentionally produce no inferred filesystem effects.
 *
 * False-positive dependencies are more dangerous than missing dependencies
 * at this stage because the structural pruner uses this graph to determine
 * what execution history is causally relevant.
 */
function normalizeResourcePath(resource: string, cwd: string): string {
    if (!resource) return resource;

    if (resource.startsWith("CWD:")) {
        const target = resource.slice(4);
        const normalized = path.posix.normalize(
            path.posix.isAbsolute(target)
                ? target
                : path.posix.resolve(cwd, target)
        );
        return `CWD:${normalized}`;
    }

    return path.posix.normalize(
        path.posix.isAbsolute(resource)
            ? resource
            : path.posix.resolve(cwd, resource)
    );
}

// Effect Extractors
type EffectExtractor = (event: TraceEvent) => ResourceEffect[];

function extractCatEffects(event: TraceEvent): ResourceEffect[] {
    if (!event.command.startsWith("cat ")) return [];
    const tokens = event.command.split(/\s+/).slice(1);
    return tokens.filter(t => !t.startsWith("-")).map(t => ({ path: t, type: "read", resourceKind: "file" }));
}

function extractMkdirEffects(event: TraceEvent): ResourceEffect[] {
    if (!event.command.startsWith("mkdir ")) return [];
    const tokens = event.command.split(/\s+/).slice(1);
    return tokens.filter(t => !t.startsWith("-")).map(t => ({ path: t, type: "write", resourceKind: "directory" }));
}

function extractTouchEffects(event: TraceEvent): ResourceEffect[] {
    if (!event.command.startsWith("touch ")) return [];
    const tokens = event.command.split(/\s+/).slice(1);
    return tokens.filter(t => !t.startsWith("-")).map(t => ({ path: t, type: "write", resourceKind: "file" }));
}

function extractRmEffects(event: TraceEvent): ResourceEffect[] {
    if (!event.command.startsWith("rm ")) return [];
    const tokens = event.command.split(/\s+/).slice(1);
    return tokens.filter(t => !t.startsWith("-") && !t.includes("*")).map(t => ({ path: t, type: "delete" }));
}

function extractRedirectEffects(event: TraceEvent): ResourceEffect[] {
    const match = event.command.match(/(?:>>|>)\s*([^\s]+)/);
    if (!match) return [];
    
    const target = match[1].trim();
    if (!target) return [];
    
    const effects: ResourceEffect[] = [{ path: target, type: "write", resourceKind: "file" }];
    
    const lhs = event.command.substring(0, match.index).trim();
    if (lhs.startsWith("cat ")) {
        const tokens = lhs.split(/\s+/).slice(1);
        effects.push(...tokens.filter(t => !t.startsWith("-")).map(t => ({ path: t, type: "read", resourceKind: "file" })));
    }
    return effects;
}

function extractCdEffects(event: TraceEvent): ResourceEffect[] {
    if (!event.command.startsWith("cd ")) return [];
    const target = event.command.substring(3).trim();
    return [{ path: `CWD:${target}`, type: "write", resourceKind: "environment" }];
}

const extractors: EffectExtractor[] = [
    extractMkdirEffects,
    extractTouchEffects,
    extractRmEffects,
    extractRedirectEffects,
    extractCatEffects,
    extractCdEffects
];

function addEdge(
    edges: DependencyEdge[],
    nodes: Map<string, ExecutionNode>,
    from: string,
    to: string,
    kind: EdgeKind,
    confidence: number
) {
    if (from === to) return;

    const duplicate = edges.some(edge => edge.from === from && edge.to === to && edge.kind === kind);
    if (duplicate) return;

    edges.push({ from, to, kind, confidence });

    nodes.get(to)?.parentIds.push(from);
    nodes.get(from)?.childIds.push(to);
}

function validateAcyclic(nodesMap: Map<string, ExecutionNode>) {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    function dfs(nodeId: string) {
        visited.add(nodeId);
        recursionStack.add(nodeId);

        const node = nodesMap.get(nodeId);
        if (node) {
            for (const childId of node.childIds) {
                if (!visited.has(childId)) {
                    dfs(childId);
                } else if (recursionStack.has(childId)) {
                    throw new Error(`Cycle detected in DAG: ${nodeId} -> ${childId}`);
                }
            }
        }
        recursionStack.delete(nodeId);
    }

    for (const nodeId of nodesMap.keys()) {
        if (!visited.has(nodeId)) {
            dfs(nodeId);
        }
    }
}

export function buildDag(events: TraceEvent[]): ExecutionNode[] {
    const lastWriter = new Map<string, string>();
    const createdDirectories = new Map<string, string>();
    const nodesMap = new Map<string, ExecutionNode>();
    const edges: DependencyEdge[] = [];

    const nodes: ExecutionNode[] = events.map(e => {
        return {
            id: `node_${e.id}`,
            eventId: e.id,
            kind: "command",
            command: e.command,
            exitCode: e.exitCode,
            reads: [],
            writes: [],
            deletes: [],
            parentIds: [],
            childIds: [],
            causalScore: 1
        };
    });

    nodes.forEach(n => nodesMap.set(n.id, n));

    for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const current = nodes[i];
        
        let effects: ResourceEffect[] = [];
        
        for (const mut of event.fsMutations || []) {
            if (mut.action === 'CREATE' || mut.action === 'MODIFY') {
                effects.push({ path: mut.path, type: 'write', resourceKind: 'file' });
            } else if (mut.action === 'DELETE') {
                effects.push({ path: mut.path, type: 'delete' });
            }
        }

        for (const extractor of extractors) {
            const ext = extractor(event);
            if (ext.length > 0) {
                effects.push(...ext);
            }
        }
        
        effects.push({ path: `CWD:${event.cwd}`, type: 'read', resourceKind: 'environment' });
        
        const normEffects = effects.map(e => ({
            path: normalizeResourcePath(e.path, event.cwd),
            type: e.type,
            resourceKind: e.resourceKind
        }));

        for (const ef of normEffects) {
            if (ef.type === "read") current.reads.push(ef.path);
            if (ef.type === "write") current.writes.push(ef.path);
            if (ef.type === "delete") current.deletes.push(ef.path);
        }
        
        current.reads = [...new Set(current.reads)];
        current.writes = [...new Set(current.writes)];
        current.deletes = [...new Set(current.deletes)];

        for (const readPath of current.reads) {
            const writer = lastWriter.get(readPath);
            if (writer) {
                if (readPath.startsWith("CWD:")) {
                    addEdge(edges, nodesMap, writer, current.id, "ordering", 1.0);
                } else {
                    addEdge(edges, nodesMap, writer, current.id, "data", 1.0);
                }
            }
        }

        for (const writePath of current.writes) {
            if (!writePath.startsWith("CWD:")) {
                const parentDir = path.posix.dirname(writePath);
                const dirCreator = createdDirectories.get(parentDir);
                if (dirCreator && dirCreator !== current.id) {
                    addEdge(edges, nodesMap, dirCreator, current.id, "directory", 0.95);
                }
            }
        }

        if (current.exitCode === 0) {
            for (const ef of normEffects) {
                if (ef.type === "write") {
                    if (ef.resourceKind === "directory") {
                        createdDirectories.set(ef.path, current.id);
                    } else {
                        // Includes CWD and file writes
                        lastWriter.set(ef.path, current.id);
                    }
                } else if (ef.type === "delete") {
                    lastWriter.delete(ef.path);
                    createdDirectories.delete(ef.path);
                    
                    // Invalidate descendants
                    for (const tracked of lastWriter.keys()) {
                        if (tracked.startsWith(ef.path + '/')) {
                            lastWriter.delete(tracked);
                        }
                    }
                    for (const tracked of createdDirectories.keys()) {
                        if (tracked.startsWith(ef.path + '/')) {
                            createdDirectories.delete(tracked);
                        }
                    }
                }
            }
        }
    }

    validateAcyclic(nodesMap);

    return nodes;
}
