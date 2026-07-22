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

test.if(process.platform === "darwin")(
  "rendered plist passes plutil -lint",
  () => {
    const p = Bun.spawnSync(["plutil", "-lint", "-"], {
      stdin: Buffer.from(plist),
    });
    expect(p.exitCode).toBe(0);
  },
);
