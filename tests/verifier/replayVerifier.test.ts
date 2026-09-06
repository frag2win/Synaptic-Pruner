import { describe, it, expect } from "vitest";
import { ReplayVerifier } from "../../src/verifier/replayVerifier";
import { PlayIR } from "../../src/types/playIR";

describe("Problem #4: ReplayVerifier Invariant Suite", () => {
  const verifier = new ReplayVerifier();

  it("R1: should fail when a required input parameter is not supplied", async () => {
    const play: PlayIR = {
      schema_version: "1.0.0",
      operation_id: "test_r1_missing_input",
      metadata: { description: "Test R1", author: "test", deterministic: true },
      inputs: {
        config_name: { type: "string", required: true },
      },
      actions: [
        {
          id: "step_1",
          runtime: "fs",
          action: "make_directory",
          target: "build",
        },
      ],
    };

    const report = await verifier.verify(play, {});
    expect(report.success).toBe(false);
    expect(report.invariants.R1).toBe(false);
    expect(report.violations.some((v) => v.invariant === "R1")).toBe(true);
  });

  it("R1: should pass when an optional input uses its default value", async () => {
    const play: PlayIR = {
      schema_version: "1.0.0",
      operation_id: "test_r1_default_input",
      metadata: { description: "Test R1 default", author: "test", deterministic: true },
      inputs: {
        dir_name: { type: "string", required: false, default: "default_dir" },
      },
      actions: [
        {
          id: "step_1",
          runtime: "fs",
          action: "make_directory",
          target: "{{inputs.dir_name}}",
        },
      ],
    };

    const report = await verifier.verify(play, {});
    expect(report.invariants.R1).toBe(true);
    expect(report.success).toBe(true);
  });

  it("R2 & R3: should fail and abort when an action execution errors", async () => {
    const play: PlayIR = {
      schema_version: "1.0.0",
      operation_id: "test_r2_action_failure",
      metadata: { description: "Test R2", author: "test", deterministic: true },
      actions: [
        {
          id: "step_1",
          runtime: "shell",
          command: "exit 1",
        },
        {
          id: "step_2",
          runtime: "fs",
          action: "make_directory",
          target: "unreached_step",
        },
      ],
    };

    const report = await verifier.verify(play, {});
    expect(report.success).toBe(false);
    expect(report.invariants.R2).toBe(false);
    expect(report.actions.length).toBe(1);
    expect(report.actions[0].actionId).toBe("step_1");
  });

  it("R4: should verify that declared outputs exist in the terminal state", async () => {
    const playPassing: PlayIR = {
      schema_version: "1.0.0",
      operation_id: "test_r4_pass",
      metadata: { description: "Test R4 pass", author: "test", deterministic: true },
      actions: [
        {
          id: "step_1",
          runtime: "fs",
          action: "write_file",
          target: "output.txt",
        },
      ],
      postconditions: [
        { assertion: "exists", target: "output.txt" },
      ],
    };

    const reportPass = await verifier.verify(playPassing, {});
    expect(reportPass.invariants.R4).toBe(true);
    expect(reportPass.success).toBe(true);

    const playFailing: PlayIR = {
      schema_version: "1.0.0",
      operation_id: "test_r4_fail",
      metadata: { description: "Test R4 fail", author: "test", deterministic: true },
      actions: [
        {
          id: "step_1",
          runtime: "fs",
          action: "make_directory",
          target: "other_dir",
        },
      ],
      postconditions: [
        { assertion: "exists", target: "missing_output.txt" },
      ],
    };

    const reportFail = await verifier.verify(playFailing, {});
    expect(reportFail.invariants.R4).toBe(false);
    expect(reportFail.success).toBe(false);
  });

  it("R5: should allow authorized transient locals created and deleted within execution", async () => {
    const play: PlayIR = {
      schema_version: "1.0.0",
      operation_id: "test_r5_transient_local",
      metadata: { description: "Test R5 transient", author: "test", deterministic: true },
      actions: [
        {
          id: "step_1",
          runtime: "fs",
          action: "write_file",
          target: "temp_local.tmp",
        },
        {
          id: "step_2",
          runtime: "fs",
          action: "delete_file",
          target: "temp_local.tmp",
        },
        {
          id: "step_3",
          runtime: "fs",
          action: "write_file",
          target: "final_result.txt",
        },
      ],
      postconditions: [
        { assertion: "exists", target: "final_result.txt" },
      ],
    };

    const report = await verifier.verify(play, {});
    expect(report.invariants.R5).toBe(true);
    expect(report.success).toBe(true);
    // Terminal diff only contains final_result.txt
    expect(report.diff?.created).toEqual(["final_result.txt"]);
  });

  it("R5: should fail when an action produces an unauthorized side-effect mutation", async () => {
    const play: PlayIR = {
      schema_version: "1.0.0",
      operation_id: "test_r5_unauthorized_mutation",
      metadata: { description: "Test R5 unauthorized", author: "test", deterministic: true },
      actions: [
        {
          id: "step_1",
          runtime: "shell",
          // Action claims target is allowed_target.txt, but command writes to unauthorized_leak.txt
          target: "allowed_target.txt",
          command: process.platform === "win32"
            ? "echo test > allowed_target.txt && echo leak > unauthorized_leak.txt"
            : "echo test > allowed_target.txt && echo leak > unauthorized_leak.txt",
        },
      ],
    };

    const report = await verifier.verify(play, {});
    expect(report.invariants.R5).toBe(false);
    expect(report.success).toBe(false);
    expect(report.violations.some((v) => v.invariant === "R5" && v.resource?.includes("unauthorized_leak.txt"))).toBe(true);
  });

  it("R6: should fail before action execution when precondition is unmet", async () => {
    const play: PlayIR = {
      schema_version: "1.0.0",
      operation_id: "test_r6_precondition_failure",
      metadata: { description: "Test R6", author: "test", deterministic: true },
      preconditions: [
        { assertion: "exists", target: "non_existent_input.json" },
      ],
      actions: [
        {
          id: "step_1",
          runtime: "fs",
          action: "make_directory",
          target: "data",
        },
      ],
    };

    const report = await verifier.verify(play, {});
    expect(report.success).toBe(false);
    expect(report.invariants.R6).toBe(false);
    expect(report.actions.length).toBe(0); // Actions were aborted before step 1
  });

  it("R7: should fail when postcondition assertion fails on terminal state", async () => {
    const play: PlayIR = {
      schema_version: "1.0.0",
      operation_id: "test_r7_postcondition_failure",
      metadata: { description: "Test R7", author: "test", deterministic: true },
      actions: [
        {
          id: "step_1",
          runtime: "fs",
          action: "write_file",
          target: "created_file.txt",
        },
      ],
      postconditions: [
        // Expects directory, but created a regular file
        { assertion: "is_directory", target: "created_file.txt" },
      ],
    };

    const report = await verifier.verify(play, {});
    expect(report.success).toBe(false);
    expect(report.invariants.R7).toBe(false);
  });

  it("R8: should pass deterministic replay across dual pristine sandboxes", async () => {
    const play: PlayIR = {
      schema_version: "1.0.0",
      operation_id: "test_r8_deterministic",
      metadata: { description: "Test R8 deterministic", author: "test", deterministic: true },
      actions: [
        {
          id: "step_1",
          runtime: "fs",
          action: "make_directory",
          target: "build/dist",
        },
        {
          id: "step_2",
          runtime: "fs",
          action: "write_file",
          target: "build/dist/index.js",
        },
      ],
      postconditions: [
        { assertion: "exists", target: "build/dist/index.js" },
      ],
    };

    const report = await verifier.verify(play, {});
    expect(report.invariants.R8).toBe(true);
    expect(report.success).toBe(true);
    expect(report.runA?.finalState.treeHash).toBe(report.runB?.finalState.treeHash);
  });

  it("R8: should fail when non-deterministic execution produces different terminal states across sandboxes", async () => {
    const play: PlayIR = {
      schema_version: "1.0.0",
      operation_id: "test_r8_nondeterministic",
      metadata: { description: "Test R8 non-deterministic", author: "test", deterministic: true },
      actions: [
        {
          id: "step_1",
          runtime: "shell",
          target: "random_output.txt",
          // Generates different content per run
          command: process.platform === "win32"
            ? 'powershell -Command "[guid]::NewGuid().ToString() | Out-File -FilePath random_output.txt -NoNewline -Encoding utf8"'
            : 'echo $(date +%s%N) > random_output.txt',
        },
      ],
      postconditions: [
        { assertion: "exists", target: "random_output.txt" },
      ],
    };

    const report = await verifier.verify(play, {});
    expect(report.invariants.R8).toBe(false);
    expect(report.success).toBe(false);
    expect(report.violations.some((v) => v.invariant === "R8")).toBe(true);
  });

  describe("R9a: Logical Path Containment", () => {
    it("should trap relative path traversal escapes (../)", async () => {
      const play: PlayIR = {
        schema_version: "1.0.0",
        operation_id: "test_r9a_traversal",
        metadata: { description: "Test R9a traversal", author: "test", deterministic: true },
        actions: [
          {
            id: "step_1",
            runtime: "fs",
            action: "write_file",
            target: "../../escaped_host.txt",
          },
        ],
      };

      const report = await verifier.verify(play, {});
      expect(report.success).toBe(false);
      expect(report.invariants.R9a).toBe(false);
      expect(report.violations.some((v) => v.invariant === "R9a")).toBe(true);
    });

    it("should trap absolute host path escapes", async () => {
      const play: PlayIR = {
        schema_version: "1.0.0",
        operation_id: "test_r9a_absolute",
        metadata: { description: "Test R9a absolute", author: "test", deterministic: true },
        actions: [
          {
            id: "step_1",
            runtime: "fs",
            action: "write_file",
            target: process.platform === "win32" ? "C:\\Windows\\escaped.txt" : "/tmp/escaped.txt",
          },
        ],
      };

      const report = await verifier.verify(play, {});
      expect(report.success).toBe(false);
      expect(report.invariants.R9a).toBe(false);
    });

    it("should trap UNC network share path escapes", async () => {
      const play: PlayIR = {
        schema_version: "1.0.0",
        operation_id: "test_r9a_unc",
        metadata: { description: "Test R9a UNC", author: "test", deterministic: true },
        actions: [
          {
            id: "step_1",
            runtime: "fs",
            action: "write_file",
            target: "\\\\server\\share\\file.txt",
          },
        ],
      };

      const report = await verifier.verify(play, {});
      expect(report.success).toBe(false);
      expect(report.invariants.R9a).toBe(false);
    });

    it("should trap input-bound path escapes (R1 + R9a boundary)", async () => {
      const play: PlayIR = {
        schema_version: "1.0.0",
        operation_id: "test_r9a_input_bound_escape",
        metadata: { description: "Test R9a input bound", author: "test", deterministic: true },
        inputs: {
          target_dir: { type: "string", required: true },
        },
        actions: [
          {
            id: "step_1",
            runtime: "fs",
            action: "make_directory",
            target: "{{inputs.target_dir}}/sub",
          },
        ],
      };

      // Supplying an input value that attempts path traversal
      const report = await verifier.verify(play, {
        target_dir: "../../escaped_dir",
      });

      expect(report.success).toBe(false);
      expect(report.invariants.R9a).toBe(false);
    });
  });
});
