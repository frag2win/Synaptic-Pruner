/**
 * Strips ANSI escape codes from a given string.
 * This is useful for cleaning up raw terminal output containing color codes and formatting.
 * 
 * Regex sourced from widely used ansi-regex patterns.
 */
export function stripAnsi(text: string): string {
  // Matches standard ANSI escape sequences
  const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
  
  return text.replace(ansiRegex, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
