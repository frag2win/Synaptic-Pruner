import { ExecutionNode } from "../types/graph";
import { ClassifiedLiteral } from "./classifier";
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
    
    async synthesize(nodes: ExecutionNode[], classifications: ClassifiedLiteral[]): Promise<PlayIR> {
        const prompt = `
Convert the following execution nodes and literal classifications into a valid Play IR YAML document.
Ensure it uses "actions" and "preconditions". Do NOT use shell scripts for actions; use declarative commands like "action: make_directory" where possible.

The output MUST be a valid YAML object that exactly matches this schema structure:
\`\`\`yaml
schema_version: "1.0.0"
operation_id: "example_operation"
metadata:
  description: "Description of what this play does"
  author: "synaptic-pruner"
  deterministic: true
preconditions:
  - assertion: "directory_exists"
    target: "{{inputs.cwd}}"
actions:
  - id: "step_1"
    runtime: "fs"
    action: "make_directory"
    target: "{{inputs.cwd}}/nested"
\`\`\`

Nodes:
${JSON.stringify(nodes, null, 2)}

Classifications:
${JSON.stringify(classifications, null, 2)}
`;
        
        const yamlStr = await this.provider.generatePlayIR(prompt);
        
        try {
            // Remove markdown code blocks if the LLM adds them
            const cleanYaml = yamlStr.replace(/```yaml\n?/g, '').replace(/```\n?/g, '');
            const parsed = yaml.load(cleanYaml);
            return validatePlayIR(parsed);
        } catch (error: any) {
            throw new Error(`Failed to parse or validate synthesized Play IR: ${error.message}`);
        }
    }
}
