import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseTrace } from "../../src/ingestion/traceParser";
import { buildDag } from "../../src/synthesis/dagBuilder";
import { pruneDag } from "../../src/synthesis/pruner";
import { classifyLiterals } from "../../src/synthesis/classifier";
import { Synthesizer, SynthesizerProvider } from "../../src/synthesis/synthesizer";
import { exportToRote } from "../../src/compiler/roteExporter";
import { SandboxVerifier } from "../../src/verifier/sandbox";
import { generateFuzzInputs } from "../../src/verifier/fuzzer";

class MockProvider implements SynthesizerProvider {
    async generatePlayIR(prompt: string): Promise<string> {
        return `
schema_version: "1.0.0"
operation_id: "test_op"
metadata:
  description: "Mocked play"
  author: "test"
  deterministic: true
actions:
  - id: "step_1"
    runtime: "fs"
    action: "make_directory"
    target: "{{inputs.cwd}}/nested_output"
`;
    }
}

describe("E2E Pipeline Integration", () => {
    let sandbox: SandboxVerifier;

    beforeEach(async () => {
        sandbox = new SandboxVerifier();
        await sandbox.setup();
    });

    afterEach(async () => {
        await sandbox.teardown();
    });

    it("should process a full trace to an executable artifact successfully", async () => {
        // 1. Ingestion
        const raw = `
user@host:~/test$ ls
user@host:~/test$ mkdir data
user@host:~/test$ cat data
cat: data: Is a directory
        `;
        const events = parseTrace(raw.trim());
        
        // 2. Synthesis
        const dag = buildDag(events);
        const pruned = pruneDag(dag);
        expect(pruned.length).toBe(1);
        expect(pruned[0].command).toBe("mkdir data");
        
        // 3. Classification
        const literals = classifyLiterals([pruned[0].writes[0] || ""]);
        
        // 4. Synthesizer
        const synthesizer = new Synthesizer(new MockProvider());
        const playIR = await synthesizer.synthesize(pruned, literals);
        expect(playIR.actions[0].action).toBe("make_directory");
        
        // 5. Verifier & Fuzzer
        const inputs = generateFuzzInputs({ cwd: "test" });
        expect(inputs.length).toBe(3); // base, nested, negative
        
        const verified = await sandbox.verify(playIR, { cwd: "" });
        expect(verified).toBe(true);
        
        // 6. Compiler
        const roteScript = exportToRote(playIR);
        expect(roteScript).toContain('definePlay');
        expect(roteScript).toContain('test_op');
        expect(roteScript).toContain('make_directory');
    });
});
