import { SynthesizerProvider } from "./synthesizer";

export class GeminiProvider implements SynthesizerProvider {
    private modelName: string;
    private key: string;

    constructor(apiKey?: string, modelName: string = "gemini-3.5-flash") {
        const key = apiKey || process.env.GEMINI_API_KEY;
        if (!key) {
            throw new Error("GEMINI_API_KEY is not set. Please set the environment variable or pass it to the constructor.");
        }
        this.key = key;
        this.modelName = modelName;
    }

    async generatePlayIR(prompt: string): Promise<string> {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent?key=${this.key}`;
        
        const headers: Record<string, string> = { 
            "Content-Type": "application/json" 
        };

        const body = JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
        });

        const res = await fetch(url, { method: "POST", headers, body });
        
        if (!res.ok) {
             const error = await res.text();
             throw new Error(`Google API Error: ${res.status} ${res.statusText}\n${error}`);
        }
        
        const data = await res.json();
        let text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        
        // Clean markdown blocks if the LLM wraps the YAML
        text = text.replace(/```yaml\n?/g, '').replace(/```\n?/g, '');
        return text;
    }
}
