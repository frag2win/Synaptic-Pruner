import { describe, it, expect } from "vitest";
import { classifyLiterals } from "../../src/synthesis/classifier";

describe("Literal Classifier", () => {
    it("should classify system identifiers", () => {
        const result = classifyLiterals(["/home/user/workspace", "C:\\Dev\\Project"]);
        expect(result[0].category).toBe("System Identifier");
        expect(result[1].category).toBe("System Identifier");
    });

    it("should classify domain invariants", () => {
        const result = classifyLiterals([".json", ".ts"]);
        expect(result[0].category).toBe("Domain Invariant");
        expect(result[1].category).toBe("Domain Invariant");
    });

    it("should classify protocol constants", () => {
        const result = classifyLiterals(["application/json"]);
        expect(result[0].category).toBe("Protocol Constant");
    });

    it("should classify sample data", () => {
        const result = classifyLiterals(["data_2023.csv"]);
        expect(result[0].category).toBe("Sample Data");
        expect(result[0].replacement).toBe("{{inputs.target_file}}");
    });
});
