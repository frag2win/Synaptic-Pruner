import { PlayIRSchema, PlayIR } from "../types/playIR";

export function validatePlayIR(data: unknown): PlayIR {
    const result = PlayIRSchema.safeParse(data);
    if (!result.success) {
        throw new Error(result.error.message);
    }
    return result.data;
}
