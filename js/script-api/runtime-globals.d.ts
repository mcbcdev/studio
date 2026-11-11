// Studio supplement - NOT part of the official @minecraft/* packages.
// The Bedrock script runtime provides a global `console`, but the official declaration files do not declare it,
// so Studio adds this minimal typing to give `console.` completions. Add more only when the runtime really has it.

interface Console {
  /** Writes an informational message to the content log. */
  log(...data: any[]): void;
  /** Writes an informational message to the content log. */
  info(...data: any[]): void;
  /** Writes a warning to the content log. */
  warn(...data: any[]): void;
  /** Writes an error to the content log. */
  error(...data: any[]): void;
}
declare var console: Console;
