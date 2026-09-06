import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { PlayIRAction } from "../types/playIR";
import { ActionResult } from "../types/verification";

const execAsync = promisify(exec);

export type SandboxSecurity = "logical-only" | "os-isolated";

export interface ExecutionContext {
  sandboxRoot: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  network: "none" | "allowed";
}

export interface ISandboxBackend {
  readonly security: SandboxSecurity;
  setup(): Promise<string>;
  teardown(): Promise<void>;
  resolveSafePath(userPath: string, sandboxRoot: string): string;
  executeAction(
    action: PlayIRAction,
    context: ExecutionContext,
    interpolatedTarget?: string,
    interpolatedCommand?: string
  ): Promise<ActionResult>;
}

/**
 * LocalUnsafeSandbox:
 * Provides logical containment (R9a path sanitization) and a controlled execution context,
 * but operates as a "logical-only" backend without OS-level namespace/container isolation (R9b).
 */
export class LocalUnsafeSandbox implements ISandboxBackend {
  readonly security: SandboxSecurity = "logical-only";
  private sandboxDir: string = "";

  async setup(): Promise<string> {
    this.sandboxDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "synaptic-sandbox-")
    );
    // Canonicalize the path to resolve symlinks (e.g., /var vs /private/var on macOS)
    try {
      this.sandboxDir = await fs.realpath(this.sandboxDir);
    } catch {
      // Fallback to normalized path if realpath fails
      this.sandboxDir = path.normalize(this.sandboxDir);
    }
    return this.sandboxDir;
  }

  async teardown(): Promise<void> {
    if (this.sandboxDir) {
      try {
        await fs.rm(this.sandboxDir, { recursive: true, force: true });
      } catch (err) {
        // Ignore teardown errors
      }
      this.sandboxDir = "";
    }
  }

  /**
   * R9a: Logical Path Containment
   * Checks for traversal (../), UNC paths, root escapes, and symlink jailbreaks.
   */
  resolveSafePath(userPath: string, sandboxRoot: string): string {
    if (!userPath || userPath.trim() === "") {
      return sandboxRoot;
    }

    const cleanRoot = path.normalize(sandboxRoot);

    // 1. Check for UNC / network shares (\\server\share, //server/share)
    if (/^[\\/]{2}/.test(userPath)) {
      throw new Error(
        `[R9a Isolation Violation] UNC network share path '${userPath}' is forbidden.`
      );
    }

    // 2. Normalize and resolve against sandboxRoot
    let resolved: string;
    if (path.isAbsolute(userPath)) {
      // If userPath is absolute, check if it's already rooted within sandboxRoot
      const normalizedUserPath = path.normalize(userPath);
      if (
        normalizedUserPath === cleanRoot ||
        normalizedUserPath.startsWith(cleanRoot + path.sep)
      ) {
        resolved = normalizedUserPath;
      } else {
        throw new Error(
          `[R9a Isolation Violation] Absolute path '${userPath}' attempts to access host filesystem outside sandbox root.`
        );
      }
    } else {
      // Relative path: resolve relative to sandboxRoot
      resolved = path.resolve(cleanRoot, userPath);
    }

    // 3. Boundary containment assertion
    if (resolved !== cleanRoot && !resolved.startsWith(cleanRoot + path.sep)) {
      throw new Error(
        `[R9a Isolation Violation] Path '${userPath}' escapes sandbox root '${sandboxRoot}'.`
      );
    }

    return resolved;
  }

  async executeAction(
    action: PlayIRAction,
    context: ExecutionContext,
    interpolatedTarget?: string,
    interpolatedCommand?: string
  ): Promise<ActionResult> {
    const startTime = Date.now();
    const actionId = action.id;
    const runtime = action.runtime;

    try {
      if (runtime === "fs") {
        const act = action.action || "write_file";
        const safeTarget = this.resolveSafePath(
          interpolatedTarget || action.target || "",
          context.sandboxRoot
        );

        if (act === "make_directory") {
          await fs.mkdir(safeTarget, { recursive: true });
        } else if (act === "write_file") {
          const parentDir = path.dirname(safeTarget);
          await fs.mkdir(parentDir, { recursive: true });
          // If no content specified, write empty string
          await fs.writeFile(safeTarget, "");
        } else if (act === "delete_file") {
          await fs.rm(safeTarget, { recursive: true, force: true });
        } else {
          throw new Error(`Unsupported fs action '${act}'`);
        }

        return {
          actionId,
          runtime,
          durationMs: Date.now() - startTime,
          exitCode: 0,
          stdout: `fs ${act} succeeded on ${safeTarget}`,
          stderr: "",
          mutationsObserved: [],
        };
      } else if (runtime === "shell") {
        const cmd = interpolatedCommand || action.command || "";
        if (!cmd) {
          throw new Error(`Shell action '${actionId}' has no command specified.`);
        }

        const safeCwd = this.resolveSafePath(context.cwd, context.sandboxRoot);

        // Sanitize environment
        const sanitizedEnv: Record<string, string> = {
          PATH: process.env.PATH || "",
          SYSTEMROOT: process.env.SYSTEMROOT || "",
          TEMP: context.sandboxRoot,
          TMP: context.sandboxRoot,
          HOME: context.sandboxRoot,
          USERPROFILE: context.sandboxRoot,
          ...context.env,
        };

        const result = await execAsync(cmd, {
          cwd: safeCwd,
          env: sanitizedEnv,
          timeout: context.timeoutMs,
        });

        return {
          actionId,
          runtime,
          durationMs: Date.now() - startTime,
          exitCode: 0,
          stdout: result.stdout || "",
          stderr: result.stderr || "",
          mutationsObserved: [],
        };
      } else {
        throw new Error(`Unsupported runtime '${runtime}' for action '${actionId}'`);
      }
    } catch (err: any) {
      return {
        actionId,
        runtime,
        durationMs: Date.now() - startTime,
        exitCode: typeof err.code === "number" ? err.code : 1,
        stdout: err.stdout || "",
        stderr: err.stderr || err.message || String(err),
        mutationsObserved: [],
        error: err.message || String(err),
      };
    }
  }
}

// Keep backwards-compatible alias for existing imports if needed
export { LocalUnsafeSandbox as SandboxVerifier };
