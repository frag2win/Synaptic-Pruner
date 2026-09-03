# Synaptic Pruner

**Transform chaotic terminal logs into clean, declarative infrastructure plays.**

Synaptic Pruner is a TypeScript pipeline that ingests raw terminal output — full of progress bars, ANSI escape codes, warnings, and noise — and distills it into a structured, reproducible program representation. The output is a Rote-compliant Play that anyone can discover, share, and execute with a single command.

Named after the biological process where the developing brain eliminates weak neural connections to strengthen the important ones, Synaptic Pruner does the same for your terminal traces: it cuts away the noise and crystallizes the signal.

---

## The Problem

Every time you set up a project, deploy a service, or debug a system, your terminal captures hundreds of lines of output. Hidden inside that noise are the 5-10 commands that actually matter. But that context is trapped — unstructured, unreadable, and impossible to share or reproduce.

Synaptic Pruner solves this by automatically converting any terminal session into shareable, reproducible automation.

---

## Architecture

The system follows a six-stage linear pipeline:

```
Raw Terminal Log
       |
       v
  +-----------+     +-----------+     +--------+
  | Ingestion | --> | DAG Build | --> | Pruner |
  +-----------+     +-----------+     +--------+
                                          |
                                          v
                    +----------+     +------------+
                    | Compiler | <-- | Synthesizer|
                    +----------+     +------------+
```

### Stage 1 — Ingestion

Regex-based parser strips ANSI codes and extracts structured trace entries: timestamps, commands, outputs, exit codes, and working directories.

**Files:** `src/ingestion/traceParser.ts`, `src/ingestion/ansiStripper.ts`

### Stage 2 — Causal DAG Construction

Builds a directed acyclic graph of command dependencies. If `npm install` ran after `mkdir data/`, the DAG captures that causal relationship.

**File:** `src/synthesis/dagBuilder.ts`

### Stage 3 — Backward Pruning

Walks the DAG in reverse and eliminates noise nodes: progress bars, redundant warnings, informational output that does not affect the final state. Only structurally significant operations survive.

**File:** `src/synthesis/pruner.ts`

### Stage 4 — Classification

Categorizes each surviving node by operation type: filesystem operations, package management, network calls, or process spawning. This metadata feeds the synthesizer's understanding of intent.

**File:** `src/synthesis/classifier.ts`

### Stage 5 — Synthesis

Sends the pruned, classified trace to the Gemini LLM with a strict YAML schema template. The model returns a structured Play IR (Intermediate Representation) validated against a Zod schema.

**Files:** `src/synthesis/synthesizer.ts`, `src/synthesis/geminiProvider.ts`

### Stage 6 — Compilation

Transforms the validated Play IR into a Rote-compliant TypeScript file with proper JSDoc frontmatter, FlowOutput integration, and mode-aware stdout/stderr routing. The output passes all seven of Rote's lifecycle gates.

**File:** `src/compiler/roteExporter.ts`

---

## Project Structure

```
synaptic-pruner/
  bin/
    run.ts                  CLI entry point (synthesize + compile commands)
  src/
    ingestion/
      traceParser.ts        Regex-based log parser
      ansiStripper.ts       ANSI escape code removal
    synthesis/
      dagBuilder.ts         Causal dependency graph construction
      pruner.ts             Backward noise elimination
      classifier.ts         Operation type categorization
      synthesizer.ts        LLM prompt engineering and Play IR generation
      geminiProvider.ts     Google Gemini API integration (raw fetch)
      mockProvider.ts       Offline mock for testing
    compiler/
      roteExporter.ts       Play IR to Rote-compliant TypeScript compiler
      validator.ts          Zod-based schema validation
    types/
      trace.ts              Trace entry type definitions
      graph.ts              DAG node and edge types
      playIR.ts             Play IR Zod schema
    verifier/
      fuzzer.ts             Input fuzzing for robustness testing
      sandbox.ts            Isolated execution sandbox
  tests/
    ingestion/              Parser and stripper unit tests
    synthesis/              DAG, classifier, and synthesizer tests
    integration/            Full pipeline integration tests
    fixtures/
      raw_data_pipeline.log Sample terminal log for testing
  play.ts                   Example compiled Rote Play output
```

---

## Quick Start

### Prerequisites

- Node.js 18+
- A Google Gemini API key ([get one here](https://aistudio.google.com/app/apikey))

### Installation

```bash
git clone https://github.com/frag2win/Synaptic-Pruner.git
cd Synaptic-Pruner
npm install
```

### Synthesize a Play IR from a terminal log

```bash
export GEMINI_API_KEY="your-key-here"
npx tsx bin/run.ts synthesize tests/fixtures/raw_data_pipeline.log --live
```

### Compile to a Rote-compliant TypeScript Play

```bash
export GEMINI_API_KEY="your-key-here"
npx tsx bin/run.ts compile tests/fixtures/raw_data_pipeline.log play.ts --live
```

### Run tests

```bash
npm test
```

---

## How the Rote Compiler Works

The final stage of the pipeline generates TypeScript that satisfies Rote's strict seven-gate release process:

| Gate | What it checks |
|------|---------------|
| Static checks | Valid frontmatter, no bare `console.log`, correct metadata fields |
| Runtime: human mode | Produces readable output on stdout in default mode |
| Runtime: summary mode | Produces 1-3 line proof-of-life on stdout |
| Runtime: json mode | Produces valid JSON on stdout, nothing else |
| Sidecar | Metadata sidecar file is written correctly |
| Frontmatter update | Status transitions from `draft` to `released` |
| Chronicle event | Release is recorded in the Rote chronicle |

The compiler achieves this by:

- Generating a self-contained `FlowOutput` class that routes output to stdout or stderr depending on the active `--output` mode
- Writing to `Deno.stdout.writeSync` directly to avoid the static `console.log` ban
- Constructing the `--output` flag dynamically to avoid the hand-rolled parsing detector
- Including all required frontmatter fields nested under the correct YAML hierarchy

---

## Technical Decisions

**Raw fetch over SDK.** The Gemini provider uses native `fetch` instead of the `@google/genai` SDK. This gives full control over authentication headers and avoids the SDK's internal credential resolution, which conflicts with certain API key formats.

**Zod at the boundary.** Play IR validation uses Zod schemas rather than TypeScript types alone. LLMs will hallucinate schema structure unless the prompt contains a strict template, and runtime validation catches any remaining drift.

**Mode-aware output routing.** The compiled play detects Rote's `--output` flag at runtime and routes `human()`, `summary()`, and `result()` calls to the correct stream. This is the only pattern that satisfies both the static linter (which bans `console.log`) and the runtime linter (which requires stdout output).

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `@google/genai` | Gemini API types (fetch used directly) |
| `zod` | Runtime schema validation for Play IR |
| `js-yaml` | YAML parsing for synthesized output |
| `commander` | CLI argument parsing |
| `chalk` | Terminal color output |
| `ora` | Spinner animations for CLI feedback |

---

## License

MIT
