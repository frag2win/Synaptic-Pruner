import { describe, it, expect } from "vitest";
import { buildDag } from "../../src/synthesis/dagBuilder";
import { pruneDag } from "../../src/synthesis/pruner";
import { TraceEvent } from "../../src/types/trace";

function createMockEvent(id: string, command: string, exitCode: number): TraceEvent {
    return {
        id,
        timestamp: new Date().toISOString(),
        command,
        cwd: "~/test",
        exitCode,
        stdout: "",
        stderr: "",
        fsMutations: []
    };
}

describe("DAG Builder and Pruner", () => {
  it("should build data dependencies correctly", () => {
    const events = [
        createMockEvent("1", "echo hello > file.txt", 0),
        createMockEvent("2", "cat file.txt", 0)
    ];

    const dag = buildDag(events);
    expect(dag.length).toBe(2);
    
    // Node 1 writes to file.txt
    expect(dag[0].writes).toContain("file.txt");
    // Node 2 reads from file.txt
    expect(dag[1].reads).toContain("file.txt");
    
    // Node 1 should be a parent of Node 2
    expect(dag[1].parentIds).toContain(dag[0].id);
    expect(dag[0].childIds).toContain(dag[1].id);
  });

  it("should collapse cyclic retry loops", () => {
    const events = [
        createMockEvent("1", "npm install express", 1), // Failure 1
        createMockEvent("2", "npm install express --force", 1), // Failure 2
        createMockEvent("3", "npm install express --legacy-peer-deps", 0), // Success
    ];

    const dag = buildDag(events);
    const pruned = pruneDag(dag);

    // Only the successful installation should survive
    expect(pruned.length).toBe(1);
    expect(pruned[0].command).toBe("npm install express --legacy-peer-deps");
  });

  it("should strip dead-end exploratory commands", () => {
    const events = [
        createMockEvent("1", "ls -la", 0), // Exploratory
        createMockEvent("2", "pwd", 0), // Exploratory
        createMockEvent("3", "mkdir project", 0), // Mutating
        createMockEvent("4", "cat project", 1), // Failure
        createMockEvent("5", "touch project/index.js", 0), // Terminal Mutating
    ];

    const dag = buildDag(events);
    const pruned = pruneDag(dag);

    // Should only keep mkdir and touch
    expect(pruned.length).toBe(2);
    expect(pruned[0].command).toBe("mkdir project");
    expect(pruned[1].command).toBe("touch project/index.js");
  });
});
