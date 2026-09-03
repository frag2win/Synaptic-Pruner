import { z } from "zod";

export const ExecutionNodeSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  kind: z.enum(["command", "file", "condition", "result"]),
  command: z.string().optional(),
  exitCode: z.number().optional(),
  reads: z.array(z.string()),
  writes: z.array(z.string()),
  parentIds: z.array(z.string()),
  childIds: z.array(z.string()),
  causalScore: z.number(),
});

export type ExecutionNode = z.infer<typeof ExecutionNodeSchema>;
