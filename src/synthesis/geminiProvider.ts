import { SynthesizerProvider } from "./synthesizer";
import { GoogleGenAI } from "@google/genai";

export class GeminiProvider implements SynthesizerProvider {
    private modelName: string;
    private ai: GoogleGenAI;

    constructor(apiKey?: string, modelName: string = "gemini-3.5-flash") {
        const key = apiKey || process.env.GEMINI_API_KEY;
        if (!key) {
            throw new Error("GEMINI_API_KEY is not set. Please set the environment variable or pass it to the constructor.");
        }
        
        // Initialize the official SDK which handles retries and connection pooling
        this.ai = new GoogleGenAI({ 
            apiKey: key,
            httpOptions: {
                timeout: 30000 // 30s timeout per P4.2 hardening
            }
        });
        this.modelName = modelName;
    }

    async generatePlayIR(prompt: string): Promise<string> {
        const response = await this.ai.models.generateContent({
            model: this.modelName,
            contents: prompt,
            config: {
                temperature: 0,
            }
        });
        
        let text = response.text || "";
        
        // Clean markdown blocks if the LLM wraps the YAML
        text = text.replace(/```yaml\n?/g, '').replace(/```\n?/g, '');
        return text;
    }
}

