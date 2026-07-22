import { expect, test } from "bun:test";
import { renderRunEvent } from "../src/runlog";

test("renderRunEvent: assistant text and tool calls become readable lines", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Looking at the diff" },
        {
          type: "tool_use",
          name: "Bash",
          input: { command: "git fetch origin" },
        },
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "/repo/src/a.ts" },
        },
      ],
    },
  });
  expect(renderRunEvent(line)).toBe(
    "Looking at the diff\n→ Bash: git fetch origin\n→ Read: /repo/src/a.ts",
  );
});

test("renderRunEvent: long tool input is truncated to one line", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Bash", input: { command: "x".repeat(300) } },
      ],
    },
  });
  const out = renderRunEvent(line)!;
  expect(out.startsWith("→ Bash: xxx")).toBe(true);
  expect(out.length).toBeLessThan(120);
  expect(out.includes("\n")).toBe(false);
});

test("renderRunEvent: init, result, and noise", () => {
  expect(
    renderRunEvent(
      JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }),
    ),
  ).toBe("session started (s-1)");
  expect(
    renderRunEvent(JSON.stringify({ type: "result", subtype: "success" })),
  ).toBe("✔ review finished");
  expect(
    renderRunEvent(
      JSON.stringify({ type: "result", subtype: "error_during_execution" }),
    ),
  ).toBe("✖ review failed (error_during_execution)");
  expect(
    renderRunEvent(JSON.stringify({ type: "user", message: {} })),
  ).toBeNull();
  expect(renderRunEvent("not json at all")).toBeNull();
  expect(
    renderRunEvent(
      JSON.stringify({ type: "assistant", message: { content: [] } }),
    ),
  ).toBeNull();
});
