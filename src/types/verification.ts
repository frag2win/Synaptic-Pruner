import { PlayIR } from "./playIR";

export type ResourceKind = "file" | "directory" | "symlink";

export interface ResourceState {
  path: string; // Relative path from sandbox root
  kind: ResourceKind;
  size?: number;
  sha256?: string;
  linkTarget?: string;
}

export interface StateSnapshot {
  timestamp: number;
  resources: Map<string, ResourceState>;
  treeHash: string;
}

export interface StateDiff {
  created: string[];
  modified: string[];
  deleted: string[];
}

export interface ActionResult {
  actionId: string;
  runtime: string;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  mutationsObserved: string[];
  error?: string;
}

export type InvariantName =
  | "R1"
  | "R2"
  | "R3"
  | "R4"
  | "R5"
  | "R6"
  | "R7"
  | "R8"
  | "R9a"
  | "R9b";

export interface VerificationViolation {
  invariant: InvariantName;
  actionIndex?: number;
  actionId?: string;
  nodeId?: string;
  resource?: string;
  message: string;
}

export interface ReplayRun {
  sandboxId: string;
  success: boolean;
  invariants: {
    R1: boolean;
    R2: boolean;
    R3: boolean;
    R4: boolean;
    R5: boolean;
    R6: boolean;
    R7: boolean;
    R9a: boolean;
    R9b: boolean;
  };
  actions: ActionResult[];
  initialState: StateSnapshot;
  finalState: StateSnapshot;
  diff: StateDiff;
  cumulativeMutations: Set<string>;
  violations: VerificationViolation[];
}

export interface VerificationReport {
  success: boolean;
  durationMs: number;
  invariants: {
    R1: boolean;
    R2: boolean;
    R3: boolean;
    R4: boolean;
    R5: boolean;
    R6: boolean;
    R7: boolean;
    R8: boolean;
    R9a: boolean;
    R9b: boolean;
  };
  actions: ActionResult[];
  initialState: StateSnapshot;
  finalState?: StateSnapshot;
  diff?: StateDiff;
  runA?: ReplayRun;
  runB?: ReplayRun;
  violations: VerificationViolation[];
}
