import { z } from "zod";

export const PlayIRInputSchema = z.object({
  type: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.string().optional(),
});

export const PlayIRAssertionSchema = z.object({
  assertion: z.string(),
  target: z.string(),
  expected: z.string().optional(),
});

export const PlayIRActionProvenanceSchema = z.object({
  sourceNodeIds: z.array(z.string())
});

export const PlayIRActionSchema = z.object({
  id: z.string(),
  runtime: z.string(),
  action: z.string().optional(),
  target: z.string().optional(),
  command: z.string().optional(),
  idempotent: z.boolean().optional(),
  provenance: PlayIRActionProvenanceSchema.optional(),
});

export const PlayIRSafetyBoundarySchema = z.object({
  network_access: z.boolean(),
  allowed_write_paths: z.array(z.string()),
});

export const PlayIRSchema = z.object({
  schema_version: z.string(),
  operation_id: z.string(),
  metadata: z.object({
    description: z.string(),
    author: z.string(),
    deterministic: z.boolean(),
  }),
  inputs: z.record(z.string(), PlayIRInputSchema).optional(),
  preconditions: z.array(PlayIRAssertionSchema).optional(),
  actions: z.array(PlayIRActionSchema),
  postconditions: z.array(PlayIRAssertionSchema).optional(),
  safety_boundary: PlayIRSafetyBoundarySchema.optional(),
});

export type PlayIR = z.infer<typeof PlayIRSchema>;
