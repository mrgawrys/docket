import type { DenialGroup } from "./denials";

// The one-shot prompt for an interactive claude session the user hands a run's
// denials to — for whatever the mechanical apply can't settle: a write-shaped
// suggestion, a rule that exists but didn't match, or plain confusion. Always
// the whole set: the view acts on the run, not on a group. Pure text in, text
// out — no fs, so it stays unit-testable without a sandbox.

export interface HandoffInput {
  key: string; // "org/repo#123", same as the queue and the panel show
  groups: DenialGroup[];
  configPath: string;
  extraAllowedTools: string[];
  effectiveAllowedTools: string;
  runLogPath: string;
  // The log can be gone by the time the user hands it off (dismissed,
  // cleaned) — say so rather than pointing claude at a dead path.
  runLogExists: boolean;
}

const INTRO =
  "docket pre-runs Claude Code's code review on GitHub PRs before you look " +
  "at them, unattended and on a deliberately read-only allowlist: it " +
  "investigates and reports, and it never posts to GitHub or changes the " +
  "PR — no comments, no pushes.";

const STANDING_ORDER =
  "Research only: investigate these denials and propose options — which " +
  "allowlist entries would cover them, or whether the read-only stance " +
  "should hold here. Change nothing until I decide; that includes the " +
  "config file.";

function groupBlock(g: DenialGroup): string {
  const times = g.count === 1 ? "time" : "times";
  const lines = [`- ${g.suggestion} — denied ${g.count} ${times}`];
  for (const example of g.examples) lines.push(`    e.g. ${example}`);
  if (g.writeShaped)
    lines.push(
      "    conflicts with docket's read-only stance — not a one-key apply",
    );
  if (g.alreadyAllowed)
    lines.push("    already in the allowlist, but the call didn't match");
  return lines.join("\n");
}

export function handoffPrompt(input: HandoffInput): string {
  const count = input.groups.length;
  const scopeLabel = `all ${count} denial group${count === 1 ? "" : "s"}`;
  const header =
    `A headless review of ${input.key} hit permission denials docket ` +
    `could not settle mechanically. Below is ${scopeLabel} it turned away:`;
  const groupsText = input.groups.map(groupBlock).join("\n");
  const configText =
    `config: ${input.configPath}\n` +
    `current extra_allowed_tools: ${JSON.stringify(input.extraAllowedTools)}\n` +
    `effective allowlist: ${input.effectiveAllowedTools}`;
  const logLine = input.runLogExists
    ? `run log: ${input.runLogPath}`
    : "run log: not available (dismissed or cleaned up since the run)";
  return [INTRO, header, groupsText, configText, logLine, STANDING_ORDER].join(
    "\n\n",
  );
}
