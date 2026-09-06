import { PlayIRSchema, PlayIR } from "../types/playIR";
import { ExecutionNode } from "../types/graph";
import { ClassifiedResource } from "../synthesis/classifier";

export function validatePlayIR(data: unknown, nodes: ExecutionNode[], classifications: ClassifiedResource[]): PlayIR {
    // S1 - Schema validity
    const result = PlayIRSchema.safeParse(data);
    if (!result.success) {
        throw new Error(`Schema validation failed: ${result.error.message}`);
    }
    const play = result.data;
    
    // Setup maps
    const replacementToRole = new Map<string, string>();
    const nodeConstants = new Map<string, string[]>();
    const expectedInputs = new Set<string>();
    
    // For S6 Action Fidelity (Resources)
    const nodeReplacements = new Map<string, Set<string>>();

    for (const n of nodes) {
        nodeReplacements.set(n.id, new Set());
    }

    // Extractor
    const extractTemplates = (str: string) => {
        const matches = str.match(/{{[^}]+}}/g);
        return matches ? matches : [];
    };

    for (const c of classifications) {
        if (c.role === "Domain_Constant") {
            for (const n of c.evidence.nodes) {
                if (!nodeConstants.has(n)) nodeConstants.set(n, []);
                nodeConstants.get(n)!.push(c.value);
            }
        } else if (c.replacement) {
            replacementToRole.set(c.replacement, c.role);
            
            // Also map the bare template without CWD: prefix to role for easier lookup
            const tmpls = extractTemplates(c.replacement);
            for (const t of tmpls) {
                replacementToRole.set(t, c.role);
                if (c.role === "Input_Parameter") {
                    const key = t.replace(/^\{\{inputs\./, "").replace(/\}\}$/, "");
                    expectedInputs.add(key);
                }
            }
            
            // Track which nodes are allowed to use this replacement, and track the original classified values
            const cleanVal = c.value.replace(/^CWD:/, "");
            const baseVal = cleanVal.split("/").pop() || cleanVal.split("\\").pop() || cleanVal;

            for (const n of c.evidence.nodes) {
                if (nodeReplacements.has(n)) {
                    nodeReplacements.get(n)!.add(c.replacement);
                    nodeReplacements.get(n)!.add(cleanVal);
                    nodeReplacements.get(n)!.add(baseVal);
                    for (const t of tmpls) {
                        nodeReplacements.get(n)!.add(t);
                    }
                }
            }
        }
    }
    
    const extractFromObject = (obj: any): string[] => {
        let tmpls: string[] = [];
        if (typeof obj === 'string') {
            tmpls.push(...extractTemplates(obj));
        } else if (Array.isArray(obj)) {
            obj.forEach(v => tmpls.push(...extractFromObject(v)));
        } else if (obj !== null && typeof obj === 'object') {
            for (const key of Object.values(obj)) {
                tmpls.push(...extractFromObject(key));
            }
        }
        return tmpls;
    };
    
    const allTemplates = new Set(extractFromObject(play));
    
    // S3 - Resource validity (No Invented Resources)
    for (const t of allTemplates) {
        if (!replacementToRole.has(t)) {
            throw new Error(`Invariant Violation: PlayIR contains invented template variable '${t}' not present in classifications.`);
        }
    }
    
    // S2 - Namespace validity & Missing Inputs
    const actualInputs = new Set(Object.keys(play.inputs ?? {}));
    
    for (const expected of expectedInputs) {
        if (!actualInputs.has(expected)) {
            throw new Error(`Invariant Violation: Missing required Input_Parameter '${expected}' in PlayIR.inputs.`);
        }
    }
    
    for (const actual of actualInputs) {
        const expectedTemplate = `{{inputs.${actual}}}`;
        const role = replacementToRole.get(expectedTemplate);
        if (role !== "Input_Parameter") {
            throw new Error(`Invariant Violation: Input block contains '${actual}' which maps to role '${role || "Unknown"}', must be Input_Parameter.`);
        }
    }

    // S5 - Provenance bijection (Pre-check counts: Exactly 1:1)
    const requiredNodeIds = new Set(nodes.map(n => n.id));
    const provenanceCounts = new Map<string, number>();
    const nodeById = new Map(nodes.map(n => [n.id, n]));

    for (const action of play.actions) {
        const prov = action.provenance?.sourceNodeIds;
        
        if (!prov || prov.length === 0) {
            throw new Error(`Invariant Violation: Action '${action.id}' has no provenance.`);
        }
        
        if (prov.length !== 1) {
            throw new Error(`Invariant Violation: Action '${action.id}' has ${prov.length} provenance nodes. Expected strictly 1:1 mapping for v1.1.2.`);
        }
        
        const pid = prov[0];
        if (!requiredNodeIds.has(pid)) {
            throw new Error(`Invariant Violation: Action '${action.id}' claims provenance for unknown node '${pid}'.`);
        }
        
        provenanceCounts.set(pid, (provenanceCounts.get(pid) ?? 0) + 1);
    }

    // S5 verification of counts
    for (const req of requiredNodeIds) {
        const count = provenanceCounts.get(req) ?? 0;
        if (count !== 1) {
            throw new Error(`Invariant Violation: Source node '${req}' is represented ${count} times; expected exactly once.`);
        }
    }

    // Per-Action Invariants (S4 Constants, S6 Fidelity)
    for (const action of play.actions) {
        const pid = action.provenance!.sourceNodeIds[0];
        const actionStr = [action.command, action.action, action.target].filter(Boolean).join(" ");
        
        // S4 - Constant preservation
        const expectedConstants = nodeConstants.get(pid);
        if (expectedConstants && action.runtime === "shell") {
            for (const ec of expectedConstants) {
                if (!actionStr.includes(ec)) {
                    throw new Error(`Invariant Violation: Action '${action.id}' (provenance: ${pid}) is missing required domain constant '${ec}'.`);
                }
            }
        }
        
        // S6 - Resource template fidelity
        const actionTemplates = extractFromObject(action);
        const allowedTemplatesForNode = nodeReplacements.get(pid)!;
        for (const t of actionTemplates) {
            if (!allowedTemplatesForNode.has(t)) {
                throw new Error(`Invariant Violation: Action '${action.id}' uses resource '${t}' which is not authorized for provenance node '${pid}'.`);
            }
        }

        // Check concrete target if present
        if (action.target && !action.target.startsWith("{{")) {
            const cleanTarget = action.target.replace(/^CWD:/, "");
            const baseTarget = cleanTarget.split("/").pop() || cleanTarget.split("\\").pop() || cleanTarget;
            const isAuthorized = allowedTemplatesForNode.has(action.target) ||
                                 allowedTemplatesForNode.has(cleanTarget) ||
                                 allowedTemplatesForNode.has(baseTarget);
            if (!isAuthorized) {
                throw new Error(`Invariant Violation: Action '${action.id}' targets unauthorized resource '${action.target}' for provenance node '${pid}'.`);
            }
        }

        // S6 - Base command check & Token fidelity
        const sourceNode = nodeById.get(pid)!;
        const sourceBaseCommand = sourceNode.command.trim().split(/\s+/)[0];
        
        if (action.runtime === "shell" && action.command) {
            const actionBaseCommand = action.command.trim().split(/\s+/)[0];
            if (actionBaseCommand !== sourceBaseCommand) {
                throw new Error(`Invariant Violation: Action '${action.id}' base command '${actionBaseCommand}' does not match source '${sourceBaseCommand}'.`);
            }

            // S6: Verify that unabstracted source tokens are preserved
            const sourceTokens = sourceNode.command.trim().split(/\s+/);
            for (const tok of sourceTokens) {
                // If token represents a resource that was abstracted into an authorized template, it can be replaced
                const isAbstracted = Array.from(allowedTemplatesForNode).some(t => {
                    const cleanT = t.replace(/^CWD:/, "");
                    return cleanT.includes(tok) || tok.includes(cleanT);
                });

                if (!isAbstracted && !action.command.includes(tok)) {
                    throw new Error(`Invariant Violation: Action '${action.id}' (provenance: ${pid}) omitted or altered literal token '${tok}'.`);
                }
            }

            // S6: Detect unauthorized literal token substitutions
            const actionTokens = action.command.trim().split(/\s+/);
            for (const actTok of actionTokens) {
                if (actTok.includes("{{")) continue;
                if (sourceTokens.includes(actTok)) continue;
                if (expectedConstants?.includes(actTok)) continue;
                if (allowedTemplatesForNode.has(actTok) || allowedTemplatesForNode.has(actTok.replace(/^CWD:/, ""))) continue;

                throw new Error(`Invariant Violation: Action '${action.id}' (provenance: ${pid}) omitted or altered literal token '${actTok}' (unauthorized substitution).`);
            }
        }
    }
    
    // No Fabricated Semantic Guarantees (S1/S2/S3 extension)
    if (play.preconditions) {
        for (const pre of play.preconditions) {
            if (!pre.target.startsWith("{{") || !pre.target.endsWith("}}")) {
                throw new Error(`Invariant Violation: Precondition target '${pre.target}' is fabricated. It must be an exact template variable.`);
            }
            
            const role = replacementToRole.get(pre.target);
            if (role !== "Input_Parameter" && role !== "Domain_Constant") {
                throw new Error(`Invariant Violation: Precondition targets unauthorized variable '${pre.target}'. Only Input_Parameter or Domain_Constant allowed.`);
            }
            if (!["exists", "is_directory", "is_file", "has_version"].includes(pre.assertion)) {
                throw new Error(`Invariant Violation: Fabricated semantic guarantee '${pre.assertion}' in preconditions.`);
            }
        }
    }
    
    if (play.postconditions) {
        for (const post of play.postconditions) {
            if (!post.target.startsWith("{{") || !post.target.endsWith("}}")) {
                throw new Error(`Invariant Violation: Postcondition target '${post.target}' is fabricated. It must be an exact template variable.`);
            }
            const role = replacementToRole.get(post.target);
            if (role !== "Output_Resource") {
                throw new Error(`Invariant Violation: Postcondition targets unauthorized variable '${post.target}'. Only Output_Resource allowed.`);
            }
            if (!["exists", "is_directory", "is_file"].includes(post.assertion)) {
                throw new Error(`Invariant Violation: Fabricated semantic guarantee '${post.assertion}' in postconditions.`);
            }
        }
    }
    
    return play;
}
