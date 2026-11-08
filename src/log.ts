// Central error logging: always show *where* an error came from
// (first stack frame, as file:line:col), not just the message.

/** First frame of the stack as `file:line:col`, or undefined if unknown. */
export function locationOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.stack) return undefined;
  for (const line of error.stack.split("\n").slice(1)) {
    const m =
      line.match(/\((.+):(\d+):(\d+)\)/) ?? line.match(/at\s+(\S+):(\d+):(\d+)/);
    if (m) {
      const file = m[1]
        .replace(/^.*node_modules\//, "node_modules/")
        .replace(/^.*\/(src\/)/, "$1");
      return `${file}:${m[2]}:${m[3]}`;
    }
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function logError(context: string, error: unknown, detail?: string): void {
  const at = locationOf(error);
  const where = at ? ` at ${at}` : "";
  const extra = detail ? ` (${detail})` : "";
  console.error(
    `[${new Date().toISOString()}] ERROR ${context}${extra}: ${describe(error)}${where}`,
  );
  if (error instanceof Error && error.stack) console.error(error.stack);
}

export function logWarn(context: string, message: string, error?: unknown): void {
  const at = error ? locationOf(error) : undefined;
  console.warn(
    `[${new Date().toISOString()}] WARN ${context}: ${message}${at ? ` at ${at}` : ""}`,
  );
}
