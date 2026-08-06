import { expect, test } from "bun:test";
import { basename } from "node:path";
import { renderPlist, stablePollArgs } from "../src/scheduler";

const plist = renderPlist({
  label: "com.me.docket",
  programArgs: ["/usr/local/bin/docket", "poll"],
  interval: 900,
  stateDir: "/home/me/.local/state/docket",
  home: "/home/me",
});

test("renderPlist substitutes every field", () => {
  expect(plist).toContain("<string>com.me.docket</string>");
  expect(plist).toContain("<string>/usr/local/bin/docket</string>");
  expect(plist).toContain("<string>poll</string>");
  expect(plist).toContain("<integer>900</integer>");
  expect(plist).toContain("/home/me/.local/state/docket/launchd.log");
  expect(plist).toContain("/home/me/.local/bin");
});

test("renderPlist without a path falls back to the bare toolchain PATH", () => {
  expect(plist).toContain(
    "<string>/home/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>",
  );
});

test("renderPlist prepends a captured PATH before the fallback", () => {
  const withPath = renderPlist({
    label: "com.me.docket",
    programArgs: ["/usr/local/bin/docket", "poll"],
    interval: 900,
    stateDir: "/home/me/.local/state/docket",
    home: "/home/me",
    path: "/home/me/.local/share/mise/shims:/home/me/.local/bin",
  });
  expect(withPath).toContain(
    "<string>/home/me/.local/share/mise/shims:/home/me/.local/bin:/home/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>",
  );
});

test("stablePollArgs: runs the binary that is running now, never another one", () => {
  const args = stablePollArgs();
  expect(args.at(-1)).toBe("poll");
  // under `bun test` execPath is bun, so the script path must survive — a
  // plist argv of just [bun, "poll"] would run bun's own REPL every interval
  expect(basename(args[0]!)).toBe("bun");
  expect(args).toHaveLength(3);
  expect(args[1]).toMatch(/\.tsx?$/);
});

test.if(process.platform === "darwin")(
  "rendered plist passes plutil -lint",
  () => {
    const p = Bun.spawnSync(["plutil", "-lint", "-"], {
      stdin: Buffer.from(plist),
    });
    expect(p.exitCode).toBe(0);
  },
);
