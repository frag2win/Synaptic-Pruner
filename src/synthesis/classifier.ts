export type LiteralCategory = "Sample Data" | "Protocol Constant" | "Domain Invariant" | "System Identifier";

export interface ClassifiedLiteral {
    value: string;
    category: LiteralCategory;
    replacement?: string; 
}

export function classifyLiterals(literals: string[]): ClassifiedLiteral[] {
    return literals.map(value => {
        // System Identifiers: absolute paths
        if (value.startsWith('/home/') || value.startsWith('C:\\') || value.startsWith('~/')) {
            return { value, category: "System Identifier", replacement: "{{inputs.cwd}}" };
        }
        // Protocol Constants: content types
        if (['application/json', 'application/xml', 'text/html'].includes(value)) {
            return { value, category: "Protocol Constant" };
        }
        // Domain Invariants: simple extensions
        if (value.startsWith('.') && value.length < 6) {
            return { value, category: "Domain Invariant" };
        }
        // Sample Data: explicit files or general values
        if (value.endsWith('.csv') || value.endsWith('.json') || value.endsWith('.txt')) {
            return { value, category: "Sample Data", replacement: `{{inputs.target_file}}` };
        }
        
        // Default catch-all for unknown strings
        return { value, category: "Sample Data", replacement: `{{inputs.param_value}}` };
    });
}
