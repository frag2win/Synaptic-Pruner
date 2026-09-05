import { describe, it, expect } from "vitest";
import { buildDag } from "../../src/synthesis/dagBuilder";
import { TraceEvent } from "../../src/types/trace";

function createMockEvent(id: string, command: string, exitCode: number, cwd: string = "/project"): TraceEvent {
    return {
        id,
        timestamp: new Date().toISOString(),
        command,
        cwd,
        exitCode,
        stdout: "",
        stderr: "",
        fsMutations: []
    };
}

describe("DAG Builder (State-transition dependency graph)", () => {

    it("Test 1: independent commands", () => {
        const events = [
            createMockEvent("1", "echo hello", 0),
            createMockEvent("2", "echo world", 0)
        ];
        const dag = buildDag(events);
        
        expect(dag[0].childIds.length).toBe(0);
        expect(dag[1].parentIds.length).toBe(0);
    });

    it("Test 2: write/read", () => {
        const events = [
            createMockEvent("1", "touch a.txt", 0),
            createMockEvent("2", "cat a.txt", 0)
        ];
        const dag = buildDag(events);
        
        expect(dag[1].parentIds).toContain("node_1");
        expect(dag[0].childIds).toContain("node_2");
    });

    it("Test 3: unrelated command", () => {
        const events = [
            createMockEvent("1", "touch a.txt", 0),
            createMockEvent("2", "pwd", 0),
            createMockEvent("3", "cat a.txt", 0)
        ];
        const dag = buildDag(events);
        
        expect(dag[2].parentIds).toContain("node_1");
        expect(dag[2].parentIds).not.toContain("node_2"); // pwd should not be a parent
        expect(dag[1].childIds.length).toBe(0);
    });

    it("Test 4: overwrite", () => {
        const events = [
            createMockEvent("1", "echo a > x", 0),
            createMockEvent("2", "echo b > x", 0),
            createMockEvent("3", "cat x", 0)
        ];
        const dag = buildDag(events);
        
        expect(dag[2].parentIds).toContain("node_2");
        expect(dag[2].parentIds).not.toContain("node_1");
        expect(dag[0].childIds).not.toContain("node_3");
    });

    it("Test 5: directory dependency", () => {
        const events = [
            createMockEvent("1", "mkdir data", 0),
            createMockEvent("2", "touch data/a.txt", 0)
        ];
        const dag = buildDag(events);
        
        expect(dag[1].parentIds).toContain("node_1");
    });

    it("Test 6: failed command", () => {
        const events = [
            createMockEvent("1", "touch a", 0),
            createMockEvent("2", "cat missing", 1),
            createMockEvent("3", "cat a", 0)
        ];
        const dag = buildDag(events);
        
        expect(dag[2].parentIds).toContain("node_1");
        expect(dag[2].parentIds).not.toContain("node_2");
    });

    it("Test 7: relative paths", () => {
        const events = [
            createMockEvent("1", "touch ./data/a.txt", 0, "/project"),
            createMockEvent("2", "cat data/a.txt", 0, "/project")
        ];
        const dag = buildDag(events);
        
        expect(dag[1].parentIds).toContain("node_1");
    });

    it("Test 8: unrelated package identifier", () => {
        const events = [
            createMockEvent("1", "npm install express", 0)
        ];
        const dag = buildDag(events);
        
        // express should not be read as a filesystem resource
        expect(dag[0].reads.some(r => r.includes("express"))).toBe(false);
    });

    it("Test 9: duplicate dependency does not create duplicate edge", () => {
        const events = [
            createMockEvent("1", "touch a.txt", 0),
            createMockEvent("2", "cat a.txt a.txt", 0)
        ];
        const dag = buildDag(events);
        
        const edgesFrom1To2 = dag[1].parentIds.filter(id => id === "node_1").length;
        expect(edgesFrom1To2).toBe(1);
    });

    it("Test 10: absolute and relative path resolve identically", () => {
        const events = [
            createMockEvent("1", "touch /project/a.txt", 0, "/project"),
            createMockEvent("2", "cat a.txt", 0, "/project")
        ];
        const dag = buildDag(events);
        
        expect(dag[1].parentIds).toContain("node_1");
    });

    it("Test 11: failed writer does not become lastWriter", () => {
        const events = [
            createMockEvent("1", "touch a.txt", 0),
            createMockEvent("2", "echo bad > a.txt", 1),
            createMockEvent("3", "cat a.txt", 0)
        ];
        const dag = buildDag(events);
        
        expect(dag[2].parentIds).toContain("node_1");
        expect(dag[2].parentIds).not.toContain("node_2");
    });

    it("Test 12: three commands writing same file -> only latest writer -> reader", () => {
        const events = [
            createMockEvent("1", "echo 1 > a.txt", 0),
            createMockEvent("2", "echo 2 > a.txt", 0),
            createMockEvent("3", "echo 3 > a.txt", 0),
            createMockEvent("4", "cat a.txt", 0)
        ];
        const dag = buildDag(events);
        
        expect(dag[3].parentIds).toContain("node_3");
        expect(dag[3].parentIds).not.toContain("node_1");
        expect(dag[3].parentIds).not.toContain("node_2");
    });

    it("Test 13: unrelated file creation does not depend on another file", () => {
        const events = [
            createMockEvent("1", "mkdir data", 0),
            createMockEvent("2", "touch data/a.txt", 0),
            createMockEvent("3", "touch data/b.txt", 0)
        ];
        const dag = buildDag(events);
        
        expect(dag[1].parentIds).toContain("node_1"); // a depends on mkdir
        expect(dag[2].parentIds).toContain("node_1"); // b depends on mkdir
        expect(dag[2].parentIds).not.toContain("node_2"); // b does NOT depend on a
    });

    it("Test 14: graph remains acyclic", () => {
        const events = [
            createMockEvent("1", "touch a.txt", 0),
            createMockEvent("2", "cat a.txt", 0),
            createMockEvent("3", "rm a.txt", 0)
        ];
        // buildDag will automatically run validateAcyclic and throw if there's a cycle
        expect(() => buildDag(events)).not.toThrow();
    });

});
