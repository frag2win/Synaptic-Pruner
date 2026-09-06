import { ExecutionNode } from "../types/graph";

export type LiteralRole = 
    | "Input_Parameter"
    | "Local_Artifact"
    | "Domain_Constant"
    | "Output_Resource";

export interface ClassifiedResource {
    value: string;
    role: LiteralRole;
    replacement?: string;
    evidence: {
        source: "token" | "resource" | "path_abstraction";
        nodes: string[];
        reason: string;
    };
    // Internal property for sorting
    _firstIndex?: number;
}

const DOMAIN_CONSTANTS = {
    filenames: new Set(["package.json", "package-lock.json", "tsconfig.json", "Dockerfile", ".gitignore", "node_modules"]),
    protocols: new Set(["http://", "https://", "application/json"]),
    commands: {
        npm: new Set(["install", "init", "test", "run", "add"]),
        git: new Set(["add", "commit", "status", "checkout", "clone", "push", "pull"]),
        yarn: new Set(["add", "install", "test", "run"])
    } as Record<string, Set<string>>
};

export function classifyResources(nodes: ExecutionNode[]): ClassifiedResource[] {
    const results = new Map<string, ClassifiedResource>();
    
    // 1. Token Analysis (Semantics)
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const tokens = node.command.split(/\s+/);
        const baseCmd = tokens[0];
        
        for (const token of tokens) {
            if (results.has(token)) continue;
            
            let classified: ClassifiedResource | null = null;
            
            // Flags
            if (token.startsWith("-") && token !== "-") {
                classified = {
                    value: token,
                    role: "Domain_Constant",
                    evidence: { source: "token", nodes: [node.id], reason: "CLI flag" }
                };
            }
            // Protocols
            else if (DOMAIN_CONSTANTS.protocols.has(token) || token.startsWith("http://") || token.startsWith("https://")) {
                classified = {
                    value: token,
                    role: "Domain_Constant",
                    evidence: { source: "token", nodes: [node.id], reason: "Protocol constant" }
                };
            }
            // Command semantics
            else if (DOMAIN_CONSTANTS.commands[baseCmd]?.has(token)) {
                classified = {
                    value: token,
                    role: "Domain_Constant",
                    evidence: { source: "token", nodes: [node.id], reason: `Semantic subcommand of ${baseCmd}` }
                };
            }
            
            if (classified) {
                classified._firstIndex = i;
                results.set(token, classified);
            }
        }
    }

    // 2. Resource Lifecycle Analysis
    interface ResourceState {
        firstReadIndex: number;
        firstWriteIndex: number;
        lastWriteIndex: number;
        lastReadIndex: number;
        lastDeleteIndex: number;
        
        firstNode: string;
        allNodes: Set<string>;
    }
    
    const state = new Map<string, ResourceState>();
    const rootCwd = nodes[0]?.cwd ?? null;
    const isEcosystemNode = nodes.some(n => n.command.startsWith("npm ") || n.command.startsWith("node ") || n.command.startsWith("yarn "));
    
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        
        const processResource = (r: string, action: "read" | "write" | "delete") => {
            if (!state.has(r)) {
                state.set(r, {
                    firstReadIndex: Infinity,
                    firstWriteIndex: Infinity,
                    lastWriteIndex: -1,
                    lastReadIndex: -1,
                    lastDeleteIndex: -1,
                    firstNode: node.id,
                    allNodes: new Set()
                });
            }
            const s = state.get(r)!;
            s.allNodes.add(node.id);
            
            if (action === "read") {
                if (i < s.firstReadIndex) s.firstReadIndex = i;
                if (i > s.lastReadIndex) s.lastReadIndex = i;
            } else if (action === "write") {
                if (i < s.firstWriteIndex) s.firstWriteIndex = i;
                if (i > s.lastWriteIndex) s.lastWriteIndex = i;
            } else if (action === "delete") {
                if (i > s.lastDeleteIndex) s.lastDeleteIndex = i;
            }
        };

        for (const r of node.reads) processResource(r, "read");
        for (const r of node.writes) processResource(r, "write");
        for (const r of node.deletes) processResource(r, "delete");
    }
    
    // Deterministic Counters
    let inputFileIdx = 1;
    let localTmpIdx = 1;
    let outputResIdx = 1;
    
    const resourceKeys = Array.from(state.keys());
    
    for (const r of resourceKeys) {
        if (results.has(r)) continue; 
        
        const s = state.get(r)!;
        const firstAppearance = Math.min(s.firstReadIndex, s.firstWriteIndex, s.lastDeleteIndex !== -1 ? s.lastDeleteIndex : Infinity);
        
        // Is it a Domain Constant by filename?
        const cleanResource = r.startsWith("CWD:") ? r.slice(4) : r;
        const basename = cleanResource.split("/").pop() || cleanResource.split("\\").pop();
        if (isEcosystemNode && basename && DOMAIN_CONSTANTS.filenames.has(basename)) {
            results.set(r, {
                value: r,
                role: "Domain_Constant",
                evidence: {
                    source: "resource",
                    nodes: Array.from(s.allNodes),
                    reason: `Registered invariant filename (${basename})`
                },
                _firstIndex: firstAppearance
            });
            continue;
        }

        // Determine Lifecycle Role
        let role: LiteralRole;
        let reason = "";
        
        if (s.firstReadIndex <= s.firstWriteIndex && s.firstReadIndex !== Infinity) {
            role = "Input_Parameter";
            reason = `External dependency read by ${s.firstNode} before creation`;
        } else if (s.lastDeleteIndex > s.lastWriteIndex) {
            role = "Local_Artifact";
            reason = "Transient artifact explicitly deleted";
        } else if (s.lastReadIndex > s.lastWriteIndex) {
            role = "Local_Artifact";
            reason = "Internal state consumed within DAG";
        } else if (s.lastWriteIndex >= s.lastDeleteIndex && s.lastWriteIndex !== -1) {
            role = "Output_Resource";
            reason = "Terminal write surviving trace closure";
        } else {
            // Fallback (e.g. only deleted)
            role = "Local_Artifact";
            reason = "Transient artifact";
        }
        
        // Deterministic Abstraction
        let replacement = "";
        const cleanPath = r.startsWith("CWD:") ? r.slice(4) : r;
        const rootPath = rootCwd;
        
        // Safe root containment matching exact root or subdirectories using POSIX/Win slash
        const isUnderRoot = rootPath && (cleanPath === rootPath || cleanPath.startsWith(rootPath + "/") || cleanPath.startsWith(rootPath + "\\"));
        
        if (role === "Input_Parameter") {
            if (isUnderRoot) {
                if (cleanPath === rootPath) {
                    replacement = "{{inputs.target_dir}}";
                } else {
                    const suffix = cleanPath.slice(rootPath!.length);
                    const sep = suffix.startsWith("/") || suffix.startsWith("\\") ? "" : "/";
                    replacement = `{{inputs.target_dir}}${sep}${suffix}`;
                }
            } else {
                replacement = `{{inputs.file_${inputFileIdx++}}}`;
            }
        } else if (role === "Local_Artifact") {
            replacement = `{{local.tmp_${localTmpIdx++}}}`;
        } else if (role === "Output_Resource") {
            replacement = `{{outputs.result_${outputResIdx++}}}`;
        }
        
        results.set(r, {
            value: r,
            role,
            replacement: r.startsWith("CWD:") && replacement ? `CWD:${replacement}` : replacement,
            evidence: {
                source: isUnderRoot && role === "Input_Parameter" ? "path_abstraction" : "resource",
                nodes: Array.from(s.allNodes),
                reason
            },
            _firstIndex: firstAppearance
        });
        
        if (r.startsWith("CWD:") && !results.has(cleanPath)) {
            results.set(cleanPath, {
                value: cleanPath,
                role,
                replacement,
                evidence: {
                    source: isUnderRoot && role === "Input_Parameter" ? "path_abstraction" : "resource",
                    nodes: Array.from(s.allNodes),
                    reason: reason + " (Extracted from CWD)"
                },
                _firstIndex: firstAppearance
            });
        }
    }
    
    // Sort deterministically by trace appearance, then strip internal fields
    const sorted = Array.from(results.values()).sort((a, b) => {
        const idxA = a._firstIndex ?? Infinity;
        const idxB = b._firstIndex ?? Infinity;
        if (idxA !== idxB) return idxA - idxB;
        return a.value.localeCompare(b.value);
    });
    
    for (const r of sorted) {
        delete r._firstIndex;
    }
    
    return sorted;
}
