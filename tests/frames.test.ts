import { expect, test } from "bun:test";
import { renderFrames } from "../dev/frames";
import { scenarios } from "../dev/scenarios";

// One smoke test per scenario: a schema change that rots the catalog fails
// here, at the seam the viewers share. Nothing about layout is asserted —
// frames are evidence to eyeball, never material for assertions.
for (const [name, scenario] of Object.entries(scenarios)) {
  if (scenario.interactiveOnly) continue;
  test(`frames: ${name} renders`, async () => {
    const frames = await renderFrames(name);
    expect((frames[0] ?? "").trim()).not.toBe("");
  });
}
