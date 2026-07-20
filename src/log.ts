import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Logger = (msg: string) => void;

function localTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function makeLogger(logPath: string): Logger {
  mkdirSync(dirname(logPath), { recursive: true });
  return (msg) => {
    const line = `${localTimestamp()} ${msg}`;
    appendFileSync(logPath, line + "\n");
    if (process.stderr.isTTY) console.error(line);
  };
}
