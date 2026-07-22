import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { selfArgs } from "./proc";
import type { Ctx } from "./reviewer";

export const launchdLabel = (): string => `com.${userInfo().username}.auto-review`;

export function launchdLoaded(): boolean {
  if (process.platform !== "darwin") return false;
  const p = Bun.spawnSync(
    ["launchctl", "print", `gui/${process.getuid!()}/${launchdLabel()}`],
    { stdout: "ignore", stderr: "ignore" },
  );
  return p.exitCode === 0;
}

export function renderPlist(o: {
  label: string;
  programArgs: string[];
  interval: number;
  stateDir: string;
  home: string;
}): string {
  const args = o.programArgs.map((a) => `    <string>${a}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${o.label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key><integer>${o.interval}</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${o.home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${o.stateDir}/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>${o.stateDir}/launchd.log</string>
</dict>
</plist>
`;
}

const plistPath = (home: string) =>
  join(home, "Library", "LaunchAgents", `${launchdLabel()}.plist`);

export async function onCommand(ctx: Ctx): Promise<number> {
  if (process.platform !== "darwin") {
    console.error("reviews on: only launchd (macOS) is supported for now");
    return 1;
  }
  const home = process.env.HOME!;
  const minutes = ctx.cfg.poll_interval_minutes ?? 15;
  const label = launchdLabel();
  const target = plistPath(home);
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(ctx.paths.stateDir, { recursive: true });
  // machine-specific absolute paths — lives only in ~/Library/LaunchAgents
  writeFileSync(
    target,
    renderPlist({
      label,
      programArgs: selfArgs("poll"),
      interval: minutes * 60,
      stateDir: ctx.paths.stateDir,
      home,
    }),
  );
  if (Bun.spawnSync(["plutil", "-lint", target]).exitCode !== 0) {
    console.error("plist generation failed");
    rmSync(target, { force: true });
    return 1;
  }
  const uid = process.getuid!();
  Bun.spawnSync(["launchctl", "bootout", `gui/${uid}/${label}`], { stderr: "ignore" });
  const boot = Bun.spawnSync(["launchctl", "bootstrap", `gui/${uid}`, target], { stderr: "pipe" });
  if (boot.exitCode !== 0) {
    console.error(boot.stderr.toString());
    return boot.exitCode ?? 1;
  }
  console.log(`poller enabled as ${label} — polls every ${minutes} min (RunAtLoad fired one now)`);
  return 0;
}

export async function offCommand(): Promise<number> {
  if (process.platform !== "darwin") {
    console.error("reviews off: only launchd (macOS) is supported for now");
    return 1;
  }
  const home = process.env.HOME!;
  const label = launchdLabel();
  const uid = process.getuid!();
  const out = Bun.spawnSync(["launchctl", "bootout", `gui/${uid}/${label}`], { stderr: "ignore" });
  console.log(
    out.exitCode === 0
      ? "poller disabled — 'reviews on' re-enables, manual runs still work"
      : "poller was not loaded",
  );
  rmSync(plistPath(home), { force: true });
  return 0;
}
