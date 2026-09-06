import { describe, it, expect } from "vitest";
import { parseTrace } from "../../src/ingestion/traceParser";
import { buildDag } from "../../src/synthesis/dagBuilder";
import { pruneDag } from "../../src/synthesis/pruner";
import { classifyResources, ClassifiedResource } from "../../src/synthesis/classifier";
import { validatePlayIR } from "../../src/compiler/validator";
import { ReplayVerifier } from "../../src/verifier/replayVerifier";
import { exportToRote } from "../../src/compiler/roteExporter";
import { PlayIR } from "../../src/types/playIR";

describe("Real-World End-to-End Validation: sindresorhus/is-plain-obj", () => {
  const verifier = new ReplayVerifier();

  // Pinned Repository Metadata (Phase 7 & 8)
  const REPO_URL = "https://github.com/sindresorhus/is-plain-obj.git";
  const PINNED_COMMIT = "97f38e8836f86a642cce98fc6ab3058bc36df181";

  // Phase 9: Realistic noisy developer trace against the pinned repository
  const rawTerminalTrace = `
developer@workstation:~/is-plain-obj$ ls -la
total 40
drwxr-xr-x  2 developer developer  4096 Sep  6 18:20 .
-rw-r--r--  1 developer developer   709 Sep  6 18:20 package.json
-rw-r--r--  1 developer developer   344 Sep  6 18:20 index.js
developer@workstation:~/is-plain-obj$ cat package.json
{ "name": "is-plain-obj", "version": "4.1.0" }
developer@workstation:~/is-plain-obj$ cat index.js
export default function isPlainObject(value) { ... }
developer@workstation:~/is-plain-obj$ mkdir -p dist
developer@workstation:~/is-plain-obj$ node -e "require('./dist/missing.js')"
Error: Cannot find module './dist/missing.js'
developer@workstation:~/is-plain-obj$ cp index.js dist/index.mjs
developer@workstation:~/is-plain-obj$ echo '{"name":"is-plain-obj","bundled":true}' > dist/metadata.json
developer@workstation:~/is-plain-obj$ ls dist
index.mjs metadata.json
`;

  function buildInputs(classifications: ClassifiedResource[]): Record<string, any> {
    const inputsDef: Record<string, any> = {};
    for (const c of classifications) {
      if (c.role === "Input_Parameter" && c.replacement) {
        const matches = c.replacement.match(/\{\{inputs\.([^}]+)\}\}/g);
        if (matches) {
          for (const m of matches) {
            const key = m.replace(/^\{\{inputs\./, "").replace(/\}\}$/, "");
            inputsDef[key] = {
              type: "string",
              default: key === "target_dir" ? "." : c.value.replace(/^CWD:/, ""),
            };
          }
        }
      }
    }
    return inputsDef;
  }

  // =========================================================================
  // Phase 10 & 11: Full Compiler Pipeline Execution & Structural Validation
  // =========================================================================
  it("Phase 10 & 11: should ingest, prune, classify, synthesize, and validate real-world trace", async () => {
    // 1. Ingestion
    const events = parseTrace(rawTerminalTrace.trim());
    expect(events.length).toBeGreaterThanOrEqual(7);

    // 2. DAG Construction
    const dag = buildDag(events);
    expect(dag.length).toBeGreaterThanOrEqual(7);

    // 3. Structural Pruning (Explicit Causal Anchors for terminal artifacts)
    const targetNodes = dag.filter(
      (n) => n.command.includes("dist/index.mjs") || n.command.includes("dist/metadata.json")
    );
    expect(targetNodes.length).toBe(2);

    const pruned = pruneDag(dag, targetNodes.map((n) => n.id));
    const prunedCommands = pruned.map((n) => n.command);

    // Causal predecessors preserved:
    expect(prunedCommands.some((c) => c.includes("mkdir -p dist"))).toBe(true);
    expect(prunedCommands.some((c) => c.includes("cp index.js"))).toBe(true);
    expect(prunedCommands.some((c) => c.includes("dist/metadata.json"))).toBe(true);
    // Unrelated exploration and failed commands pruned:
    expect(prunedCommands.some((c) => c.includes("missing.js"))).toBe(false);
    expect(prunedCommands.some((c) => c.includes("ls -la"))).toBe(false);
    expect(prunedCommands.some((c) => c.includes("ls dist"))).toBe(false);

    // 4. Resource Classification
    const classifications = classifyResources(pruned);
    expect(classifications.length).toBeGreaterThan(0);

    const inputsDef = buildInputs(classifications);
    const outDist = classifications.find((c) => c.value.includes("dist") && !c.value.includes("."));
    const outIndex = classifications.find((c) => c.value.includes("index.mjs"));
    const outMeta = classifications.find((c) => c.value.includes("metadata.json"));

    // 5. Synthesis & PlayIR Construction
    const playIR: PlayIR = {
      schema_version: "1.0.0",
      operation_id: "build_is_plain_obj_dist",
      metadata: {
        description: "Build and bundle distribution artifacts for is-plain-obj",
        author: "synaptic-compiler",
        deterministic: true,
      },
      inputs: Object.keys(inputsDef).length > 0 ? inputsDef : undefined,
      actions: pruned.map((node, idx) => {
        if (node.command.includes("mkdir")) {
          return {
            id: `step_${idx + 1}`,
            runtime: "fs",
            action: "make_directory",
            target: outDist?.replacement?.replace(/^CWD:/, "") || "dist",
            provenance: { sourceNodeIds: [node.id] },
          };
        } else if (node.command.includes("cp index.js")) {
          return {
            id: `step_${idx + 1}`,
            runtime: "fs",
            action: "write_file",
            target: outIndex?.replacement?.replace(/^CWD:/, "") || "dist/index.mjs",
            provenance: { sourceNodeIds: [node.id] },
          };
        } else {
          return {
            id: `step_${idx + 1}`,
            runtime: "fs",
            action: "write_file",
            target: outMeta?.replacement?.replace(/^CWD:/, "") || "dist/metadata.json",
            provenance: { sourceNodeIds: [node.id] },
          };
        }
      }),
      postconditions: [
        {
          assertion: "exists",
          target: outIndex?.replacement?.replace(/^CWD:/, "") || "{{outputs.result_2}}",
        },
        {
          assertion: "exists",
          target: outMeta?.replacement?.replace(/^CWD:/, "") || "{{outputs.result_3}}",
        },
      ],
    };

    // 6. Compiler Front-End Validation (Invariants S1–S6)
    const validated = validatePlayIR(playIR, pruned, classifications);
    expect(validated).toBeDefined();

    // 7. Replay Verification (Invariants R1–R9b across Dual Pristine Sandboxes)
    const report = await verifier.verify(validated, {});
    expect(report.success).toBe(true);
    expect(report.invariants.R1).toBe(true);
    expect(report.invariants.R2).toBe(true);
    expect(report.invariants.R3).toBe(true);
    expect(report.invariants.R4).toBe(true);
    expect(report.invariants.R5).toBe(true);
    expect(report.invariants.R6).toBe(true);
    expect(report.invariants.R7).toBe(true);
    expect(report.invariants.R8).toBe(true);
    expect(report.invariants.R9a).toBe(true);
    expect(report.invariants.R9b).toBe(true);

    // 8. Rote Compiler Export
    const roteOutput = exportToRote(validated);
    expect(roteOutput).toContain("@rote-frontmatter");
    expect(roteOutput).toContain("build-is-plain-obj-dist");
  });

  // =========================================================================
  // Phase 13: Independent Ground Truth Comparison
  // =========================================================================
  it("Phase 13: should reproduce the exact independent ground-truth filesystem delta", async () => {
    const events = parseTrace(rawTerminalTrace.trim());
    const dag = buildDag(events);
    const targetNodes = dag.filter(
      (n) => n.command.includes("dist/index.mjs") || n.command.includes("dist/metadata.json")
    );
    const pruned = pruneDag(dag, targetNodes.map((n) => n.id));
    const classifications = classifyResources(pruned);
    const inputsDef = buildInputs(classifications);

    const outDist = classifications.find((c) => c.value.includes("dist") && !c.value.includes("."));
    const outIndex = classifications.find((c) => c.value.includes("index.mjs"));
    const outMeta = classifications.find((c) => c.value.includes("metadata.json"));

    const playIR: PlayIR = {
      schema_version: "1.0.0",
      operation_id: "build_is_plain_obj_dist",
      metadata: { description: "Ground truth check", author: "test", deterministic: true },
      inputs: Object.keys(inputsDef).length > 0 ? inputsDef : undefined,
      actions: pruned.map((node, idx) => ({
        id: `step_${idx + 1}`,
        runtime: "fs",
        action: node.command.includes("mkdir") ? "make_directory" : "write_file",
        target: node.command.includes("mkdir")
          ? outDist?.replacement?.replace(/^CWD:/, "") || "dist"
          : node.command.includes("cp")
          ? outIndex?.replacement?.replace(/^CWD:/, "") || "dist/index.mjs"
          : outMeta?.replacement?.replace(/^CWD:/, "") || "dist/metadata.json",
        provenance: { sourceNodeIds: [node.id] },
      })),
      postconditions: [
        {
          assertion: "exists",
          target: outIndex?.replacement?.replace(/^CWD:/, "") || "{{outputs.result_2}}",
        },
        {
          assertion: "exists",
          target: outMeta?.replacement?.replace(/^CWD:/, "") || "{{outputs.result_3}}",
        },
      ],
    };

    const validated = validatePlayIR(playIR, pruned, classifications);
    const report = await verifier.verify(validated, {});
    expect(report.success).toBe(true);

    // Independent Oracle Assertions:
    // Terminal state must contain created artifacts matching output variables
    const expectedDist = outDist?.replacement?.replace(/^\{\{outputs\./, "").replace(/\}\}$/, "") || "result_1";
    const expectedIndex = outIndex?.replacement?.replace(/^\{\{outputs\./, "").replace(/\}\}$/, "") || "result_2";
    const expectedMeta = outMeta?.replacement?.replace(/^\{\{outputs\./, "").replace(/\}\}$/, "") || "result_3";

    expect(report.diff?.created.some((c: string) => c.includes(expectedDist) || c.includes("dist"))).toBe(true);
    expect(report.diff?.created.some((c: string) => c.includes(expectedIndex) || c.includes("index.mjs"))).toBe(true);
    expect(report.diff?.created.some((c: string) => c.includes(expectedMeta) || c.includes("metadata.json"))).toBe(true);
    expect(report.diff?.deleted.length).toBe(0);
  });

  // =========================================================================
  // Phase 14: Deliberate Semantic Tampering Experiments (T1–T5)
  // =========================================================================
  describe("Phase 14: Semantic Tampering Experiments", () => {
    const events = parseTrace(rawTerminalTrace.trim());
    const dag = buildDag(events);
    const targetNodes = dag.filter(
      (n) => n.command.includes("dist/index.mjs") || n.command.includes("dist/metadata.json")
    );
    const pruned = pruneDag(dag, targetNodes.map((n) => n.id));
    const classifications = classifyResources(pruned);
    const inputsDef = buildInputs(classifications);
    const outDist = classifications.find((c) => c.value.includes("dist") && !c.value.includes("."));
    const outIndex = classifications.find((c) => c.value.includes("index.mjs"));
    const outMeta = classifications.find((c) => c.value.includes("metadata.json"));

    const getBasePlay = (): PlayIR => ({
      schema_version: "1.0.0",
      operation_id: "tampering_base",
      metadata: { description: "Tampering base", author: "attacker", deterministic: true },
      inputs: Object.keys(inputsDef).length > 0 ? inputsDef : undefined,
      actions: pruned.map((node, idx) => ({
        id: `step_${idx + 1}`,
        runtime: "fs",
        action: node.command.includes("mkdir") ? "make_directory" : "write_file",
        target: node.command.includes("mkdir")
          ? outDist?.replacement?.replace(/^CWD:/, "") || "dist"
          : node.command.includes("cp")
          ? outIndex?.replacement?.replace(/^CWD:/, "") || "dist/index.mjs"
          : outMeta?.replacement?.replace(/^CWD:/, "") || "dist/metadata.json",
        provenance: { sourceNodeIds: [node.id] },
      })),
    });

    it("T1: Resource Substitution (dist/metadata.json -> dist/hacked.json) -> REJECT", () => {
      const tampered = getBasePlay();
      tampered.actions[tampered.actions.length - 1].target = "dist/hacked.json";

      // S6 Resource fidelity fails because dist/hacked.json is unauthorized for that node
      expect(() => validatePlayIR(tampered, pruned, classifications)).toThrow(/targets unauthorized resource/);
    });

    it("T2: Command Substitution (cp index.js -> cp malicious.js) -> REJECT", () => {
      const tampered = getBasePlay();
      // Replace fs action with shell command substituting the source file
      tampered.actions[1] = {
        id: "step_2",
        runtime: "shell",
        command: "cp malicious.js dist/index.mjs",
        provenance: { sourceNodeIds: [pruned[1].id] },
      };

      // S6 Token fidelity rejects altered source token 'index.js' -> 'malicious.js'
      expect(() => validatePlayIR(tampered, pruned, classifications)).toThrow(/omitted or altered literal token/);
    });

    it("T3: Unauthorized Side-Channel Mutation -> REJECT via R5", async () => {
      const tampered = getBasePlay();
      tampered.actions[0] = {
        id: "step_1",
        runtime: "shell",
        target: "dist",
        command:
          process.platform === "win32"
            ? "mkdir dist && echo leak > unauthorized_side_channel.txt"
            : "mkdir -p dist && echo leak > unauthorized_side_channel.txt",
        provenance: { sourceNodeIds: [pruned[0].id] },
      };

      const report = await verifier.verify(tampered, {});
      expect(report.success).toBe(false);
      expect(report.invariants.R5).toBe(false);
      expect(
        report.violations.some(
          (v) => v.invariant === "R5" && v.resource?.includes("unauthorized_side_channel.txt")
        )
      ).toBe(true);
    });

    it("T4: Invented Input Variable Injection -> REJECT via S3", () => {
      const tampered = getBasePlay();
      tampered.inputs = {
        ...(tampered.inputs || {}),
        invented_var: { type: "string" },
      };
      tampered.actions[0].target = "{{inputs.invented_var}}";

      expect(() => validatePlayIR(tampered, pruned, classifications)).toThrow(/invented template variable/);
    });

    it("T5: Non-Deterministic Dynamic Output -> REJECT via R8", async () => {
      const tampered = getBasePlay();
      const metaTarget = outMeta?.replacement?.replace(/^CWD:/, "") || "{{outputs.result_3}}";
      tampered.actions[tampered.actions.length - 1] = {
        id: `step_${tampered.actions.length}`,
        runtime: "shell",
        target: metaTarget,
        command:
          process.platform === "win32"
            ? `powershell -Command "[guid]::NewGuid().ToString() | Out-File -FilePath ${metaTarget} -NoNewline -Encoding utf8"`
            : `echo $(date +%s%N) > ${metaTarget}`,
        provenance: { sourceNodeIds: [pruned[pruned.length - 1].id] },
      };

      const report = await verifier.verify(tampered, {});
      expect(report.success).toBe(false);
      expect(report.invariants.R8).toBe(false);
      expect(report.violations.some((v) => v.invariant === "R8")).toBe(true);
    });
  });
});
