import { describe, it, expect } from "vitest";
import { parseTrace } from "../../src/ingestion/traceParser";
import { buildDag } from "../../src/synthesis/dagBuilder";
import { pruneDag } from "../../src/synthesis/pruner";
import { classifyResources } from "../../src/synthesis/classifier";
import { Synthesizer, SynthesizerProvider } from "../../src/synthesis/synthesizer";
import { exportToRote } from "../../src/compiler/roteExporter";
import { ReplayVerifier } from "../../src/verifier/replayVerifier";
import { generateFuzzInputs } from "../../src/verifier/fuzzer";

class MockProvider implements SynthesizerProvider {
    async generatePlayIR(prompt: string): Promise<string> {
        const nodesMatch = prompt.match(/## Causal Trace \(To Translate\)\n([\s\S]*?)\n## Resource Classifications/);
        let nodeIds: string[] = ["node_1"];
        if (nodesMatch) {
            try {
                const nodes = JSON.parse(nodesMatch[1]);
                if (nodes.length > 0) nodeIds = nodes.map((n: any) => n.id);
            } catch(e) {}
        }
        
        let expectedInputs: string[] = [];
        const classMatch = prompt.match(/## Resource Classifications[\s\S]*?(\[[\s\S]*\])/);
        if (classMatch) {
            try {
                const classes = JSON.parse(classMatch[1]);
                for (const c of classes) {
                    if (c.role === "Input_Parameter" && c.replacement) {
                        const m = c.replacement.match(/\{\{inputs\.([^}]+)\}\}/);
                        if (m && !expectedInputs.includes(m[1])) {
                            expectedInputs.push(m[1]);
                        }
                    }
                }
            } catch(e) {}
        }
        
        const inputsStr = expectedInputs.length > 0 
            ? "inputs:\n" + expectedInputs.map(k => `  ${k}:\n    type: "string"`).join("\n") 
            : "";
            
        return `
schema_version: "1.0.0"
operation_id: "test_op"
metadata:
  description: "Mocked play"
  author: "test"
  deterministic: true
${inputsStr}
actions:
  - id: "step_1"
    runtime: "fs"
    action: "make_directory"
    target: "data"
    provenance:
      sourceNodeIds: ${JSON.stringify(nodeIds)}
`;
    }
}

describe("E2E Pipeline Integration", () => {
    it("should process a full trace to an executable artifact successfully", async () => {
        // 1. Ingestion
        const raw = `
user@host:~/test$ ls
user@host:~/test$ mkdir data
        `;
        const events = parseTrace(raw.trim());
        
        // 2. Synthesis
        const dag = buildDag(events);
        const pruned = pruneDag(dag);
        expect(pruned.length).toBe(1);
        expect(pruned[0].command).toBe("mkdir data");
        
        // 3. Classification
        const classifications = classifyResources(pruned);
        
        // 4. Synthesizer
        const synthesizer = new Synthesizer(new MockProvider());
        const playIR = await synthesizer.synthesize(pruned, classifications);
        expect(playIR.actions[0].action).toBe("make_directory");
        
        // 5. Verifier & Fuzzer
        const inputKey = Object.keys(playIR.inputs || {})[0] || "file_1";
        const inputs = generateFuzzInputs({ [inputKey]: "test_dir" });
        expect(inputs.length).toBe(3); // base, nested, negative
        
        const verifier = new ReplayVerifier();
        const report = await verifier.verify(playIR, { [inputKey]: "test_dir" });
        expect(report.success).toBe(true);
        expect(report.invariants.R1).toBe(true);
        expect(report.invariants.R8).toBe(true);
        expect(report.invariants.R9a).toBe(true);
        
        // 6. Compiler
        const roteScript = exportToRote(playIR);
        expect(roteScript).toContain('export default {');
        expect(roteScript).toContain('test-op');
        expect(roteScript).toContain('make_directory');
    });
});
