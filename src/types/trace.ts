import { z } from "zod";

export const FSMutationSchema = z.object({
  path: z.string(),
  action: z.enum(["CREATE", "MODIFY", "DELETE"]),
  byteSize: z.number().optional(),
});

export const TraceEventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  command: z.string(),
  cwd: z.string(),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  fsMutations: z.array(FSMutationSchema),
});

export type FSMutation = z.infer<typeof FSMutationSchema>;
export type TraceEvent = z.infer<typeof TraceEventSchema>;
