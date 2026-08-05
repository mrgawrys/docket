import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { watch } from "node:fs";
import { dirname } from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readAssessment } from "../assessment";
import { runLogPath, type Config, type Paths } from "../config";
import { buildResume, printPending } from "../list";
import {
  buildOpener,
  openerContext,
  resolveOpeners,
  resolveWorktree,
  type ResolvedOpeners,
} from "../openers";
import { selfArgs } from "../proc";
import type { Ctx } from "../reviewer";
import { loadState, pendingEntries } from "../state";
import { PANEL_HEIGHT, panelLines } from "../panel";
import { Help, Legend } from "./legend";
import { Panel } from "./panel";
import { Queue, type Row } from "./queue";
import { suspendLoop, type SuspendRequest } from "./suspend";

export interface TuiActions {
  retry(key: string): Promise<number>;
  poll(): Promise<number>;
  sync(): Promise<number>;
  // Both return what to tell the user: their own output goes to the console,
  // which Ink displaces above the frame where nobody is looking.
  dismiss(key: string): string;
  kill(key: string): string;
}

export interface AppProps {
  cfg: Config;
  paths: Paths;
  actions: TuiActions;
  resolved: ResolvedOpeners;
  request: (r: SuspendRequest) => void;
  // Carried across a suspend so the cursor comes back where it was.
  initialKey?: string;
  onSelect?: (key: string) => void;
  notice?: string;
}

function Bar({
  label,
  right,
  width,
}: {
  label: string;
  right?: string;
  width: number;
}) {
  const head = `─ ${label} `;
  const tail = right ? ` ${right} ─` : "─";
  const fill = Math.max(0, width - head.length - tail.length);
  return (
    <Text dimColor>
      {head}
      {"─".repeat(fill)}
      {tail}
    </Text>
  );
}

export function App({
  cfg,
  paths,
  actions,
  resolved,
  request,
  initialKey,
  onSelect,
  notice,
}: AppProps) {
  const { exit } = useApp();
  const size = useWindowSize();
  const width = size.columns || 80;
  const height = size.rows || 24;

  const load = useCallback(
    (): Row[] =>
      pendingEntries(loadState(paths.statePath)).map(([key, entry]) => ({
        key,
        entry,
      })),
    [paths.statePath],
  );
  const [rows, setRows] = useState<Row[]>(load);
  const [cursorKey, setCursorKey] = useState<string | undefined>(initialKey);
  const [view, setView] = useState<"queue" | "help">("queue");
  const [status, setStatus] = useState<string | undefined>();

  // saveState renames a temp file over state.json, which breaks a watch bound
  // to the file's inode — watch the directory instead.
  useEffect(() => {
    try {
      const w = watch(dirname(paths.statePath), (_ev, file) => {
        if (file === "state.json") setRows(load());
      });
      return () => w.close();
    } catch {
      return; // no watch is survivable: every action reloads anyway
    }
  }, [paths.statePath, load]);

  // A row can vanish under the cursor: x and K drop it, and so does a poll
  // that marks it done while the watcher reloads. Hold the position when the
  // key is gone — snapping to row 0 would aim the next x at another PR.
  const lastIndex = useRef(0);
  const found = rows.findIndex((r) => r.key === cursorKey);
  const cursor =
    found >= 0 ? found : Math.min(lastIndex.current, rows.length - 1);
  lastIndex.current = Math.max(0, cursor);
  const current = rows[cursor];
  useEffect(() => {
    if (!current) return;
    setCursorKey(current.key); // re-anchor after the row it named disappeared
    onSelect?.(current.key);
  }, [current, onSelect]);
  const summary = current?.entry.summary;
  // Only read when the panel would actually fall back to it: with a headline
  // recorded on the entry, the run log has nothing left to tell this view.
  const assessment = useMemo(
    () =>
      current && !summary?.headline
        ? readAssessment(runLogPath(paths, current.key))
        : ({ kind: "none", reason: "" } as const),
    [current, summary, paths],
  );

  // Computed per row, never per keypress: a verb the machine cannot run is
  // greyed in the legend with its reason in the preview, not a dead key.
  const unavailable = useMemo(() => {
    const u: Record<string, string> = {};
    if (!current) return u;
    const resume = buildResume(current.entry, cfg);
    if ("error" in resume) u.claude = resume.error;
    const wt = resolveWorktree(current.entry);
    for (const verb of ["shell", "diff"]) {
      if (!resolved[verb]) u[verb] = `no ${verb} opener found on PATH`;
      else if ("missing" in wt) u[verb] = wt.missing;
    }
    return u;
  }, [current, cfg, resolved]);

  const notes = useMemo(() => {
    const byReason = new Map<string, string[]>();
    for (const [verb, reason] of Object.entries(unavailable)) {
      byReason.set(reason, [...(byReason.get(reason) ?? []), verb]);
    }
    return [...byReason].map(
      ([reason, verbs]) => `${verbs.join("/")}: ${reason}`,
    );
  }, [unavailable]);

  const footer = status ?? notice;
  const queueHeight = Math.max(
    1,
    Math.min(rows.length || 1, Math.min(10, height - 8)),
  );
  // Bounded, and it shrinks with the terminal — the panel never takes the
  // screen away from the queue the way the old scrolling pane did. The `- 3`
  // is the two bars plus the row the frame must leave spare: fill every row
  // and the terminal scrolls the whole thing on each render.
  const panelHeight = Math.max(
    1,
    Math.min(PANEL_HEIGHT, height - 1 - queueHeight - 3 - (footer ? 1 : 0)),
  );
  const panel = useMemo(
    () =>
      panelLines({
        summary,
        assessment,
        notes,
        width: width - 2,
        height: panelHeight,
      }),
    [summary, assessment, notes, width, panelHeight],
  );

  const move = (delta: number) => {
    if (rows.length === 0) return;
    const next = Math.min(rows.length - 1, Math.max(0, cursor + delta));
    setCursorKey(rows[next]?.key);
  };

  const run = (label: string, fn: () => Promise<number>) => {
    setStatus(`${label}…`);
    fn()
      .then(() => setStatus(undefined))
      .catch((e: unknown) => setStatus(`${label} failed: ${e}`))
      .finally(() => setRows(load()));
  };

  const open = (verb: "shell" | "diff") => {
    if (!current) return;
    const r = buildOpener(
      verb,
      resolved,
      openerContext(current.key, current.entry),
    );
    if ("unavailable" in r) return setStatus(`${verb}: ${r.unavailable}`);
    request({
      ...r,
      banner: `${verb}: ${current.key} in ${r.cwd}`,
      interactive: verb === "shell",
    });
  };

  useInput((input, key) => {
    if (input === "q") return exit(); // quits from any view, help included
    if (view === "help") {
      if (input === "?" || key.escape) setView("queue");
      return;
    }
    if (input === "?") return setView("help");
    if (input === "j" || key.downArrow) return move(1);
    if (input === "k" || key.upArrow) return move(-1);
    if (input === "p") return run("polling", actions.poll);
    if (input === "S") return run("syncing", actions.sync);
    if (!current) return;
    if (key.return) {
      const r = buildResume(current.entry, cfg);
      if ("error" in r) return setStatus(`${current.key} ${r.error}`);
      request({
        argv: r.argv,
        cwd: r.cwd,
        env: r.env,
        banner: `resuming ${current.key}`,
      });
      return;
    }
    if (input === "s") return open("shell");
    // ink reports ctrl+letter as the bare letter, and Ctrl+D is muscle memory
    // for EOF — it must not hand the terminal to the diff opener.
    if (input === "d" && !key.ctrl) return open("diff");
    if (input === "w") {
      request({
        argv: selfArgs("watch", current.key),
        cwd: process.cwd(),
        banner: `watching ${current.key} — Ctrl+C stops watching, the review keeps running`,
      });
      return;
    }
    if (input === "r") {
      const target = current.key;
      return run(`retrying ${target}`, () => actions.retry(target));
    }
    if (input === "x") {
      setStatus(actions.dismiss(current.key));
      return setRows(load());
    }
    if (input === "K") {
      setStatus(actions.kill(current.key));
      return setRows(load());
    }
  });

  return (
    <Box flexDirection="column" width={width}>
      {/* the legend leads: fixed at the top, it cannot be moved around by
          however much assessment the row below it happens to have */}
      <Legend unavailable={unavailable} />
      <Bar
        label="reviews"
        right={rows.length ? `${cursor + 1}/${rows.length}` : "empty"}
        width={width}
      />
      {view === "help" ? (
        <Help unavailable={unavailable} />
      ) : (
        <>
          <Queue rows={rows} cursor={cursor} height={queueHeight} />
          {/* the bar names the row the panel belongs to, so the two regions
              read as queue-then-detail rather than one column of text */}
          <Bar label={current?.key ?? "no selection"} width={width} />
          <Panel lines={panel} />
        </>
      )}
      {footer ? (
        <Text color={status ? "yellow" : "red"} wrap="truncate-end">
          {footer}
        </Text>
      ) : null}
    </Box>
  );
}

// Openers are resolved once here, not per frame; the selected key rides across
// a suspend so the cursor comes back to the PR the user acted on.
export function runTui(ctx: Ctx, actions: TuiActions): Promise<number> {
  // useInput needs raw mode, and Ink throws without a tty. The readline menu
  // this replaced read a closed stdin as "quit", so a script or a cron wrapper
  // that runs bare `reviews` still gets the queue instead of a stack trace.
  if (!process.stdin.isTTY) return Promise.resolve(printPending(ctx));
  const resolved = resolveOpeners(ctx.cfg);
  let selected: string | undefined;
  return suspendLoop((request, notice) =>
    render(
      <App
        cfg={ctx.cfg}
        paths={ctx.paths}
        actions={actions}
        resolved={resolved}
        request={request}
        notice={notice}
        initialKey={selected}
        onSelect={(key) => {
          selected = key;
        }}
      />,
    ),
  );
}
