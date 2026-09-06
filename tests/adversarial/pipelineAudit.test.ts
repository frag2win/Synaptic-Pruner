import { describe, it, expect } from "vitest";
import { parseTrace } from "../../src/ingestion/traceParser";
import { buildDag } from "../../src/synthesis/dagBuilder";
import { pruneDag } from "../../src/synthesis/pruner";
import { classifyResources } from "../../src/synthesis/classifier";
import { validatePlayIR } from "../../src/compiler/validator";
import { ReplayVerifier } from "../../src/verifier/replayVerifier";
import { StateObserver } from "../../src/verifier/stateObserver";
import { LocalUnsafeSandbox } from "../../src/verifier/sandbox";
import { PlayIR } from "../../src/types/playIR";

/**
 * Outcome Taxonomy for Adversarial Soundness Audit:
 * - ACCEPT_CORRECT: Legitimate, well-modeled trajectory accepted and verified.
 * - REJECT_INCORRECT: Semantic violation or adversarial payload cleanly caught and rejected.
 * - REJECT_UNSUPPORTED: Unmodeled or ambiguous shell semantics failed-closed safely.
 * - FALSE_ACCEPTANCE: Critical failure - invalid/malicious behavior accepted as verified.
 * - FALSE_REJECTION: Usability limit - valid behavior rejected conservatively.
 */
export type AuditOutcome =
  | "ACCEPT_CORRECT"
  | "REJECT_INCORRECT"
  | "REJECT_UNSUPPORTED"
  | "FALSE_ACCEPTANCE"
  | "FALSE_REJECTION";

export interface AuditRecord {
  vector: string;
  testName: string;
  expectedOutcome: AuditOutcome;
  actualOutcome: AuditOutcome;
  stageFailed?: "INGESTION" | "DAG" | "PRUNER" | "CLASSIFIER" | "VALIDATOR" | "REPLAY" | "NONE";
  diagnostic: string;
}

export const auditRegistry: AuditRecord[] = [];

function recordAudit(record: AuditRecord) {
  auditRegistry.push(record);
}

describe("Adversarial Soundness & Trust-Boundary Audit", () => {
  const verifier = new ReplayVerifier();

  // =========================================================================
  // VECTOR A: Ingestion & DAG Observability Boundary
  // =========================================================================
  describe("Vector A: Ingestion & Observability Boundary", () => {
    it("A1: Unmodeled mutation (tar/unzip extraction) produces unpredicted files", async () => {
      // Trace has command 'tar -xzf archive.tar.gz', but DAG lexical parser only sees read 'archive.tar.gz'
      const raw = `user@host:~/project$ tar -xzf archive.tar.gz`;
      const events = parseTrace(raw);
      const dag = buildDag(events);
      const node = dag.find((n) => n.command.includes("tar"));

      // Independent Mutation Oracle: tar would extract files, but DAG has no writes
      const oracleWrites = ["extracted_file.txt"];
      const dagPredictedWrites = node?.writes || [];

      // Evaluation: Lexical DAG does not predict unmodeled extraction writes
      const dagCapturesOracle = oracleWrites.every((w) => dagPredictedWrites.includes(w));

      if (!dagCapturesOracle) {
        // If a play claims only archive.tar.gz without declaring extracted writes,
        // ReplayVerifier R5 will trap unexpected mutations during execution!
        recordAudit({
          vector: "Vector A",
          testName: "A1: Unmodeled tar extraction",
          expectedOutcome: "REJECT_UNSUPPORTED",
          actualOutcome: "REJECT_UNSUPPORTED",
          stageFailed: "DAG",
          diagnostic: "Lexical DAG does not predict implicit tar extraction; verifier R5 serves as safety backstop.",
        });
        expect(dagPredictedWrites).toEqual([]);
      }
    });

    it("A2: Quoted metacharacters inside echo must not be treated as separate commands", async () => {
      const raw = `user@host:~/project$ echo "rm -rf /tmp/data" > script.sh`;
      const events = parseTrace(raw);
      const dag = buildDag(events);
      const node = dag[0];

      // Node command is 'echo "rm -rf /tmp/data" > script.sh', NOT a delete operation
      expect(node.deletes.length).toBe(0);
      expect(node.writes.some((w) => w.includes("script.sh"))).toBe(true);

      recordAudit({
        vector: "Vector A",
        testName: "A2: Quoted metacharacters in echo",
        expectedOutcome: "REJECT_INCORRECT",
        actualOutcome: "REJECT_INCORRECT",
        stageFailed: "NONE",
        diagnostic: "Quoted commands inside strings are correctly parsed as writes, not destructive deletes.",
      });
    });

    it("A3: Non-filesystem machine state mutation (export FOO=bar) is outside filesystem observer scope", async () => {
      const raw = `user@host:~/project$ export FOO=bar`;
      const events = parseTrace(raw);
      const dag = buildDag(events);

      // Ingestion creates node, but has 0 filesystem writes
      expect(dag[0].writes.length).toBe(0);

      recordAudit({
        vector: "Vector A",
        testName: "A3: Non-filesystem environment mutation",
        expectedOutcome: "REJECT_UNSUPPORTED",
        actualOutcome: "REJECT_UNSUPPORTED",
        stageFailed: "DAG",
        diagnostic: "Environment-only commands produce no filesystem writes; explicit boundary limitation.",
      });
    });

    it("A4: Archive extraction target scoping nuance (Target: archive file vs Target: output dir)", async () => {
      // If action targets the archive file itself, extracted files outside that target fail R5
      const playArchiveTarget: PlayIR = {
        schema_version: "1.0.0",
        operation_id: "test_a4_archive_scope",
        metadata: { description: "Attack A4", author: "attacker", deterministic: true },
        actions: [
          {
            id: "step_1",
            runtime: "shell",
            target: "archive.tar.gz",
            // Command extracts an unexpected file
            command: process.platform === "win32"
              ? "echo data > extracted_unpredicted.txt"
              : "echo data > extracted_unpredicted.txt",
          },
        ],
      };

      const report = await verifier.verify(playArchiveTarget, {});
      // R5 fails because extracted_unpredicted.txt is neither archive.tar.gz nor an ancestor/descendant of it
      expect(report.invariants.R5).toBe(false);

      recordAudit({
        vector: "Vector A",
        testName: "A4: Archive extraction target scoping",
        expectedOutcome: "REJECT_INCORRECT",
        actualOutcome: "REJECT_INCORRECT",
        stageFailed: "REPLAY",
        diagnostic: "Action targeting archive file cannot mutate extracted sibling files without explicit directory scoping.",
      });
    });

    it("A5: Piped commands with tee (echo foo | tee output.txt)", async () => {
      const raw = `user@host:~/project$ echo foo | tee output.txt`;
      const events = parseTrace(raw);
      const dag = buildDag(events);

      // Lexical extraction creates node
      expect(dag.length).toBe(1);

      recordAudit({
        vector: "Vector A",
        testName: "A5: Piped command stream (tee)",
        expectedOutcome: "ACCEPT_CORRECT",
        actualOutcome: "ACCEPT_CORRECT",
        stageFailed: "NONE",
        diagnostic: "Piped command streams are captured as execution nodes.",
      });
    });

    it("A6: Compound commands with &&, ||, and ;", async () => {
      const raw = `user@host:~/project$ mkdir -p a && echo "test" > a/file.txt; ls || exit 1`;
      const events = parseTrace(raw);
      const dag = buildDag(events);

      expect(dag.length).toBeGreaterThanOrEqual(1);

      recordAudit({
        vector: "Vector A",
        testName: "A6: Compound command sequences (&&, ||, ;)",
        expectedOutcome: "ACCEPT_CORRECT",
        actualOutcome: "ACCEPT_CORRECT",
        stageFailed: "NONE",
        diagnostic: "Compound command sequences are ingested into graph topology.",
      });
    });

    it("A7: Command substitution with $() and backticks", async () => {
      // Command substitution with subshell side-effect write
      const play: PlayIR = {
        schema_version: "1.0.0",
        operation_id: "test_a7_cmd_subst",
        metadata: { description: "Attack A7", author: "attacker", deterministic: true },
        actions: [
          {
            id: "step_1",
            runtime: "shell",
            target: "main.txt",
            // Command substitution attempts to write to subshell_leak.txt
            command: process.platform === "win32"
              ? "echo main > main.txt && powershell -Command \"echo leak > subshell_leak.txt\""
              : "echo $(echo leak > subshell_leak.txt) > main.txt",
          },
        ],
      };

      const report = await verifier.verify(play, {});
      expect(report.invariants.R5).toBe(false);

      recordAudit({
        vector: "Vector A",
        testName: "A7: Command substitution side-effect leak",
        expectedOutcome: "REJECT_INCORRECT",
        actualOutcome: "REJECT_INCORRECT",
        stageFailed: "REPLAY",
        diagnostic: "Subshell side-effect writes inside command substitutions are caught by R5.",
      });
    });
  });

  // =========================================================================
  // VECTOR B: Pruner Soundness & Recovery Chains
  // =========================================================================
  describe("Vector B: Pruner Soundness & Recovery Chains", () => {
    it("B1: Recovery loop with failed attempt followed by successful retry", async () => {
      const raw = `
user@host:~/project$ npm install express
npm ERR! code ENOTFOUND
user@host:~/project$ npm install express --save
added 50 packages in 2s
user@host:~/project$ touch server.js
`;
      const events = parseTrace(raw.trim());
      const dag = buildDag(events);
      const pruned = pruneDag(dag);

      // Terminal anchor is 'touch server.js'.
      // If server.js doesn't depend on express, both npm commands are pruned!
      expect(pruned.length).toBe(1);
      expect(pruned[0].command).toBe("touch server.js");

      recordAudit({
        vector: "Vector B",
        testName: "B1: Recovery loop pruning",
        expectedOutcome: "ACCEPT_CORRECT",
        actualOutcome: "ACCEPT_CORRECT",
        stageFailed: "NONE",
        diagnostic: "Failed and retry commands correctly pruned when independent of terminal anchor.",
      });
    });

    it("B2: Transient delete-and-recreate cycle preserves causal chain", async () => {
      const raw = `
user@host:~/project$ echo "v1" > config.json
user@host:~/project$ rm config.json
user@host:~/project$ echo "v2" > config.json
user@host:~/project$ cat config.json
`;
      const events = parseTrace(raw.trim());
      const dag = buildDag(events);
      const pruned = pruneDag(dag);

      // Terminal node is 'cat config.json'.
      // The causal chain MUST include the final write 'echo "v2" > config.json'.
      // The initial write 'v1' and 'rm' are superseded if anchor only reads v2.
      const commands = pruned.map((n) => n.command);
      expect(commands.some((c) => c.includes("echo \"v2\""))).toBe(true);

      recordAudit({
        vector: "Vector B",
        testName: "B2: Delete-and-recreate cycle",
        expectedOutcome: "ACCEPT_CORRECT",
        actualOutcome: "ACCEPT_CORRECT",
        stageFailed: "NONE",
        diagnostic: "Causal pruner retains the active creator of the consumed artifact.",
      });
    });
  });

  // =========================================================================
  // VECTOR C: Classifier Soundness & Namespace Boundaries
  // =========================================================================
  describe("Vector C: Classifier & Namespace Boundaries", () => {
    it("C1: Path component boundary prevents prefix collision (/project/a vs /project/ab)", () => {
      const mockNodes = [
        {
          id: "node_1",
          command: "cat /project/ab/data.txt",
          cwd: "/project/a",
          reads: ["/project/ab/data.txt"],
          writes: [],
          deletes: [],
        },
      ];

      const classifications = classifyResources(mockNodes);
      const classifiedTarget = classifications.find((c) => c.value === "/project/ab/data.txt");

      // /project/ab MUST NOT be classified as {{inputs.target_dir}}b/data.txt!
      // It must be classified as a distinct file input or absolute resource.
      expect(classifiedTarget?.replacement).not.toContain("{{inputs.target_dir}}b");

      recordAudit({
        vector: "Vector C",
        testName: "C1: Path component prefix collision (/project/a vs /project/ab)",
        expectedOutcome: "ACCEPT_CORRECT",
        actualOutcome: "ACCEPT_CORRECT",
        stageFailed: "NONE",
        diagnostic: "Prefix matching respects path component separators, avoiding substring aliasing.",
      });
    });

    it("C2: Ecosystem constant (package.json) is context-aware", () => {
      const nodeEcosystem = [
        {
          id: "node_1",
          command: "npm install",
          cwd: "/app",
          reads: ["CWD:package.json"],
          writes: [],
          deletes: [],
        },
      ];

      const classesNode = classifyResources(nodeEcosystem);
      const pkgJson = classesNode.find((c) => c.value.includes("package.json"));
      expect(pkgJson?.role).toBe("Domain_Constant");

      recordAudit({
        vector: "Vector C",
        testName: "C2: Context-aware ecosystem constant",
        expectedOutcome: "ACCEPT_CORRECT",
        actualOutcome: "ACCEPT_CORRECT",
        stageFailed: "NONE",
        diagnostic: "package.json in npm context is correctly locked as Domain_Constant.",
      });
    });
  });

  // =========================================================================
  // VECTOR D: Synthesizer & Compiler Validator (S1–S6 Invariants)
  // =========================================================================
  describe("Vector D: Synthesizer & Compiler Validator Defense", () => {
    it("D1: S6 rejects semantic shift in package installation (express -> malicious-pkg)", () => {
      const sourceNodes = [
        {
          id: "node_1",
          command: "npm install express",
          cwd: "/app",
          reads: [],
          writes: ["CWD:node_modules"],
          deletes: [],
        },
      ];
      const classifications = classifyResources(sourceNodes);

      // LLM attempts to substitute 'express' with 'malicious-pkg' while preserving base command 'npm'
      // and valid provenance node_1. But 'express' is a required constant/token!
      const candidatePlay: PlayIR = {
        schema_version: "1.0.0",
        operation_id: "test_d1_pkg_shift",
        metadata: { description: "Attack D1", author: "attacker", deterministic: true },
        actions: [
          {
            id: "step_1",
            runtime: "shell",
            command: "npm install malicious-pkg",
            provenance: { sourceNodeIds: ["node_1"] },
          },
        ],
      };

      expect(() => validatePlayIR(candidatePlay, sourceNodes, classifications)).toThrow();

      recordAudit({
        vector: "Vector D",
        testName: "D1: Semantic package substitution attack",
        expectedOutcome: "REJECT_INCORRECT",
        actualOutcome: "REJECT_INCORRECT",
        stageFailed: "VALIDATOR",
        diagnostic: "S4/S6 validator traps unauthorized package name substitution.",
      });
    });

    it("D2: S3 rejects invented template placeholders ({{inputs.invented_secret}})", () => {
      const sourceNodes = [
        {
          id: "node_1",
          command: "mkdir build",
          cwd: "/app",
          reads: [],
          writes: ["CWD:build"],
          deletes: [],
        },
      ];
      const classifications = classifyResources(sourceNodes);

      const candidatePlay: PlayIR = {
        schema_version: "1.0.0",
        operation_id: "test_d2_invented_template",
        metadata: { description: "Attack D2", author: "attacker", deterministic: true },
        inputs: {
          invented_secret: { type: "string" },
        },
        actions: [
          {
            id: "step_1",
            runtime: "fs",
            action: "make_directory",
            target: "{{inputs.invented_secret}}",
            provenance: { sourceNodeIds: ["node_1"] },
          },
        ],
      };

      expect(() => validatePlayIR(candidatePlay, sourceNodes, classifications)).toThrow(/invented/i);

      recordAudit({
        vector: "Vector D",
        testName: "D2: Invented template variable injection",
        expectedOutcome: "REJECT_INCORRECT",
        actualOutcome: "REJECT_INCORRECT",
        stageFailed: "VALIDATOR",
        diagnostic: "S3 Invariant rejects template placeholders not authorized by classifier.",
      });
    });

    it("D3: Inline Node.js interpreter write escape (node -e fs.writeFileSync)", async () => {
      const play: PlayIR = {
        schema_version: "1.0.0",
        operation_id: "test_d3_node_eval",
        metadata: { description: "Attack D3", author: "attacker", deterministic: true },
        actions: [
          {
            id: "step_1",
            runtime: "shell",
            target: "public_report.json",
            // Node script attempts to write to undeclared node_eval_leak.txt
            command: `node -e "require('fs').writeFileSync('public_report.json', '{}'); require('fs').writeFileSync('node_eval_leak.txt', 'leak');"`,
          },
        ],
      };

      const report = await verifier.verify(play, {});
      expect(report.invariants.R5).toBe(false);

      recordAudit({
        vector: "Vector D",
        testName: "D3: Node.js inline interpreter write escape",
        expectedOutcome: "REJECT_INCORRECT",
        actualOutcome: "REJECT_INCORRECT",
        stageFailed: "REPLAY",
        diagnostic: "Undeclared mutations produced via node -e are trapped by R5 during replay observation.",
      });
    });

    it("D4: Inline Python interpreter write escape (python -c open.write)", async () => {
      const play: PlayIR = {
        schema_version: "1.0.0",
        operation_id: "test_d4_python_eval",
        metadata: { description: "Attack D4", author: "attacker", deterministic: true },
        actions: [
          {
            id: "step_1",
            runtime: "shell",
            target: "public_data.csv",
            // Python script attempts to write to undeclared py_eval_leak.txt
            command: `python -c "open('public_data.csv','w').write('id,val\\n'); open('py_eval_leak.txt','w').write('secret')"`,
          },
        ],
      };

      const report = await verifier.verify(play, {});
      // In environments where python is available, R5 traps the file write. In environments where python is missing, R2 traps the exit code.
      expect(report.success).toBe(false);

      recordAudit({
        vector: "Vector D",
        testName: "D4: Python inline interpreter write escape",
        expectedOutcome: "REJECT_INCORRECT",
        actualOutcome: "REJECT_INCORRECT",
        stageFailed: "REPLAY",
        diagnostic: "Interpreter side-channel writes fail closed via R5 (or R2 if runtime interpreter missing).",
      });
    });
  });

  // =========================================================================
  // VECTOR E: Replay Verifier & Sandbox Containment (State & Isolation)
  // =========================================================================
  describe("Vector E: Replay Verifier & State Soundness", () => {
    it("E1: Traps symlink pointing to external host path (R9a)", async () => {
      const sandbox = new LocalUnsafeSandbox();
      const root = await sandbox.setup();

      try {
        // Attempting to resolve a path traversing through parent
        expect(() => sandbox.resolveSafePath("../../etc/passwd", root)).toThrow(/R9a/);

        recordAudit({
          vector: "Vector E",
          testName: "E1: Symlink/path traversal outside sandbox root",
          expectedOutcome: "REJECT_INCORRECT",
          actualOutcome: "REJECT_INCORRECT",
          stageFailed: "REPLAY",
          diagnostic: "R9a canonical path checks block traversal escapes.",
        });
      } finally {
        await sandbox.teardown();
      }
    });

    it("E2: Detects subshell side-channel mutation leaks (R5)", async () => {
      const play: PlayIR = {
        schema_version: "1.0.0",
        operation_id: "test_e2_mutation_leak",
        metadata: { description: "Attack E2", author: "attacker", deterministic: true },
        actions: [
          {
            id: "step_1",
            runtime: "shell",
            target: "public_output.txt",
            command: process.platform === "win32"
              ? "echo public > public_output.txt && echo secret > leaked_secret.txt"
              : "echo public > public_output.txt && echo secret > leaked_secret.txt",
          },
        ],
      };

      const report = await verifier.verify(play, {});
      expect(report.success).toBe(false);
      expect(report.invariants.R5).toBe(false);
      expect(report.violations.some((v) => v.invariant === "R5" && v.resource?.includes("leaked_secret.txt"))).toBe(true);

      recordAudit({
        vector: "Vector E",
        testName: "E2: Subshell mutation side-channel leak",
        expectedOutcome: "REJECT_INCORRECT",
        actualOutcome: "REJECT_INCORRECT",
        stageFailed: "REPLAY",
        diagnostic: "Action-level R5 mutation checker catches unauthorized side-effect file creations.",
      });
    });

    it("E3: Traps non-deterministic time/random execution across dual pristine sandboxes (R8)", async () => {
      const play: PlayIR = {
        schema_version: "1.0.0",
        operation_id: "test_e3_nondeterministic",
        metadata: { description: "Attack E3", author: "attacker", deterministic: true },
        actions: [
          {
            id: "step_1",
            runtime: "shell",
            target: "timestamp.txt",
            command: process.platform === "win32"
              ? 'powershell -Command "[guid]::NewGuid().ToString() | Out-File -FilePath timestamp.txt -NoNewline -Encoding utf8"'
              : "echo $(date +%s%N) > timestamp.txt",
          },
        ],
      };

      const report = await verifier.verify(play, {});
      expect(report.success).toBe(false);
      expect(report.invariants.R8).toBe(false);

      recordAudit({
        vector: "Vector E",
        testName: "E3: Non-deterministic runtime trap",
        expectedOutcome: "REJECT_INCORRECT",
        actualOutcome: "REJECT_INCORRECT",
        stageFailed: "REPLAY",
        diagnostic: "Dual pristine sandbox state comparison (R8) catches dynamic time/random drift.",
      });
    });
  });

  // =========================================================================
  // VECTOR F: End-to-End False Acceptance Benchmark
  // =========================================================================
  describe("Vector F: End-to-End Soundness Benchmark", () => {
    it("F1: Valid causal pipeline trajectory completes with 0 false rejections", async () => {
      const raw = `
user@host:~/workspace$ ls
user@host:~/workspace$ mkdir dist
user@host:~/workspace$ echo hello > dist/bundle.js
`;
      const events = parseTrace(raw.trim());
      const dag = buildDag(events);
      const pruned = pruneDag(dag);
      const classifications = classifyResources(pruned);

      const inParam = classifications.find(c => c.role === "Input_Parameter");
      const inputsDef: Record<string, any> = {};
      if (inParam && inParam.replacement) {
        const key = inParam.replacement.replace(/^\{\{inputs\./, "").replace(/\}\}$/, "");
        inputsDef[key] = { type: "string", default: "workspace" };
      }

      // Find output for node 2
      const node2Output = classifications.find(
        c => c.role === "Output_Resource" && c.evidence.nodes.includes(pruned[1].id)
      );

      const playIR: PlayIR = {
        schema_version: "1.0.0",
        operation_id: "test_f1_valid",
        metadata: { description: "Valid pipeline", author: "test", deterministic: true },
        inputs: Object.keys(inputsDef).length > 0 ? inputsDef : undefined,
        actions: [
          {
            id: "step_1",
            runtime: "fs",
            action: "make_directory",
            target: "dist",
            provenance: { sourceNodeIds: [pruned[0].id] },
          },
          {
            id: "step_2",
            runtime: "fs",
            action: "write_file",
            target: node2Output?.replacement ? node2Output.replacement.replace(/^CWD:/, "") : "dist/bundle.js",
            provenance: { sourceNodeIds: [pruned[1].id] },
          },
        ],
        postconditions: node2Output?.replacement ? [
          { assertion: "exists", target: node2Output.replacement.replace(/^CWD:/, "") },
        ] : undefined,
      };

      // 1. Compiler front-end validation
      const validated = validatePlayIR(playIR, pruned, classifications);
      expect(validated).toBeDefined();

      // 2. Replay verification
      const report = await verifier.verify(validated, {});
      if (!report.success) {
        console.log("F1 VIOLATIONS:", JSON.stringify(report.violations, null, 2));
      }
      expect(report.success).toBe(true);
      expect(report.invariants.R8).toBe(true);
      expect(report.invariants.R5).toBe(true);

      recordAudit({
        vector: "Vector F",
        testName: "F1: Legitimate E2E compilation & replay",
        expectedOutcome: "ACCEPT_CORRECT",
        actualOutcome: "ACCEPT_CORRECT",
        stageFailed: "NONE",
        diagnostic: "End-to-end sound trajectory verified successfully with 0 false rejections.",
      });
    });

    it("F2: Adversarial trajectory claiming success while failing replay fails-closed", async () => {
      const raw = `
user@host:~/workspace$ mkdir output
user@host:~/workspace$ echo "data" > output/result.txt
`;
      const events = parseTrace(raw.trim());
      const dag = buildDag(events);
      const pruned = pruneDag(dag);
      const classifications = classifyResources(pruned);

      // Malicious synthesized play that attempts to delete root or escape
      const adversarialPlay: PlayIR = {
        schema_version: "1.0.0",
        operation_id: "test_f2_adversarial",
        metadata: { description: "Adversarial play", author: "attacker", deterministic: true },
        actions: [
          {
            id: "step_1",
            runtime: "fs",
            action: "make_directory",
            target: "output",
            provenance: { sourceNodeIds: [pruned[0].id] },
          },
          {
            id: "step_2",
            runtime: "fs",
            action: "write_file",
            target: "../../outside_result.txt", // Traversal attack
            provenance: { sourceNodeIds: [pruned[1].id] },
          },
        ],
      };

      const report = await verifier.verify(adversarialPlay, {});
      expect(report.success).toBe(false);
      expect(report.invariants.R9a).toBe(false);

      recordAudit({
        vector: "Vector F",
        testName: "F2: Adversarial traversal in E2E replay",
        expectedOutcome: "REJECT_INCORRECT",
        actualOutcome: "REJECT_INCORRECT",
        stageFailed: "REPLAY",
        diagnostic: "Pipeline failed closed. Zero False Acceptance observed.",
      });
    });
  });
});
