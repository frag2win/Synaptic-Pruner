export function generateFuzzInputs(baseInput: Record<string, string>): Array<Record<string, string>> {
    const inputs: Array<Record<string, string>> = [];
    inputs.push(baseInput);
    
    // Fuzz nested directories
    const nested = { ...baseInput };
    for (const key in nested) {
        if (nested[key] && !nested[key].includes('/')) {
            nested[key] = `nested/path/to/${nested[key]}`;
        }
    }
    inputs.push(nested);
    
    // Fuzz negative cases (empty strings)
    const negative = { ...baseInput };
    for (const key in negative) {
        negative[key] = "";
    }
    inputs.push(negative);

    return inputs;
}
