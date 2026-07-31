import { expect, test } from "bun:test";
import { renderPlist } from "../src/scheduler";

const plist = renderPlist({
  label: "com.me.auto-review",
  programArgs: ["/usr/local/bin/reviews", "poll"],
  interval: 900,
  stateDir: "/home/me/.local/state/auto-review",
  home: "/home/me",
});

test("renderPlist substitutes every field", () => {
  expect(plist).toContain("<string>com.me.auto-review</string>");
  expect(plist).toContain("<string>/usr/local/bin/reviews</string>");
  expect(plist).toContain("<string>poll</string>");
  expect(plist).toContain("<integer>900</integer>");
  expect(plist).toContain("/home/me/.local/state/auto-review/launchd.log");
  expect(plist).toContain("/home/me/.local/bin");
});

test("renderPlist without a path falls back to the bare toolchain PATH", () => {
  expect(plist).toContain(
    "<string>/home/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>",
  );
});

test("renderPlist prepends a captured PATH before the fallback", () => {
  const withPath = renderPlist({
    label: "com.me.auto-review",
    programArgs: ["/usr/local/bin/reviews", "poll"],
    interval: 900,
    stateDir: "/home/me/.local/state/auto-review",
    home: "/home/me",
    path: "/home/me/.local/share/mise/shims:/home/me/.local/bin",
  });
  expect(withPath).toContain(
    "<string>/home/me/.local/share/mise/shims:/home/me/.local/bin:/home/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>",
  );
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
