#!/usr/bin/env node

import { Command } from "commander";
import { parseTrace } from "../src/ingestion/traceParser";
import { buildDag } from "../src/synthesis/dagBuilder";
import { pruneDag } from "../src/synthesis/pruner";
import { classifyLiterals } from "../src/synthesis/classifier";
import { Synthesizer } from "../src/synthesis/synthesizer";
import { GeminiProvider } from "../src/synthesis/geminiProvider";
import { MockProvider } from "../src/synthesis/mockProvider";
import * as fs from "fs";
import ora from "ora";
import chalk from "chalk";
import { compileFlow } from "../src/compiler/compilerFlow";

const program = new Command();

program
    .name("synaptic-pruner")
    .description("CLI to prune terminal traces into Play IR")
    .version("1.0.0");

program.command("parse")
    .description("Parse raw log and print pruned DAG")
    .argument("<file>", "Raw trace file")
    .option("--anchor <id...>", "Explicit anchors for pruning")
    .action((file, options) => {
        const spinner = ora("Reading file...").start();
        try {
            const raw = fs.readFileSync(file, "utf8");
            spinner.text = "Parsing trace events...";
            const events = parseTrace(raw);
            
            spinner.text = "Building causal DAG...";
            const dag = buildDag(events);
            
            spinner.text = "Pruning dead branches...";
            const pruned = pruneDag(dag, options.anchor);
            
            spinner.succeed(chalk.green(`Successfully parsed and pruned ${events.length} events down to ${pruned.length} causal nodes.`));
            console.log(chalk.blueBright(JSON.stringify(pruned, null, 2)));
        } catch (e: any) {
            spinner.fail(chalk.red("Error reading or parsing file"));
            console.error(chalk.red(e.message));
        }
    });

program.command("synthesize")
    .description("Synthesize Play IR from raw trace")
    .argument("<file>", "Raw trace file")
    .option("--live", "Use live Gemini model instead of mock")
    .option("--model <model>", "Model to use", "gemini-3.5-flash")
    .option("--anchor <id...>", "Explicit anchors for pruning")
    .action(async (file, options) => {
        const spinner = ora("Initializing pipeline...").start();
        try {
            spinner.text = "Parsing and pruning trace...";
            const raw = fs.readFileSync(file, "utf8");
            const events = parseTrace(raw);
            const dag = buildDag(events);
            const pruned = pruneDag(dag, options.anchor);
            
            spinner.text = "Classifying literals...";
            const allWrites = pruned.flatMap(n => n.writes);
            const literals = classifyLiterals(allWrites);
            
            const provider = options.live 
                ? new GeminiProvider(process.env.GEMINI_API_KEY, options.model)
                : new MockProvider();
                
            const synthesizer = new Synthesizer(provider);
            
            spinner.text = options.live ? `Synthesizing Play IR via ${options.model}...` : "Synthesizing Play IR via mock provider...";
            const playIR = await synthesizer.synthesize(pruned, literals);
            
            spinner.succeed(chalk.green("Play IR synthesized successfully!"));
            console.log(chalk.cyan(JSON.stringify(playIR, null, 2)));
        } catch (e: any) {
            spinner.fail(chalk.red("Error synthesizing Play IR"));
            
            if (e.message.includes("Invalid Play IR") || e.issues) {
                console.error(chalk.redBright("\n[Validation Error] The generated Play IR does not match the strict schema:\n"));
                console.error(chalk.yellow(e.message));
            } else {
                console.error(chalk.red(e.message));
            }
        }
    });

program.command("compile")
    .description("Compile raw trace into an executable Rote script")
    .argument("<file>", "Raw trace file")
    .argument("[out]", "Output file", "play.ts")
    .option("--live", "Use live Gemini model instead of mock")
    .option("--model <model>", "Model to use", "gemini-3.5-flash")
    .option("--anchor <id...>", "Explicit anchors for pruning")
    .action(async (file, out, options) => {
        try {
            await compileFlow(file, out, options);
        } catch (e) {
            process.exit(1);
        }
    });

program.parse(process.argv);
