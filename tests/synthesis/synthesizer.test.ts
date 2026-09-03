import { describe, it, expect } from "vitest";
import { Synthesizer, SynthesizerProvider } from "../../src/synthesis/synthesizer";
import { validatePlayIR } from "../../src/compiler/validator";

class MockProvider implements SynthesizerProvider {
    async generatePlayIR(prompt: string): Promise<string> {
        // Return a mocked valid YAML matching PlayIRSchema
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
    target: "{{inputs.cwd}}"
`;
    }
}

class BadMockProvider implements SynthesizerProvider {
    async generatePlayIR(prompt: string): Promise<string> {
        // Return a broken YAML
        return `
schema_version: "1.0.0"
operation_id: "test_op"
# missing metadata
actions:
  - id: "step_1"
`;
    }
}

describe("Synthesizer & Validator", () => {
    it("should parse and validate a correct Play IR YAML", async () => {
        const synthesizer = new Synthesizer(new MockProvider());
        const result = await synthesizer.synthesize([], []);
        
        expect(result.schema_version).toBe("1.0.0");
        expect(result.actions.length).toBe(1);
        expect(result.actions[0].action).toBe("make_directory");
    });

    it("should throw an error on invalid Play IR structure", async () => {
        const synthesizer = new Synthesizer(new BadMockProvider());
        
        await expect(synthesizer.synthesize([], [])).rejects.toThrow();
    });

    it("validator should catch missing fields", () => {
        const badData = { schema_version: "1.0.0" }; // missing operation_id, metadata, actions
        expect(() => validatePlayIR(badData)).toThrow();
    });
});
