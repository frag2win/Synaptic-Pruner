import { TraceEvent } from "../types/trace";
import { stripAnsi } from "./ansiStripper";
import * as crypto from "crypto";

export interface ParseOptions {
  /**
   * If true, will aggressively clean carriage returns (\r) and trailing whitespaces.
   */
  aggressiveCleanup?: boolean;
}

// Matches common terminal prompts:
// 1. Linux/Mac: user@host:~/path$ or root@host:/var/log#
// 2. PowerShell: PS C:\Users\Name\Desktop>
// 3. Simple arrow/percent prompts: ~/dir % or ➜  ~
const PROMPT_REGEX = /^(?:[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:(.*?)[$#]|PS\s+([a-zA-Z]:\\[^>]*?)>|.*?([~/][^\s]*)?[➜❯%])\s+(.*)$/;

/**
 * Parses a raw terminal transcript string into structured TraceEvents.
 * 
 * @param rawText The raw log text from a shell session
 * @param options Parsing configuration options
 * @returns An array of parsed TraceEvents
 */
export function parseTrace(rawText: string, options?: ParseOptions): TraceEvent[] {
  const cleanedText = stripAnsi(rawText);
  const lines = cleanedText.split('\n');
  
  const events: TraceEvent[] = [];
  let currentEvent: Partial<TraceEvent> | null = null;
  let stdoutLines: string[] = [];

  for (const line of lines) {
    const promptMatch = line.match(PROMPT_REGEX);
    
    if (promptMatch) {
      // Finalize previous event
      if (currentEvent) {
        finalizeEvent(currentEvent, stdoutLines);
        events.push(currentEvent as TraceEvent);
      }
      
      const cwdLinux = promptMatch[1];
      const cwdWin = promptMatch[2];
      const cwdOther = promptMatch[3];
      const command = promptMatch[4];

      const extractedCwd = cwdLinux || cwdWin || cwdOther || "unknown";

      // Start new event
      currentEvent = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        command: command.trim(),
        cwd: extractedCwd.trim(),
        stdout: "",
        stderr: "", // Currently mixing stderr/stdout heuristics
        fsMutations: []
      };
      stdoutLines = [];
    } else {
      if (currentEvent) {
        stdoutLines.push(line);
      }
    }
  }
  
  // Finalize last event
  if (currentEvent) {
    finalizeEvent(currentEvent, stdoutLines);
    events.push(currentEvent as TraceEvent);
  }
  
  // Filter out any purely empty commands
  return events.filter(e => e.command.length > 0);
}

/**
 * Mutates the event to apply stdout and heuristic exit codes.
 */
function finalizeEvent(event: Partial<TraceEvent>, stdoutLines: string[]) {
  const fullOutput = stdoutLines.join('\n').trim();
  event.stdout = fullOutput;
  
  // Basic heuristic for error states
  const lowerOut = fullOutput.toLowerCase();
  if (
    lowerOut.includes('error:') || 
    lowerOut.includes('command not found') || 
    lowerOut.includes('no such file or directory') ||
    lowerOut.includes('fatal:')
  ) {
    event.exitCode = 1;
    // For heuristics, we'll pipe it to stderr as well
    event.stderr = fullOutput;
  } else {
    event.exitCode = 0;
    event.stderr = "";
  }
}
