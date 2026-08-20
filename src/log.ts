import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Logger = (msg: string) => void;

function localTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

export type Echo = (line: string) => void;

// Where a line goes besides the file. A terminal gets it on stderr; a poll
// child spawned by the TUI has no terminal but is asked to echo anyway
// (DOCKET_LOG_ECHO=1) so its parent can stream the lines into its log pane.
const stderrEcho: Echo = (line) => {
  if (process.stderr.isTTY || process.env.DOCKET_LOG_ECHO === "1")
    console.error(line);
};

export function makeLogger(logPath: string, echo: Echo = stderrEcho): Logger {
  mkdirSync(dirname(logPath), { recursive: true });
  return (msg) => {
    const line = `${localTimestamp()} ${msg}`;
    appendFileSync(logPath, line + "\n");
    echo(line);
  };
}
