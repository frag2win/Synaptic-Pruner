import * as fs from "fs/promises";
import * as path from "path";
import { PlayIR, PlayIRAction } from "../types/playIR";
import {
  VerificationReport,
  ReplayRun,
  VerificationViolation,
  ActionResult,
  StateSnapshot,
} from "../types/verification";
import { StateObserver } from "./stateObserver";
import {
  ISandboxBackend,
  LocalUnsafeSandbox,
  ExecutionContext,
} from "./sandbox";

export class ReplayVerifier {
  private backendFactory: () => ISandboxBackend;

  constructor(backendFactory?: () => ISandboxBackend) {
    this.backendFactory = backendFactory || (() => new LocalUnsafeSandbox());
  }

  /**
   * Main verification entry point: runs Dual Pristine Sandbox verification (R8)
   * and aggregates all invariants R1..R9b into a VerificationReport.
   */
  async verify(
    play: PlayIR,
    inputBindings: Record<string, string> = {}
  ): Promise<VerificationReport> {
    const startTime = Date.now();
    const violations: VerificationViolation[] = [];

    // 1. Execute Run A in a pristine sandbox
    const backendA = this.backendFactory();
    const runA = await this.runOnce(play, inputBindings, backendA);
    violations.push(...runA.violations);

    // If Run A failed catastrophic invariants (e.g. R1, R6, R9a), skip Run B to avoid redundant work
    if (!runA.invariants.R1 || !runA.invariants.R6 || !runA.invariants.R9a) {
      const invariants = {
        R1: runA.invariants.R1,
        R2: runA.invariants.R2,
        R3: runA.invariants.R3,
        R4: runA.invariants.R4,
        R5: runA.invariants.R5,
        R6: runA.invariants.R6,
        R7: runA.invariants.R7,
        R8: false,
        R9a: runA.invariants.R9a,
        R9b: runA.invariants.R9b,
      };
      return {
        success: false,
        durationMs: Date.now() - startTime,
        invariants,
        actions: runA.actions,
        initialState: runA.initialState,
        finalState: runA.finalState,
        diff: runA.diff,
        runA,
        violations,
      };
    }

    // 2. Execute Run B in a separate pristine sandbox for Deterministic Replay (R8)
    const backendB = this.backendFactory();
    const runB = await this.runOnce(play, inputBindings, backendB);
    violations.push(...runB.violations);

    // 3. Compare terminal state hashes across Sandbox A and Sandbox B (R8)
    let r8Passed = false;
    if (runA.finalState && runB.finalState) {
      if (runA.finalState.treeHash === runB.finalState.treeHash) {
        r8Passed = true;
      } else {
        violations.push({
          invariant: "R8",
          message: `Non-deterministic terminal state detected. Sandbox A hash (${runA.finalState.treeHash}) != Sandbox B hash (${runB.finalState.treeHash}).`,
        });
      }
    } else {
      violations.push({
        invariant: "R8",
        message: "Could not compare terminal state hashes because execution failed before terminal snapshot.",
      });
    }

    const invariants = {
      R1: runA.invariants.R1 && runB.invariants.R1,
      R2: runA.invariants.R2 && runB.invariants.R2,
      R3: runA.invariants.R3 && runB.invariants.R3,
      R4: runA.invariants.R4 && runB.invariants.R4,
      R5: runA.invariants.R5 && runB.invariants.R5,
      R6: runA.invariants.R6 && runB.invariants.R6,
      R7: runA.invariants.R7 && runB.invariants.R7,
      R8: r8Passed,
      R9a: runA.invariants.R9a && runB.invariants.R9a,
      R9b: runA.invariants.R9b && runB.invariants.R9b,
    };

    const success =
      invariants.R1 &&
      invariants.R2 &&
      invariants.R3 &&
      invariants.R4 &&
      invariants.R5 &&
      invariants.R6 &&
      invariants.R7 &&
      invariants.R8 &&
      invariants.R9a &&
      invariants.R9b;

    return {
      success,
      durationMs: Date.now() - startTime,
      invariants,
      actions: runA.actions,
      initialState: runA.initialState,
      finalState: runA.finalState,
      diff: runA.diff,
      runA,
      runB,
      violations,
    };
  }

  /**
   * Reusable single-run execution engine.
   * Guarantees fresh sandbox setup, baseline snapshot, precondition checking,
   * sequential action execution with mutation tracking, terminal snapshot,
   * postcondition checking, and guaranteed teardown.
   */
  async runOnce(
    play: PlayIR,
    inputBindings: Record<string, string>,
    backend: ISandboxBackend
  ): Promise<ReplayRun> {
    const violations: VerificationViolation[] = [];
    const actions: ActionResult[] = [];
    const cumulativeMutations = new Set<string>();

    let r1 = true;
    let r2 = true;
    let r3 = true;
    let r4 = true;
    let r5 = true;
    let r6 = true;
    let r7 = true;
    let r9a = true;
    let r9b = true;

    let sandboxRoot = "";
    let initialSnapshot: StateSnapshot = {
      timestamp: Date.now(),
      resources: new Map(),
      treeHash: "",
    };
    let finalSnapshot: StateSnapshot = initialSnapshot;

    try {
      sandboxRoot = await backend.setup();

      // --- R1: Input Binding Check ---
      const boundInputs: Record<string, string> = {};
      const declaredInputs = play.inputs || {};

      for (const [inputKey, inputDef] of Object.entries(declaredInputs)) {
        if (inputKey in inputBindings && inputBindings[inputKey] !== "") {
          boundInputs[inputKey] = inputBindings[inputKey];
        } else if (inputDef.default !== undefined) {
          boundInputs[inputKey] = inputDef.default;
        } else if (inputDef.required !== false) {
          r1 = false;
          violations.push({
            invariant: "R1",
            resource: inputKey,
            message: `Required input '${inputKey}' was not supplied and has no default value.`,
          });
        }
      }

      // Check for input-bound path escapes (R9a check on inputs)
      for (const [key, val] of Object.entries(boundInputs)) {
        // If input looks like a relative path with traversal or absolute host path
        if (
          val.includes("..") ||
          /^[\\/]{2}/.test(val) ||
          (path.isAbsolute(val) && !val.startsWith(sandboxRoot))
        ) {
          // Check if resolving it escapes
          try {
            backend.resolveSafePath(val, sandboxRoot);
          } catch (e: any) {
            r9a = false;
            violations.push({
              invariant: "R9a",
              resource: key,
              message: `Input '${key}' value '${val}' violates path containment: ${e.message}`,
            });
          }
        }
      }

      // Capture Baseline Initial Snapshot
      initialSnapshot = await StateObserver.captureSnapshot(sandboxRoot);
      let previousSnapshot = initialSnapshot;

      // --- R6: Precondition Evaluation ---
      if (play.preconditions && play.preconditions.length > 0) {
        for (const pre of play.preconditions) {
          const resolvedTarget = this.interpolate(pre.target, boundInputs, sandboxRoot);
          let safePath = "";
          try {
            safePath = backend.resolveSafePath(resolvedTarget, sandboxRoot);
          } catch (e: any) {
            r9a = false;
            violations.push({
              invariant: "R9a",
              message: `Precondition target '${pre.target}' failed path safety: ${e.message}`,
            });
            continue;
          }

          const exists = await this.pathExists(safePath);
          if (pre.assertion === "exists" && !exists) {
            r6 = false;
            violations.push({
              invariant: "R6",
              resource: pre.target,
              message: `Precondition 'exists' failed for target '${pre.target}' (resolved: '${safePath}').`,
            });
          } else if (pre.assertion === "is_directory") {
            const isDir = exists && (await fs.lstat(safePath)).isDirectory();
            if (!isDir) {
              r6 = false;
              violations.push({
                invariant: "R6",
                resource: pre.target,
                message: `Precondition 'is_directory' failed for target '${pre.target}'.`,
              });
            }
          } else if (pre.assertion === "is_file") {
            const isFile = exists && (await fs.lstat(safePath)).isFile();
            if (!isFile) {
              r6 = false;
              violations.push({
                invariant: "R6",
                resource: pre.target,
                message: `Precondition 'is_file' failed for target '${pre.target}'.`,
              });
            }
          }
        }
      }

      // If R1, R6, or R9a failed before execution, abort actions
      if (!r1 || !r6 || !r9a) {
        finalSnapshot = await StateObserver.captureSnapshot(sandboxRoot);
        return {
          sandboxId: sandboxRoot,
          success: false,
          invariants: { R1: r1, R2: r2, R3: r3, R4: r4, R5: r5, R6: r6, R7: r7, R9a: r9a, R9b: r9b },
          actions,
          initialState: initialSnapshot,
          finalState: finalSnapshot,
          diff: StateObserver.diffSnapshots(initialSnapshot, finalSnapshot),
          cumulativeMutations,
          violations,
        };
      }

      // --- R2, R3, R5, R9a: Sequential Action Execution ---
      const context: ExecutionContext = {
        sandboxRoot,
        cwd: sandboxRoot,
        env: {},
        timeoutMs: 10000,
        network: play.safety_boundary?.network_access ? "allowed" : "none",
      };

      for (let idx = 0; idx < play.actions.length; idx++) {
        const action = play.actions[idx];
        const interpolatedTarget = action.target
          ? this.interpolate(action.target, boundInputs, sandboxRoot)
          : undefined;
        const interpolatedCommand = action.command
          ? this.interpolate(action.command, boundInputs, sandboxRoot)
          : undefined;

        // R9a check on interpolated target
        if (interpolatedTarget) {
          try {
            backend.resolveSafePath(interpolatedTarget, sandboxRoot);
          } catch (e: any) {
            r9a = false;
            violations.push({
              invariant: "R9a",
              actionIndex: idx,
              actionId: action.id,
              resource: interpolatedTarget,
              message: `Action '${action.id}' target violates path containment: ${e.message}`,
            });
            r2 = false;
            break;
          }
        }

        // Execute step
        const result = await backend.executeAction(
          action,
          context,
          interpolatedTarget,
          interpolatedCommand
        );

        // Capture step snapshot & delta
        const currentSnapshot = await StateObserver.captureSnapshot(sandboxRoot);
        const stepDiff = StateObserver.diffSnapshots(previousSnapshot, currentSnapshot);
        const stepMutations = [...stepDiff.created, ...stepDiff.modified, ...stepDiff.deleted];

        result.mutationsObserved = stepMutations;
        for (const m of stepMutations) {
          cumulativeMutations.add(m);
        }
        actions.push(result);

        // Check R2: Step success
        if (result.exitCode !== 0 || result.error) {
          r2 = false;
          violations.push({
            invariant: "R2",
            actionIndex: idx,
            actionId: action.id,
            message: `Action '${action.id}' failed with exit code ${result.exitCode}: ${result.stderr || result.error}`,
          });
          // Abort further actions to preserve causal progression failure
          break;
        }

        // --- R5: Action-Level Authorized Mutation Check ---
        // Derive authorized relative mutation targets for this specific action
        const actionAuthorizedPaths = this.deriveActionAuthorizedPaths(
          action,
          boundInputs,
          sandboxRoot,
          play
        );

        for (const mutation of stepMutations) {
          const isAuthorized = actionAuthorizedPaths.some((auth) =>
            mutation === auth ||
            mutation.startsWith(auth + "/") ||
            auth.startsWith(mutation + "/")
          );

          if (!isAuthorized) {
            r5 = false;
            violations.push({
              invariant: "R5",
              actionIndex: idx,
              actionId: action.id,
              resource: mutation,
              message: `Action '${action.id}' produced unauthorized mutation on '${mutation}'.`,
            });
          }
        }

        previousSnapshot = currentSnapshot;
      }

      // Capture Final Terminal Snapshot
      finalSnapshot = await StateObserver.captureSnapshot(sandboxRoot);

      // --- R7: Postcondition Evaluation ---
      if (play.postconditions && play.postconditions.length > 0) {
        for (const post of play.postconditions) {
          const resolvedTarget = this.interpolate(post.target, boundInputs, sandboxRoot);
          let safePath = "";
          try {
            safePath = backend.resolveSafePath(resolvedTarget, sandboxRoot);
          } catch (e: any) {
            r9a = false;
            violations.push({
              invariant: "R9a",
              message: `Postcondition target '${post.target}' failed path safety: ${e.message}`,
            });
            continue;
          }

          const exists = await this.pathExists(safePath);
          if (post.assertion === "exists" && !exists) {
            r7 = false;
            violations.push({
              invariant: "R7",
              resource: post.target,
              message: `Postcondition 'exists' failed for target '${post.target}' (resolved: '${safePath}').`,
            });
          } else if (post.assertion === "is_directory") {
            const isDir = exists && (await fs.lstat(safePath)).isDirectory();
            if (!isDir) {
              r7 = false;
              violations.push({
                invariant: "R7",
                resource: post.target,
                message: `Postcondition 'is_directory' failed for target '${post.target}'.`,
              });
            }
          } else if (post.assertion === "is_file") {
            const isFile = exists && (await fs.lstat(safePath)).isFile();
            if (!isFile) {
              r7 = false;
              violations.push({
                invariant: "R7",
                resource: post.target,
                message: `Postcondition 'is_file' failed for target '${post.target}'.`,
              });
            }
          }
        }
      }

      // --- R4: Declared Outputs Produced Check ---
      // Verify that every declared output resource exists in final snapshot
      const declaredOutputs = this.extractDeclaredOutputs(play, boundInputs, sandboxRoot);
      for (const outRel of declaredOutputs) {
        if (!finalSnapshot.resources.has(outRel)) {
          r4 = false;
          violations.push({
            invariant: "R4",
            resource: outRel,
            message: `Declared output resource '${outRel}' was not produced in terminal state.`,
          });
        }
      }
    } catch (err: any) {
      violations.push({
        invariant: "R2",
        message: `Unexpected execution failure in sandbox: ${err.message || String(err)}`,
      });
      r2 = false;
    } finally {
      // Guaranteed teardown
      await backend.teardown();
    }

    const runSuccess = r1 && r2 && r3 && r4 && r5 && r6 && r7 && r9a && r9b;
    const diff = StateObserver.diffSnapshots(initialSnapshot, finalSnapshot);

    return {
      sandboxId: sandboxRoot,
      success: runSuccess,
      invariants: {
        R1: r1,
        R2: r2,
        R3: r3,
        R4: r4,
        R5: r5,
        R6: r6,
        R7: r7,
        R9a: r9a,
        R9b: r9b,
      },
      actions,
      initialState: initialSnapshot,
      finalState: finalSnapshot,
      diff,
      cumulativeMutations,
      violations,
    };
  }

  private interpolate(
    str: string,
    inputs: Record<string, string>,
    sandboxRoot: string
  ): string {
    let result = str;
    for (const [key, val] of Object.entries(inputs)) {
      result = result.replace(new RegExp(`\\{\\{inputs\\.${key}\\}\\}`, "g"), val);
    }
    // Also replace {{inputs.cwd}} with sandboxRoot
    result = result.replace(/\{\{inputs\.cwd\}\}/g, sandboxRoot);
    // Replace {{local.xxx}} and {{outputs.xxx}} with clean relative names if referenced
    result = result.replace(/\{\{local\.([^}]+)\}\}/g, "$1");
    result = result.replace(/\{\{outputs\.([^}]+)\}\}/g, "$1");
    return result;
  }

  private deriveActionAuthorizedPaths(
    action: PlayIRAction,
    inputs: Record<string, string>,
    sandboxRoot: string,
    play?: PlayIR
  ): string[] {
    const authorized = new Set<string>();

    if (action.target) {
      const interp = this.interpolate(action.target, inputs, sandboxRoot);
      const rel = path.isAbsolute(interp)
        ? path.relative(sandboxRoot, interp).replace(/\\/g, "/")
        : interp.replace(/\\/g, "/");
      if (rel && !rel.startsWith("..")) {
        authorized.add(rel);
      }
    }

    // Extract template targets from action (e.g. {{local.tmp_1}} or {{outputs.result_1}})
    const actionStr = JSON.stringify(action);
    const tmplMatches = actionStr.match(/\{\{(local|outputs)\.([^}]+)\}\}/g);
    if (tmplMatches) {
      for (const tmpl of tmplMatches) {
        const cleanName = tmpl.replace(/^\{\{(local|outputs)\./, "").replace(/\}\}$/, "");
        authorized.add(cleanName);
      }
    }

    // Allowed write paths from safety boundary
    if (play?.safety_boundary?.allowed_write_paths) {
      for (const p of play.safety_boundary.allowed_write_paths) {
        const interp = this.interpolate(p, inputs, sandboxRoot);
        const rel = path.isAbsolute(interp)
          ? path.relative(sandboxRoot, interp).replace(/\\/g, "/")
          : interp.replace(/\\/g, "/");
        if (rel && !rel.startsWith("..")) {
          authorized.add(rel);
        }
      }
    }

    return Array.from(authorized);
  }

  private extractDeclaredOutputs(
    play: PlayIR,
    inputs: Record<string, string>,
    sandboxRoot: string
  ): string[] {
    const outputs = new Set<string>();

    if (play.postconditions) {
      for (const p of play.postconditions) {
        const interp = this.interpolate(p.target, inputs, sandboxRoot);
        const rel = path.isAbsolute(interp)
          ? path.relative(sandboxRoot, interp).replace(/\\/g, "/")
          : interp.replace(/\\/g, "/");
        if (rel && !rel.startsWith("..")) {
          outputs.add(rel);
        }
      }
    }

    return Array.from(outputs);
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.lstat(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
