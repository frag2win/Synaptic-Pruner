import { describe, it, expect } from "vitest";
import { validatePlayIR } from "../../src/compiler/validator";
import { ExecutionNode } from "../../src/types/graph";
import { ClassifiedResource } from "../../src/synthesis/classifier";

function createNode(id: string, command: string): ExecutionNode {
    return {
        id, eventId: id, kind: "command", command, cwd: "/test", exitCode: 0,
        reads: [], writes: [], deletes: [], parentIds: [], childIds: [], causalScore: 1
    };
}

describe("Validator - Hardened Invariants", () => {
    const nodes = [createNode("node_1", "cat input.txt --force"), createNode("node_2", "echo result > out.txt")];
    const classifications: ClassifiedResource[] = [
        { value: "/test/input.txt", role: "Input_Parameter", replacement: "{{inputs.file_1}}", evidence: { source: "resource", nodes: ["node_1"], reason: "" } },
        { value: "--force", role: "Domain_Constant", evidence: { source: "token", nodes: ["node_1"], reason: "" } },
        { value: "/test/tmp", role: "Local_Artifact", replacement: "{{local.tmp_1}}", evidence: { source: "resource", nodes: ["node_1"], reason: "" } },
        { value: "/test/out.txt", role: "Output_Resource", replacement: "{{outputs.out_1}}", evidence: { source: "resource", nodes: ["node_2"], reason: "" } }
    ];

    const getValidBasePlay = () => ({
        schema_version: "1.0",
        operation_id: "test",
        metadata: { description: "t", author: "t", deterministic: true },
        inputs: { file_1: { type: "string" } },
        actions: [
            {
                id: "step_1",
                runtime: "shell",
                command: "cat {{inputs.file_1}} --force",
                provenance: { sourceNodeIds: ["node_1"] }
            },
            {
                id: "step_2",
                runtime: "shell",
                command: "echo result > {{outputs.out_1}}",
                provenance: { sourceNodeIds: ["node_2"] }
            }
        ]
    });

    it("16. valid Play -> pass", () => {
        expect(() => validatePlayIR(getValidBasePlay(), nodes, classifications)).not.toThrow();
    });

    it("1. invented template -> reject", () => {
        const play = getValidBasePlay();
        play.actions[0].command = "cat {{inputs.file_1}} {{inputs.invented}}";
        expect(() => validatePlayIR(play, nodes, classifications)).toThrow(/invented template variable/);
    });

    it("2. local.* inside inputs -> reject", () => {
        const play = getValidBasePlay();
        (play.inputs as any).tmp_1 = { type: "string" };
        expect(() => validatePlayIR(play, nodes, classifications)).toThrow(/must be Input_Parameter/);
    });

    it("3. missing required input -> reject", () => {
        const play = getValidBasePlay();
        delete (play.inputs as any).file_1;
        expect(() => validatePlayIR(play, nodes, classifications)).toThrow(/Missing required Input_Parameter/);
    });

    it("4. invented output -> reject", () => {
        const play = getValidBasePlay();
        play.actions[1].command = "echo result > {{outputs.invented_out}}";
        expect(() => validatePlayIR(play, nodes, classifications)).toThrow(/invented template variable/);
    });

    it("5. parameterized domain constant -> reject", () => {
        const play = getValidBasePlay();
        play.actions[0].command = "cat {{inputs.file_1}} {{inputs.file_1}}"; // Missing --force
        expect(() => validatePlayIR(play, nodes, classifications)).toThrow(/missing required domain constant '--force'/);
    });

    it("6. missing domain constant -> reject", () => {
        const play = getValidBasePlay();
        play.actions[0].command = "cat {{inputs.file_1}}";
        expect(() => validatePlayIR(play, nodes, classifications)).toThrow(/missing required domain constant '--force'/);
    });

    it("7. missing provenance -> reject", () => {
        const play = getValidBasePlay();
        delete (play.actions[0] as any).provenance;
        expect(() => validatePlayIR(play, nodes, classifications)).toThrow(/has no provenance/);
    });

    it("8. unknown provenance node -> reject", () => {
        const play = getValidBasePlay();
        play.actions[0].provenance.sourceNodeIds = ["node_99"];
        expect(() => validatePlayIR(play, nodes, classifications)).toThrow(/unknown node/);
    });

    it("9. duplicated provenance node -> reject", () => {
        const play = getValidBasePlay();
        play.actions.push({
            id: "step_3",
            runtime: "shell",
            command: "echo again",
            provenance: { sourceNodeIds: ["node_2"] }
        });
        expect(() => validatePlayIR(play, nodes, classifications)).toThrow(/represented 2 times/);
    });

    it("10. omitted provenance node -> reject", () => {
        const play = getValidBasePlay();
        play.actions.pop(); // Remove step_2
        expect(() => validatePlayIR(play, nodes, classifications)).toThrow(/represented 0 times/);
    });

    it("11. wrong base command -> reject", () => {
        const play = getValidBasePlay();
        play.actions[0].command = "grep {{inputs.file_1}} --force";
        expect(() => validatePlayIR(play, nodes, classifications)).toThrow(/base command 'grep' does not match source 'cat'/);
    });

    it("12. wrong resource (fidelity) -> reject", () => {
        const play = getValidBasePlay();
        // node_2 only authorized for out_1. Let's make it use file_1.
        play.actions[1].command = "echo {{inputs.file_1}} > {{outputs.out_1}}";
        expect(() => validatePlayIR(play, nodes, classifications)).toThrow(/not authorized for provenance node 'node_2'/);
    });

    it("13. fabricated precondition target (concrete path) -> reject", () => {
        const play = getValidBasePlay();
        (play as any).preconditions = [{ target: "/etc/passwd", assertion: "exists" }];
        expect(() => validatePlayIR(play, nodes, classifications)).toThrow(/is fabricated/);
    });

    it("14. fabricated postcondition target (concrete path) -> reject", () => {
        const play = getValidBasePlay();
        (play as any).postconditions = [{ target: "/test/out.txt", assertion: "exists" }];
        expect(() => validatePlayIR(play, nodes, classifications)).toThrow(/is fabricated/);
    });

    it("15. fabricated assertion -> reject", () => {
        const play = getValidBasePlay();
        (play as any).preconditions = [{ target: "{{inputs.file_1}}", assertion: "is_healthy" }];
        expect(() => validatePlayIR(play, nodes, classifications)).toThrow(/Fabricated semantic guarantee/);
    });
});
