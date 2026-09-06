import { describe, it, expect } from "vitest";
import { pruneDag } from "../../src/synthesis/pruner";
import { ExecutionNode } from "../../src/types/graph";

function createNode(id: string, exitCode: number, parentIds: string[] = []): ExecutionNode {
    return {
        id,
        eventId: id.replace("node_", ""),
        kind: "command",
        command: "mock",
        exitCode,
        reads: [],
        writes: [],
        deletes: [],
        parentIds,
        childIds: [], // We don't need childIds for pruning since it traverses backwards via parentIds
        causalScore: 1
    };
}

describe("Structural Pruner", () => {
    it("Test 1: default anchor (last successful command)", () => {
        // A -> B -> C (success)
        // D (failed)
        const nodes = [
            createNode("node_A", 0),
            createNode("node_B", 0, ["node_A"]),
            createNode("node_C", 0, ["node_B"]),
            createNode("node_D", 1) // failed command
        ];
        
        const pruned = pruneDag(nodes);
        expect(pruned.map(n => n.id)).toEqual(["node_A", "node_B", "node_C"]);
    });

    it("Test 2: explicit anchor", () => {
        // A -> B
        // C -> D
        const nodes = [
            createNode("node_A", 0),
            createNode("node_B", 0, ["node_A"]),
            createNode("node_C", 0),
            createNode("node_D", 0, ["node_C"])
        ];
        
        const pruned = pruneDag(nodes, ["node_B"]);
        expect(pruned.map(n => n.id)).toEqual(["node_A", "node_B"]);
    });

    it("Test 3: explicit anchor validation", () => {
        const nodes = [createNode("node_A", 0)];
        expect(() => pruneDag(nodes, ["node_missing"])).toThrow(/Unknown anchor/);
    });

    it("Test 4: disconnected nodes dropped", () => {
        // A -> B (anchor)
        // X -> Y (unrelated)
        const nodes = [
            createNode("node_A", 0),
            createNode("node_B", 0, ["node_A"]),
            createNode("node_X", 0),
            createNode("node_Y", 0, ["node_X"])
        ];
        
        const pruned = pruneDag(nodes, ["node_B"]);
        expect(pruned.map(n => n.id)).toEqual(["node_A", "node_B"]);
    });

    it("Test 5: preserve order", () => {
        // A -> D
        // B -> D
        // C -> D
        const nodes = [
            createNode("node_A", 0),
            createNode("node_B", 0),
            createNode("node_C", 0),
            createNode("node_D", 0, ["node_A", "node_C", "node_B"])
        ];
        
        // DFS traversal could mess up order if not careful. The pruner should filter the original array.
        const pruned = pruneDag(nodes, ["node_D"]);
        expect(pruned.map(n => n.id)).toEqual(["node_A", "node_B", "node_C", "node_D"]);
    });

    it("Test 6: multiple anchors", () => {
        // A -> B
        // C -> D
        const nodes = [
            createNode("node_A", 0),
            createNode("node_B", 0, ["node_A"]),
            createNode("node_C", 0),
            createNode("node_D", 0, ["node_C"])
        ];
        
        const pruned = pruneDag(nodes, ["node_B", "node_D"]);
        expect(pruned.map(n => n.id)).toEqual(["node_A", "node_B", "node_C", "node_D"]);
    });

    it("Test 7: failed commands", () => {
        // A failed command can be retained if explicitly asked for.
        // But normally it's dropped if not anchored.
        const nodes = [
            createNode("node_A", 0),
            createNode("node_B", 1, ["node_A"]) // failed command depending on A
        ];
        
        // Explicit anchor on a failed command
        const prunedExplicit = pruneDag(nodes, ["node_B"]);
        expect(prunedExplicit.map(n => n.id)).toEqual(["node_A", "node_B"]);

        // Default anchor (last successful) should be A, thus B is pruned.
        const prunedDefault = pruneDag(nodes);
        expect(prunedDefault.map(n => n.id)).toEqual(["node_A"]);
    });

    it("Test 8: Multiple anchors with shared ancestry", () => {
        //         A
        //        / \
        //       B   C
        //       |   |
        //       D   E
        const nodes = [
            createNode("node_A", 0),
            createNode("node_B", 0, ["node_A"]),
            createNode("node_C", 0, ["node_A"]),
            createNode("node_D", 0, ["node_B"]),
            createNode("node_E", 0, ["node_C"])
        ];
        
        const pruned = pruneDag(nodes, ["node_D", "node_E"]);
        expect(pruned.map(n => n.id)).toEqual(["node_A", "node_B", "node_C", "node_D", "node_E"]);
    });

    it("Test 9: Explicit anchor overrides default anchor", () => {
        // A -> B -> C -> D
        const nodes = [
            createNode("node_A", 0),
            createNode("node_B", 0, ["node_A"]),
            createNode("node_C", 0, ["node_B"]),
            createNode("node_D", 0, ["node_C"])
        ];
        
        // No anchor -> D is default, output A B C D
        const prunedDefault = pruneDag(nodes);
        expect(prunedDefault.map(n => n.id)).toEqual(["node_A", "node_B", "node_C", "node_D"]);

        // Explicit anchor -> B, output A B (C and D are pruned)
        const prunedExplicit = pruneDag(nodes, ["node_B"]);
        expect(prunedExplicit.map(n => n.id)).toEqual(["node_A", "node_B"]);
    });
});
