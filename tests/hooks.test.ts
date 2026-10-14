import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isDue,
  nextRecord,
  openedDue,
  parseAfterMerge,
  parseHookOutput,
  addTodo,
  runHook,
  tickTodo,
  type HookPayload,
} from "../src/hooks";
import type { Entry } from "../src/state";
import { makeSandbox } from "./harness";

const entry = (over: Partial<Entry> = {}): Entry => ({
  status: "open",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

test("parseAfterMerge: unchecked items under the heading, stops at a sibling heading", () => {
  const body = [
    "## TLDR",
    "- [ ] not this one",
    "### After merge",
    "- [ ] tell Patrick it's on staging",
    "- [x] already done",
    "* [ ]   translation task  ",
    "#### nested detail",
    "- [ ] still inside",
    "### Blast radius",
    "- [ ] outside again",
  ].join("\n");
  expect(parseAfterMerge(body)).toEqual([
    "tell Patrick it's on staging",
    "translation task",
    "still inside",
  ]);
  expect(parseAfterMerge("# after merge:\r\n- [ ] x")).toEqual(["x"]);
  expect(parseAfterMerge("no section\n- [ ] x")).toEqual([]);
  expect(parseAfterMerge(null)).toEqual([]);
});

test("parseHookOutput: todo/did/warn lines, everything else is log", () => {
  const out = parseHookOutput(
    [
      '{"todo": "Decide next", "link": "https://x/t/1"}',
      '{"did": "CU-1 → ready for qa"}',
      '{"warn": "not on a known board"}',
      "plain echo",
      '{"other": 1}',
      '{"todo": "   "}',
      "",
    ].join("\n"),
  );
  expect(out.todos).toEqual([{ text: "Decide next", link: "https://x/t/1" }]);
  expect(out.did).toEqual(["CU-1 → ready for qa"]);
  expect(out.warn).toEqual(["not on a known board"]);
  expect(out.log).toEqual(["plain echo", '{"other": 1}', '{"todo": "   "}']);
});

test("isDue/openedDue: fires once, retries up to the cap, skips drafts", () => {
  const open = { state: "OPEN", isDraft: false };
  expect(openedDue(entry({ hooks: {} }), open)).toBe(true);
  expect(openedDue(entry({ hooks: {} }), { ...open, isDraft: true })).toBe(
    false,
  );
  const failed = (attempts: number) =>
    entry({ hooks: { opened: { at: "t", ok: false, attempts } } });
  expect(isDue(failed(2), "opened")).toBe(true);
  expect(isDue(failed(3), "opened")).toBe(false);
  expect(
    isDue(
      entry({
        hooks: { opened: { at: "t", ok: true, attempts: 0, none: true } },
      }),
      "opened",
    ),
  ).toBe(false);
});

test("nextRecord: counts attempts and replaces earlier output", () => {
  const out = { todos: [], did: ["a"], warn: [], log: [] };
  const first = nextRecord(
    undefined,
    { ok: false, output: out, error: "x" },
    "t1",
  );
  expect(first).toEqual({
    at: "t1",
    ok: false,
    attempts: 1,
    did: ["a"],
    error: "x",
  });
  const second = nextRecord(
    first,
    { ok: true, output: { ...out, did: ["b"] } },
    "t2",
  );
  expect(second).toEqual({ at: "t2", ok: true, attempts: 2, did: ["b"] });
});

function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "docket-hook-"));
  const path = join(dir, "hook");
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const payload = { event: "merged", dry_run: true } as HookPayload;

test("runHook: reads the payload on stdin, parses stdout", async () => {
  const path = script(
    `read -r p; [[ "$p" == *'"dry_run":true'* ]] && echo '{"did":"saw dry run"}'`,
  );
  const r = await runHook(path, payload, tmpdir(), {});
  expect(r.ok).toBe(true);
  expect(r.output.did).toEqual(["saw dry run"]);
});

test("runHook: non-zero exit and timeout are failures", async () => {
  const bad = await runHook(
    script(`echo '{"todo":"x"}'; echo nope >&2; exit 3`),
    payload,
    tmpdir(),
    {},
  );
  expect(bad.ok).toBe(false);
  expect(bad.error).toBe("exit 3: nope");

  const slow = await runHook(
    script("sleep 5; echo late"),
    payload,
    tmpdir(),
    {},
    200,
  );
  expect(slow.ok).toBe(false);
  expect(slow.error).toContain("timed out");
});

function writeHook(configDir: string, event: string, body: string): void {
  const dir = join(configDir, "hooks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, event), `#!/bin/bash\n${body}\n`);
  chmodSync(join(dir, event), 0o755);
}

const KEY = "mine:testorg/demo#7";
const merged = JSON.stringify({ state: "MERGED", reviews: [] });

test("sync: merged runs the hook and lands in finished with notes + hook todos", () => {
  const sb = makeSandbox();
  sb.writeState({
    [KEY]: { status: "open", hooks: {}, updated_at: "2026-01-01T00:00:00Z" },
  });
  writeHook(
    sb.configDir,
    "merged",
    `cat >/dev/null; echo '{"did":"moved"}'; echo '{"todo":"Decide next","link":"https://x/t/1"}'`,
  );
  const r = sb.run(["sync"], {
    GH_PR_MINE_JSON: merged,
    GH_PR_HOOK_JSON: JSON.stringify({
      number: 7,
      body: "### After merge\n- [ ] tell Patrick\n- [x] done already",
    }),
  });
  expect(r.code).toBe(0);
  const e = sb.state()[KEY];
  expect(e.status).toBe("finished");
  expect(e.hooks.merged).toMatchObject({
    ok: true,
    attempts: 1,
    did: ["moved"],
  });
  expect(e.todos).toEqual([
    { text: "tell Patrick", source: "note" },
    { text: "Decide next", link: "https://x/t/1", source: "hook" },
  ]);

  // finished entries are out of reconcile: no second run
  sb.run(["sync"], { GH_PR_MINE_JSON: merged });
  expect(sb.state()[KEY].hooks.merged.attempts).toBe(1);
});

test("sync: merged with no hook and no notes goes done", () => {
  const sb = makeSandbox();
  sb.writeState({
    [KEY]: { status: "open", hooks: {}, updated_at: "2026-01-01T00:00:00Z" },
  });
  sb.run(["sync"], { GH_PR_MINE_JSON: merged });
  const e = sb.state()[KEY];
  expect(e.status).toBe("done");
  expect(e.hooks.merged).toMatchObject({ ok: true, none: true });
});

test("sync: a failing merged hook retries, then gives up with a to-do", () => {
  const sb = makeSandbox();
  sb.writeState({
    [KEY]: { status: "open", hooks: {}, updated_at: "2026-01-01T00:00:00Z" },
  });
  writeHook(sb.configDir, "merged", "echo broken >&2; exit 1");
  sb.run(["sync"], { GH_PR_MINE_JSON: merged });
  expect(sb.state()[KEY].status).toBe("open");
  sb.run(["sync"], { GH_PR_MINE_JSON: merged });
  sb.run(["sync"], { GH_PR_MINE_JSON: merged });
  const e = sb.state()[KEY];
  expect(e.hooks.merged).toMatchObject({ ok: false, attempts: 3 });
  expect(e.status).toBe("finished");
  expect(e.todos[0].text).toContain("merged hook failed (exit 1: broken)");
});

test("sync: opened fires once for a new entry, never for one tracked before hooks", () => {
  const sb = makeSandbox();
  const calls = join(sb.tmp, "opened-calls");
  writeHook(sb.configDir, "opened", `cat >/dev/null; echo x >> ${calls}`);
  sb.writeState({
    [KEY]: { status: "open", hooks: {}, updated_at: "2026-01-01T00:00:00Z" },
    "mine:testorg/demo#8": {
      status: "open",
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
  sb.run(["sync"]);
  sb.run(["sync"]);
  const s = sb.state();
  expect(s[KEY].hooks.opened).toMatchObject({ ok: true, attempts: 1 });
  expect(s["mine:testorg/demo#8"].hooks.opened).toMatchObject({ none: true });
  expect(Bun.file(calls).size).toBe(2); // one "x\n"
});

test("tickTodo: toggles one to-do; ticking the last open one retires the entry", () => {
  const sb = makeSandbox();
  sb.writeState({
    [KEY]: {
      status: "finished",
      todos: [
        { text: "a", source: "note" },
        { text: "b", source: "hook" },
      ],
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
  expect(tickTodo(sb.statePath, KEY, 0)).toBe("done: a");
  expect(sb.state()[KEY].status).toBe("finished");
  expect(tickTodo(sb.statePath, KEY, 0)).toBe("reopened: a");
  tickTodo(sb.statePath, KEY, 0);
  expect(tickTodo(sb.statePath, KEY, 1)).toBe(`${KEY}: all done`);
  expect(sb.state()[KEY].status).toBe("done");
  expect(tickTodo(sb.statePath, KEY, 5)).toBe(`${KEY}: no to-do 6`);
});

test("addTodo: appends a manual to-do to the row", () => {
  const sb = makeSandbox();
  sb.writeState({
    [KEY]: {
      status: "finished",
      todos: [{ text: "a", source: "note" }],
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
  expect(addTodo(sb.statePath, KEY, "ping QA")).toBe("added: ping QA");
  expect(sb.state()[KEY].todos).toEqual([
    { text: "a", source: "note" },
    { text: "ping QA", source: "manual" },
  ]);
});
