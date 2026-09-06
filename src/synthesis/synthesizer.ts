import { ExecutionNode } from "../types/graph";
import { ClassifiedResource } from "./classifier";
import { PlayIR } from "../types/playIR";
import { validatePlayIR } from "../compiler/validator";
import * as yaml from "js-yaml";

export interface SynthesizerProvider {
    /**
     * Accepts a formatted prompt and returns a raw YAML string matching PlayIR schema.
     */
    generatePlayIR(prompt: string): Promise<string>;
}

export class Synthesizer {
    constructor(private provider: SynthesizerProvider) {}
    
    async synthesize(nodes: ExecutionNode[], classifications: ClassifiedResource[]): Promise<PlayIR> {
        // Group classifications for the strict contract prompt
        const inputs = classifications.filter(c => c.role === "Input_Parameter").map(c => c.replacement).filter(Boolean);
        const locals = classifications.filter(c => c.role === "Local_Artifact").map(c => c.replacement).filter(Boolean);
        const outputs = classifications.filter(c => c.role === "Output_Resource").map(c => c.replacement).filter(Boolean);
        const constants = classifications.filter(c => c.role === "Domain_Constant").map(c => c.value);

        const prompt = `
You are a constrained compiler backend translating a deterministic execution trace into a Play IR YAML document.
Your job is to act as a lossy-free translator. Do not invent, guess, or reinterpret the trace.

## Semantic Constraints (STRICTLY ENFORCED)
1. NO INVENTED RESOURCES: You may ONLY use the following template variables:
   - Inputs (allowed in \`inputs\` block and actions): ${inputs.join(", ") || "None"}
   - Locals (allowed ONLY in actions): ${locals.join(", ") || "None"}
   - Outputs (allowed ONLY in actions and postconditions): ${outputs.join(", ") || "None"}
2. CONSTANT PRESERVATION: The following domain constants must remain exactly as concrete strings. DO NOT parameterize them:
   - Constants: ${constants.join(", ") || "None"}
3. CAUSAL ACTION PROVENANCE: Every action you generate MUST include a \`provenance\` block identifying exactly which source nodes it represents.
   - Example:
     provenance:
       sourceNodeIds: ["node_1"]
   - Every required node in the Causal Trace below must map to exactly one provenance path.
   - Do NOT drop nodes. Do NOT invent actions that have no source nodes.
   - Do NOT inject new dependencies (e.g. do not invent \`apt install\` or \`pip install\`).
4. NO FABRICATED GUARANTEES: You may NOT invent semantic guarantees.
   - Preconditions may ONLY assert existence/type of Input Parameters.
   - Postconditions may ONLY assert existence/type of Output Resources.

## Causal Trace (To Translate)
${JSON.stringify(nodes.map(n => ({
            id: n.id,
            command: n.command,
            cwd: n.cwd
        })), null, 2)}

## Resource Classifications
${JSON.stringify(classifications.map(c => ({
            value: c.value,
            role: c.role,
            replacement: c.replacement
        })), null, 2)}

Ensure the output is exclusively valid YAML matching the Play IR schema.
`;

        const yamlString = await this.provider.generatePlayIR(prompt);
        let parsed;
        try {
            parsed = yaml.load(yamlString);
        } catch (e: any) {
            throw new Error(`Failed to parse PlayIR YAML: ${e.message}`);
        }
        
        // Pass classifications and nodes to the enhanced validator
        return validatePlayIR(parsed, nodes, classifications);
    }
}
