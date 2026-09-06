import { describe, it, expect } from "vitest";
import { classifyResources, ClassifiedResource } from "../../src/synthesis/classifier";
import { ExecutionNode } from "../../src/types/graph";

function createNode(id: string, cwd: string, command: string, reads: string[], writes: string[], deletes: string[]): ExecutionNode {
    return {
        id,
        eventId: id.replace("node_", ""),
        kind: "command",
        command,
        cwd,
        exitCode: 0,
        reads,
        writes,
        deletes,
        parentIds: [],
        childIds: [],
        causalScore: 1
    };
}

describe("Classifier - Resource & Semantic Topology", () => {
    it("Test 1: Explicit domain constants and flags", () => {
        const nodes = [
            createNode("node_1", "/project", "npm install express --save-dev", [], [], [])
        ];
        
        const result = classifyResources(nodes);
        
        const getVal = (val: string) => result.find(r => r.value === val);
        
        // 'install' is a command constant for 'npm'
        expect(getVal("install")?.role).toBe("Domain_Constant");
        
        // '--save-dev' is a flag constant
        expect(getVal("--save-dev")?.role).toBe("Domain_Constant");
        
        // 'express' is NOT a constant, and it wasn't extracted as a resource, so it's not in the results
        expect(getVal("express")).toBeUndefined();
    });

    it("Test 2: Root-relative path replacement", () => {
        const nodes = [
            createNode("node_1", "/project", "cat /project/data/input.csv", ["/project/data/input.csv"], [], [])
        ];
        const result = classifyResources(nodes);
        
        const r = result.find(x => x.value === "/project/data/input.csv");
        expect(r).toBeDefined();
        expect(r?.role).toBe("Input_Parameter");
        expect(r?.replacement).toBe("{{inputs.target_dir}}/data/input.csv");
    });

    it("Test 3: External Read (Input)", () => {
        const nodes = [
            createNode("node_1", "/project", "cat /etc/passwd", ["/etc/passwd"], [], [])
        ];
        const result = classifyResources(nodes);
        
        const r = result.find(x => x.value === "/etc/passwd");
        expect(r?.role).toBe("Input_Parameter");
        expect(r?.replacement).toBe("{{inputs.file_1}}"); // not under root, gets file_1
    });

    it("Test 4: Safe Root Containment", () => {
        const nodes = [
            // CWD is /project. Resource is /project-other/data.txt
            createNode("node_1", "/project", "cat /project-other/data.txt", ["/project-other/data.txt"], [], [])
        ];
        const result = classifyResources(nodes);
        
        const r = result.find(x => x.value === "/project-other/data.txt");
        expect(r?.role).toBe("Input_Parameter");
        expect(r?.replacement).toBe("{{inputs.file_1}}"); // Correctly identifies it as external, NOT {{inputs.target_dir}}-other
    });

    it("Test 5: Internal Lifecycle (Local Artifact)", () => {
        const nodes = [
            createNode("node_1", "/project", "echo temp > /tmp/temp.txt", [], ["/tmp/temp.txt"], []),
            createNode("node_2", "/project", "cat /tmp/temp.txt", ["/tmp/temp.txt"], [], [])
        ];
        const result = classifyResources(nodes);
        
        const r = result.find(x => x.value === "/tmp/temp.txt");
        expect(r?.role).toBe("Local_Artifact");
        expect(r?.replacement).toBe("{{local.tmp_1}}");
        expect(r?.evidence.reason).toContain("Internal state consumed");
    });

    it("Test 6: Surviving Terminal Write (Output)", () => {
        const nodes = [
            createNode("node_1", "/project", "echo out > /project/out.json", [], ["/project/out.json"], [])
        ];
        const result = classifyResources(nodes);
        
        const r = result.find(x => x.value === "/project/out.json");
        expect(r?.role).toBe("Output_Resource");
        expect(r?.replacement).toBe("{{outputs.result_1}}");
    });

    it("Test 7: Repeated Writes collapse to one Output", () => {
        const nodes = [
            createNode("node_1", "/project", "echo a > /project/out.json", [], ["/project/out.json"], []),
            createNode("node_2", "/project", "echo b > /project/out.json", [], ["/project/out.json"], [])
        ];
        const result = classifyResources(nodes);
        
        // out.json survives, so it's Output
        const r = result.find(x => x.value === "/project/out.json");
        expect(r?.role).toBe("Output_Resource");
        expect(r?.evidence.nodes).toEqual(["node_1", "node_2"]);
    });

    it("Test 8: Write -> Read -> Delete (Local Artifact)", () => {
        const nodes = [
            createNode("node_1", "/project", "touch /project/x", [], ["/project/x"], []),
            createNode("node_2", "/project", "rm /project/x", [], [], ["/project/x"])
        ];
        const result = classifyResources(nodes);
        
        const r = result.find(x => x.value === "/project/x");
        expect(r?.role).toBe("Local_Artifact");
        expect(r?.replacement).toBe("{{local.tmp_1}}");
    });

    it("Test 9: Delete / Recreate Lifecycle", () => {
        const nodes = [
            createNode("node_1", "/project", "touch /project/x", [], ["/project/x"], []),
            createNode("node_2", "/project", "rm /project/x", [], [], ["/project/x"]),
            createNode("node_3", "/project", "touch /project/x", [], ["/project/x"], [])
        ];
        const result = classifyResources(nodes);
        
        // Final state is survival.
        const r = result.find(x => x.value === "/project/x");
        expect(r?.role).toBe("Output_Resource");
    });

    it("Test 10: Domain Constants require ecosystem matching", () => {
        const nodes = [
            createNode("node_1", "/project", "npm cat /project/package.json", ["/project/package.json"], [], [])
        ];
        const result = classifyResources(nodes);
        
        const r = result.find(x => x.value === "/project/package.json");
        expect(r?.role).toBe("Domain_Constant");
        expect(r?.evidence.reason).toContain("Registered invariant");
    });

    it("Test 11: Flag values are not swallowed", () => {
        const nodes = [
            createNode("node_1", "/project", "tool --output /project/out.json", [], ["/project/out.json"], [])
        ];
        const result = classifyResources(nodes);
        
        const flag = result.find(x => x.value === "--output");
        expect(flag?.role).toBe("Domain_Constant");
        
        const resource = result.find(x => x.value === "/project/out.json");
        expect(resource?.role).toBe("Output_Resource");
    });

    it("Test 12: CWD tracking replaces target_dir correctly", () => {
        const nodes = [
            createNode("node_1", "/project", "ls", [], [], []),
            createNode("node_2", "/project/src", "ls", ["CWD:/project/src"], [], [])
        ];
        const result = classifyResources(nodes);
        
        const r = result.find(x => x.value === "CWD:/project/src");
        expect(r?.role).toBe("Input_Parameter");
        expect(r?.replacement).toBe("CWD:{{inputs.target_dir}}/src");
        
        const raw = result.find(x => x.value === "/project/src");
        expect(raw?.role).toBe("Input_Parameter");
        expect(raw?.replacement).toBe("{{inputs.target_dir}}/src");
    });
});
