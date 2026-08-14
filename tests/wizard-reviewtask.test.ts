import { PassThrough, Writable } from "node:stream";
import { expect, test } from "bun:test";
import type { Config } from "../src/config";
import type { StepResult } from "../src/reviewtask";
import { makeUi } from "../src/wizard/flow";
import {
  type ReviewTaskOptions,
  runReviewTaskStep,
} from "../src/wizard/reviewtask";

const BARE: Config = { orgs: [], repos: {} };

// A derive whose answer is a well-formed trailing block.
const answering =
  (tools: string[], notes?: string) => async (_prompt: string) =>
    `I read the files.\n\`\`\`json\n${JSON.stringify({ tools, notes })}\n\`\`\`\n`;

interface Driven {
  result: StepResult;
  out: string;
  prompts: string[]; // every prompt derive was asked with
}

async function drive(
  script: string[],
  o: Partial<ReviewTaskOptions> & { deriveTools?: string[] } = {},
): Promise<Driven> {
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
  const prompts: string[] = [];
  const derive =
    o.derive ??
    (o.deriveTools
      ? async (p: string) => {
          prompts.push(p);
          return answering(o.deriveTools!)(p);
        }
      : undefined);
  try {
    const result = await runReviewTaskStep({
      ui,
      cfg: o.cfg ?? BARE,
      editor: o.editor,
      derive,
    });
    return { result, out: chunks.join(""), prompts };
  } finally {
    ui.close();
  }
}

test("picking the default asks nothing further", async () => {
  const r = await drive(["1"], {
    editor: () => {
      throw new Error("editor must not open");
    },
    derive: async () => {
      throw new Error("derive must not run");
    },
  });
  expect(r.result).toEqual({ task: "default" });
  expect(r.out).not.toContain("work it out");
});

test("custom + accept returns the task and the union with hand-set extras", async () => {
  const r = await drive(["2", "", ""], {
    cfg: { ...BARE, extra_allowed_tools: ["Bash(rg:*)"] },
    editor: (seed) => `${seed}\nRun the blast-radius skill.`,
    deriveTools: ["Bash(rg:*)", "Bash(node:*)"],
  });
  expect(r.result).toEqual({
    task: "custom",
    review_prompt:
      "Review the PR by running /code-review {number}.\n\nRun the blast-radius skill.",
    extra_allowed_tools: ["Bash(rg:*)", "Bash(node:*)"],
  });
  // the proposal shows only what is new
  expect(r.out).toContain("+ Bash(node:*)");
  expect(r.out).not.toContain("+ Bash(rg:*)");
});

test("the derivation prompt carries the clone paths and the config's plugins dir", async () => {
  const r = await drive(["2", "", ""], {
    cfg: {
      orgs: [],
      repos: { "acme/thing": "/clones/thing" },
      claude_config_dir: "/pinned/claude",
    },
    editor: () => "Custom task.",
    deriveTools: ["Bash(node:*)"],
  });
  expect(r.result).toMatchObject({ task: "custom" });
  expect(r.prompts.length).toBe(1);
  expect(r.prompts[0]).toContain("/clones/thing");
  expect(r.prompts[0]).toContain("Custom task.");
  // the same resolution doctor uses: claude_config_dir wins when set
  expect(r.prompts[0]).toContain("/pinned/claude/plugins");
});

test("declining the offer returns the task alone and says where denials land", async () => {
  const r = await drive(["2", "n"], {
    editor: () => "Custom task.",
    deriveTools: ["Bash(node:*)"],
  });
  expect(r.result).toEqual({ task: "custom", review_prompt: "Custom task." });
  expect(r.out).toContain("⊘");
  expect(r.out).toContain("D view");
  expect(r.prompts).toEqual([]);
});

test("[s] at the proposal returns the task alone — no extra_allowed_tools key", async () => {
  const r = await drive(["2", "", "s"], {
    editor: () => "Custom task.",
    deriveTools: ["Bash(node:*)"],
  });
  expect(r.result).toEqual({ task: "custom", review_prompt: "Custom task." });
});

test("no derive means the offer is never made", async () => {
  const r = await drive(["2"], { editor: () => "Custom task." });
  expect(r.result).toEqual({ task: "custom", review_prompt: "Custom task." });
  expect(r.out).toContain("can't tell which tools");
  expect(r.out).not.toContain("work it out");
});

test("a failing derive degrades to one line and the task alone", async () => {
  const r = await drive(["2", ""], {
    editor: () => "Custom task.",
    derive: async () => {
      throw new Error("timeout");
    },
  });
  expect(r.result).toEqual({ task: "custom", review_prompt: "Custom task." });
  expect(r.out).toContain("couldn't work it out");
});

test("an unparseable answer degrades exactly like a failed call", async () => {
  const r = await drive(["2", ""], {
    editor: () => "Custom task.",
    derive: async () => "no block here, just prose",
  });
  expect(r.result).toEqual({ task: "custom", review_prompt: "Custom task." });
  expect(r.out).toContain("couldn't work it out");
});

test("[e] replaces the derived list; the edit still merges with extras", async () => {
  const r = await drive(["2", "", "e", "Bash(jq:*), Bash(node:*)", ""], {
    cfg: { ...BARE, extra_allowed_tools: ["Bash(rg:*)"] },
    editor: () => "Custom task.",
    deriveTools: ["Bash(python:*)"],
  });
  expect(r.result).toEqual({
    task: "custom",
    review_prompt: "Custom task.",
    extra_allowed_tools: ["Bash(rg:*)", "Bash(jq:*)", "Bash(node:*)"],
  });
});

test("a proposal of only posting tools shows the dropped count and adds nothing", async () => {
  const r = await drive(["2", "", ""], {
    editor: () => "Custom task.",
    deriveTools: ["Bash(gh pr comment:*)", "Bash(gh api -X POST repos:*)"],
  });
  // accepting an empty proposal must not produce an empty array
  expect(r.result).toEqual({ task: "custom", review_prompt: "Custom task." });
  expect(r.out).toContain("dropped 2 posting tool(s)");
  expect(r.out).toContain("nothing new to add");
});

test("an editor that returns nothing keeps the default and re-offers nothing", async () => {
  const r = await drive(["2"], {
    editor: () => null,
    deriveTools: ["Bash(node:*)"],
  });
  expect(r.result).toEqual({ task: "default" });
  expect(r.prompts).toEqual([]);
});

test("an editor that returns nothing keeps a custom task on disk", async () => {
  const r = await drive(["2"], {
    cfg: { ...BARE, review_prompt: "Standing custom task." },
    editor: () => "# only comments left\n",
    deriveTools: ["Bash(node:*)"],
  });
  expect(r.result).toEqual({
    task: "custom",
    review_prompt: "Standing custom task.",
  });
  // keeping the current task is not a new task: no derivation re-offer
  expect(r.out).not.toContain("work it out");
  expect(r.prompts).toEqual([]);
});

test("with no $EDITOR the task is read line by line until a blank one", async () => {
  const r = await drive(["2", "First line.", "Second line.", "", "n"], {
    deriveTools: ["Bash(node:*)"],
  });
  expect(r.result).toEqual({
    task: "custom",
    review_prompt: "First line.\nSecond line.",
  });
});

test("stdin closing mid-step returns aborted", async () => {
  const r = await drive(["2"], {}); // line entry asks; the stream is done
  expect(r.result).toBe("aborted");
});
