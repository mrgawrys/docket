import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { selfArgs } from "./proc";
import type { Ctx } from "./reviewer";

// Indirection in the shape of claudeBin/ghBin, and for the same reason: the
// test suite must never touch the machine's real launchd.
export const launchctlBin = (env: NodeJS.ProcessEnv = process.env): string =>
  env.LAUNCHCTL_BIN ?? "launchctl";

export const launchdLabel = (): string => `com.${userInfo().username}.docket`;

// What the poller was called before the rename. Still loaded on any machine
// that upgraded without running install.sh — Homebrew, notably — where it
// polls the pre-rename state file alongside us and reviews every PR twice.
export const legacyLaunchdLabel = (): string =>
  `com.${userInfo().username}.auto-review`;

export function launchdLoaded(label: string = launchdLabel()): boolean {
  if (process.platform !== "darwin") return false;
  const p = Bun.spawnSync(
    [launchctlBin(), "print", `gui/${process.getuid!()}/${label}`],
    { stdout: "ignore", stderr: "ignore" },
  );
  return p.exitCode === 0;
}

// Boot out the pre-rename job and delete its plist. Returns whether one was
// loaded, so callers can say so. Safe to call when there is nothing there.
export function removeLegacyJob(home: string): boolean {
  if (process.platform !== "darwin") return false;
  const label = legacyLaunchdLabel();
  const was = launchdLoaded(label);
  Bun.spawnSync(
    [launchctlBin(), "bootout", `gui/${process.getuid!()}/${label}`],
    {
      stderr: "ignore",
    },
  );
  rmSync(join(home, "Library", "LaunchAgents", `${label}.plist`), {
    force: true,
  });
  return was;
}

// argv for the plist, which outlives this process. process.execPath is
// symlink-resolved, so under Homebrew it is the versioned Cellar path — which
// `brew upgrade` deletes, leaving launchd firing at an ENOENT every interval
// while `docket status` still reports the job loaded. Prefer the name on PATH,
// but only when it resolves to this very binary: a stable alias for what is
// already running, never a switch to some other install.
export function stablePollArgs(): string[] {
  const args = selfArgs("poll");
  const exe = args[0]!;
  if (basename(exe) !== "docket") return args; // dev: `bun src/main.ts`
  const onPath = Bun.which("docket");
  if (!onPath || onPath === exe) return args;
  try {
    if (realpathSync(onPath) !== exe) return args;
  } catch {
    return args;
  }
  return [onPath, ...args.slice(1)];
}

export function renderPlist(o: {
  label: string;
  programArgs: string[];
  interval: number;
  stateDir: string;
  home: string;
  path?: string;
}): string {
  const args = o.programArgs.map((a) => `    <string>${a}</string>`).join("\n");
  // launchd runs with a bare PATH, so version-manager toolchains (mise/asdf/
  // nvm shims, homebrew) that a review's tools need — e.g. `node` for a
  // blast-radius pass — go missing. Bake the invoking shell's PATH in front of
  // a safe fallback so a polled run sees the same tools `docket on` did.
  const fallback = `${o.home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const path = o.path ? `${o.path}:${fallback}` : fallback;
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
    <string>${path}</string>
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
    console.error("docket on: only launchd (macOS) is supported for now");
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
      programArgs: stablePollArgs(),
      interval: minutes * 60,
      stateDir: ctx.paths.stateDir,
      home,
      path: process.env.PATH,
    }),
  );
  if (Bun.spawnSync(["plutil", "-lint", target]).exitCode !== 0) {
    console.error("plist generation failed");
    rmSync(target, { force: true });
    return 1;
  }
  const uid = process.getuid!();
  // Whatever install path got them here, only one poller may run: the old job
  // reads the pre-rename state file, so leaving it loaded reviews (and bills)
  // every PR twice, and no docket command would ever mention it.
  const hadLegacy = removeLegacyJob(home);
  Bun.spawnSync([launchctlBin(), "bootout", `gui/${uid}/${label}`], {
    stderr: "ignore",
  });
  const boot = Bun.spawnSync(
    [launchctlBin(), "bootstrap", `gui/${uid}`, target],
    {
      stderr: "pipe",
    },
  );
  if (boot.exitCode !== 0) {
    console.error(boot.stderr.toString());
    return boot.exitCode ?? 1;
  }
  if (hadLegacy) {
    console.log(`removed the old poller (${legacyLaunchdLabel()})`);
  }
  console.log(
    `poller enabled as ${label} — polls every ${minutes} min (RunAtLoad fired one now)`,
  );
  return 0;
}

export async function offCommand(): Promise<number> {
  if (process.platform !== "darwin") {
    console.error("docket off: only launchd (macOS) is supported for now");
    return 1;
  }
  const home = process.env.HOME!;
  const label = launchdLabel();
  const uid = process.getuid!();
  const out = Bun.spawnSync(
    [launchctlBin(), "bootout", `gui/${uid}/${label}`],
    {
      stderr: "ignore",
    },
  );
  console.log(
    out.exitCode === 0
      ? "poller disabled — 'docket on' re-enables, manual runs still work"
      : "poller was not loaded",
  );
  rmSync(plistPath(home), { force: true });
  return 0;
}
