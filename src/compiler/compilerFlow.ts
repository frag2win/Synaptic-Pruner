import * as fs from "fs";
import ora from "ora";
import chalk from "chalk";
import * as readline from "readline/promises";
import { parseTrace } from "../ingestion/traceParser";
import { buildDag } from "../synthesis/dagBuilder";
import { pruneDag } from "../synthesis/pruner";
import { classifyLiterals } from "../synthesis/classifier";
import { Synthesizer } from "../synthesis/synthesizer";
import { GeminiProvider } from "../synthesis/geminiProvider";
import { MockProvider } from "../synthesis/mockProvider";

export async function compileFlow(file: string, out: string, options: any): Promise<void> {
    const spinner = ora("Initializing compiler pipeline...").start();
    try {
        const raw = fs.readFileSync(file, "utf8");
        const events = parseTrace(raw);
        const dag = buildDag(events);
        const pruned = pruneDag(dag);
        
        const allWrites = pruned.flatMap(n => n.writes);
        const literals = classifyLiterals(allWrites);
        
        const provider = options.live 
            ? new GeminiProvider(process.env.GEMINI_API_KEY, options.model)
            : new MockProvider();
            
        const synthesizer = new Synthesizer(provider);
        
        spinner.text = options.live ? `Synthesizing Play IR via ${options.model}...` : "Synthesizing Play IR via mock provider...";
        const playIR = await synthesizer.synthesize(pruned, literals);
        
        spinner.text = "Exporting to Rote TS format...";
        const { exportToRote } = await import("./roteExporter");
        const roteScript = exportToRote(playIR);
        
        spinner.stop();
        
        if (!process.stdin.isTTY) {
            console.error(chalk.red("Fatal: Interactive TTY required for authoring gate. Halting execution to prevent automated unreviewed artifact generation."));
            throw new Error("Fatal: Interactive TTY required");
        }
        
        console.log(chalk.cyan("\n--- Proposed Play IR ---"));
        console.log(chalk.gray(roteScript));
        console.log(chalk.cyan("------------------------\n"));
        
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        const answer = await rl.question(chalk.yellow(`Approve and write this Play to ${out}? (y/N) `));
        rl.close();
        
        const ans = answer.trim().toLowerCase();
        if (ans !== 'y' && ans !== 'yes') {
            console.log(chalk.red("Aborted by user. Play not written."));
            return;
        }

        fs.writeFileSync(out, roteScript);
        console.log(chalk.green(`\nSuccessfully compiled and saved Rote play to ${out}!`));
        console.log(chalk.gray(`\nYou can now export this play using the Rote CLI:`));
        console.log(chalk.white(`rote export ${out}`));
    } catch (e: any) {
        spinner.fail(chalk.red("Error compiling Play IR"));
        console.error(chalk.red(e.message));
        throw e;
    }
}
