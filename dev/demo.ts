// Interactive demo launcher: seeds a scenario into a fresh scratch sandbox and
// runs the real TUI over it, shims playing gh/claude. The scratch dir is kept
// after exit for inspection; the live setup is unreachable by construction —
// DOCKET_* always point at the scratch dir, overriding the shell's values.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "./sandbox";
import { scenarios, seedScenario } from "./scenarios";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

const args = Bun.argv.slice(2);
if (args[0] === "--list") {
  const width = Math.max(...Object.keys(scenarios).map((n) => n.length));
  for (const [name, s] of Object.entries(scenarios)) {
    console.log(`  ${name.padEnd(width)}  ${s.description}`);
    if (s.hint) console.log(`  ${" ".repeat(width)}  → ${s.hint}`);
  }
  process.exit(0);
}

const name = args[0] ?? "full";
const scenario = scenarios[name];
if (!scenario) {
  console.error(`unknown scenario: ${name}`);
  console.error(`valid: ${Object.keys(scenarios).join(", ")}`);
  process.exit(1);
}

const dirs = materialize(mkdtempSync(join(tmpdir(), "docket-demo-")));

// A reviewing entry gets a genuinely live pid so pidAlive holds and K kills a
// real process; the sleeper dies with the demo, so quitting leaves no orphan.
let sleeper: Bun.Subprocess | undefined;
if (Object.values(scenario.state).some((e) => e.status === "reviewing")) {
  sleeper = Bun.spawn(["sleep", "600"]);
}
seedScenario(dirs, scenario, sleeper ? { runningPid: sleeper.pid } : {});

console.log(`docket demo — ${name}: ${scenario.description}`);
if (scenario.hint) console.log(`hint: ${scenario.hint}`);
console.log(`sandbox: ${dirs.root} (kept after exit)`);
console.log();

const child = Bun.spawn(["bun", MAIN, ...(scenario.args ?? [])], {
  stdio: ["inherit", "inherit", "inherit"],
  env: {
    ...process.env,
    ...dirs.env,
    ...scenario.env,
  } as Record<string, string>,
});
const code = await child.exited;
if (sleeper && sleeper.exitCode === null) sleeper.kill();
process.exit(code);
