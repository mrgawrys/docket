import { PassThrough, Writable } from "node:stream";
import { expect, test } from "bun:test";
import { DEFAULT_RECEIVE_PROMPT, type Config } from "../src/config";
import { makeUi } from "../src/wizard/flow";
import {
  type ReceiveStepOptions,
  type ReceiveStepResult,
  runReceiveStep,
} from "../src/wizard/reviewtask";

const BARE: Config = { orgs: [], repos: {} };

async function drive(
  script: string[],
  o: Partial<ReceiveStepOptions> = {},
): Promise<{ result: ReceiveStepResult; out: string }> {
  const input = new PassThrough();
  for (const line of script) input.write(`${line}\n`);
  input.end();
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const ui = makeUi(input, output, "/home/none");
  try {
    const result = await runReceiveStep({
      ui,
      cfg: o.cfg ?? BARE,
      editor: o.editor,
    });
    return { result, out: chunks.join("") };
  } finally {
    ui.close();
  }
}

test("declining leaves receive off and asks nothing further", async () => {
  const r = await drive([""], {
    editor: () => {
      throw new Error("editor must not open");
    },
  });
  expect(r.result).toEqual({ receive_enabled: false });
  expect(r.out).not.toContain("which?");
});

test("yes + default enables receive without writing a prompt", async () => {
  const r = await drive(["y", "1"]);
  expect(r.result).toEqual({ receive_enabled: true });
});

test("yes + custom captures a receive task through the editor", async () => {
  const r = await drive(["y", "2"], {
    editor: (seed) => {
      expect(seed).toContain(DEFAULT_RECEIVE_PROMPT);
      return "Fix only the blocking feedback on {repo}#{number}.";
    },
  });
  expect(r.result).toEqual({
    receive_enabled: true,
    receive_prompt: "Fix only the blocking feedback on {repo}#{number}.",
  });
});

test("an existing non-default receive_prompt is NEVER overwritten", async () => {
  // the review_prompt deletion incident, receive edition: saying yes must
  // keep the hand-written task and never even offer the default/custom choice
  const r = await drive(["y"], {
    cfg: { ...BARE, receive_prompt: "My hand-written receive task." },
    editor: () => {
      throw new Error("editor must not open");
    },
  });
  expect(r.result).toEqual({ receive_enabled: true });
  expect(r.out).toContain("keeping your existing receive task");
  expect(r.out).toContain("My hand-written receive task.");
  expect(r.out).not.toContain("which?");
});

test("an editor that saves nothing falls back to the default task", async () => {
  const r = await drive(["y", "2"], { editor: () => null });
  expect(r.result).toEqual({ receive_enabled: true });
  expect(r.out).toContain("using the default receive task");
});

test("a closed stdin aborts instead of hanging", async () => {
  const r = await drive([]);
  expect(r.result).toBe("aborted");
});
