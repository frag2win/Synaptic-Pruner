import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import { StateSnapshot, ResourceState, StateDiff, ResourceKind } from "../types/verification";

export class StateObserver {
  static async captureSnapshot(rootDir: string): Promise<StateSnapshot> {
    const resources = new Map<string, ResourceState>();

    const traverse = async (currentDir: string) => {
      let entries: string[] = [];
      try {
        entries = await fs.readdir(currentDir);
      } catch (e) {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry);
        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, "/");

        try {
          const stat = await fs.lstat(fullPath);

          if (stat.isSymbolicLink()) {
            const linkTarget = await fs.readlink(fullPath);
            resources.set(relPath, {
              path: relPath,
              kind: "symlink",
              linkTarget: linkTarget.replace(/\\/g, "/"),
            });
            // CRITICAL: Do NOT recurse into symlinks
          } else if (stat.isDirectory()) {
            resources.set(relPath, {
              path: relPath,
              kind: "directory",
            });
            await traverse(fullPath);
          } else if (stat.isFile()) {
            const content = await fs.readFile(fullPath);
            const sha256 = crypto.createHash("sha256").update(content).digest("hex");
            resources.set(relPath, {
              path: relPath,
              kind: "file",
              size: stat.size,
              sha256,
            });
          }
        } catch (err) {
          // If a file was deleted during snapshot or inaccessible, skip gracefully
        }
      }
    };

    await traverse(rootDir);

    // Compute deterministic treeHash (independent of root dir and timestamp)
    const sortedKeys = Array.from(resources.keys()).sort();
    const hashLines: string[] = [];

    for (const key of sortedKeys) {
      const res = resources.get(key)!;
      hashLines.push(
        `${res.path}|${res.kind}|${res.size ?? 0}|${res.sha256 ?? ""}|${res.linkTarget ?? ""}`
      );
    }

    const treeHash = crypto
      .createHash("sha256")
      .update(hashLines.join("\n"))
      .digest("hex");

    return {
      timestamp: Date.now(),
      resources,
      treeHash,
    };
  }

  static diffSnapshots(before: StateSnapshot, after: StateSnapshot): StateDiff {
    const created: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const [key, afterRes] of after.resources.entries()) {
      const beforeRes = before.resources.get(key);
      if (!beforeRes) {
        created.push(key);
      } else {
        if (
          beforeRes.kind !== afterRes.kind ||
          beforeRes.sha256 !== afterRes.sha256 ||
          beforeRes.size !== afterRes.size ||
          beforeRes.linkTarget !== afterRes.linkTarget
        ) {
          modified.push(key);
        }
      }
    }

    for (const key of before.resources.keys()) {
      if (!after.resources.has(key)) {
        deleted.push(key);
      }
    }

    return {
      created: created.sort(),
      modified: modified.sort(),
      deleted: deleted.sort(),
    };
  }
}
