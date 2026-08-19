import { Box, render, Text, useApp, useInput, useWindowSize } from "ink";
import { readFileSync, watch } from "node:fs";
import { dirname } from "node:path";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readAssessment } from "../assessment";
import { claudeAuth } from "../auth";
import {
  readConfigSync,
  runLogPath,
  writeConfigText,
  type Config,
  type Paths,
} from "../config";
import { applySuggestion, type DenialGroup } from "../denials";
import { addable, denialTitle, denialView, TEASER_HEIGHT } from "../denialview";
import {
  buildFreshChat,
  buildHandoff,
  buildResume,
  NO_CLONE_REASON,
  parsePrInput,
  printPending,
} from "../list";
import {
  buildOpener,
  openerContext,
  resolveOpeners,
  resolveEntryWorktree,
  type ResolvedOpeners,
} from "../openers";
import { selfArgs } from "../proc";
import type { Ctx } from "../reviewer";
import {
  entryKind,
  isLiveReview,
  loadState,
  pendingEntries,
  splitKey,
  type Entry,
  type EntryKind,
} from "../state";
import { PANEL_HEIGHT, panelLines } from "../panel";
import { Help, Legend } from "./legend";
import { Panel } from "./panel";
import { Queue, type Row } from "./queue";
import { suspendLoop, type SuspendRequest } from "./suspend";

export interface TuiActions {
  retry(key: string): Promise<number>;
  // The two `n` submits: force-review a PR, or receive feedback on one of the
  // user's own (the latter also behind R). Keys may arrive bare or prefixed.
  review(key: string, note?: string): Promise<number>;
  receive(key: string, note?: string): Promise<number>;
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
  // Broken setup, not a broken review: it belongs to no row, and a logged-out
  // poller writes no entries at all — so without this the queue looks exactly
  // like a morning with no new PRs.
  authWarning?: string;
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
  authWarning,
}: AppProps) {
  const { exit } = useApp();
  const size = useWindowSize();
  const width = size.columns || 80;
  const height = size.rows || 24;

  // Which of the two entry worlds is on screen. A mine initialKey (the cursor
  // riding across a suspend) means the suspend happened in the mine view.
  const [list, setList] = useState<"queue" | "mine">(
    initialKey && entryKind(initialKey) === "mine" ? "mine" : "queue",
  );
  const kind: EntryKind = list === "mine" ? "mine" : "review";
  // Rows are derived, not held: switching views must swap the rows in the
  // same render, or the old world's rows flash under the new view's legend.
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  const rows = useMemo(
    (): Row[] =>
      pendingEntries(loadState(paths.statePath), kind).map(([key, entry]) => ({
        key,
        entry,
      })),
    // generation is the invalidation signal for the state file's content
    [paths.statePath, kind, generation],
  );
  // Per-view cursors, so tabbing away and back lands where the user left.
  const [cursorKeys, setCursorKeys] = useState<
    Partial<Record<"queue" | "mine", string>>
  >(initialKey ? { [list]: initialKey } : {});
  const cursorKey = cursorKeys[list];
  const setCursorKey = useCallback(
    (key: string | undefined) => setCursorKeys((c) => ({ ...c, [list]: key })),
    [list],
  );
  const [view, setView] = useState<"list" | "help" | "denials">("list");
  // Help is a detour, not a destination: esc goes back where it was opened.
  const [helpFrom, setHelpFrom] = useState<"list" | "denials">("list");
  const [status, setStatus] = useState<string | undefined>();
  // The `n` footer input; undefined = closed.
  const [prInput, setPrInput] = useState<string | undefined>();
  // The PR the denials view is reading, pinned when D opened it. Its verbs act
  // on this key and never on the queue cursor, which a finishing poll can move.
  const [denialKey, setDenialKey] = useState<string | undefined>();
  const [scroll, setScroll] = useState(0);
  // `cfg` is the startup snapshot, and every suspend verb remounts App with it
  // — seeding from it would drop the rules `a` wrote before the suspend. Read
  // the file instead; the prop is only the fallback.
  const [liveCfg, setLiveCfg] = useState(() =>
    readConfigSync(paths.configPath, cfg),
  );

  // saveState renames a temp file over state.json, which breaks a watch bound
  // to the file's inode — watch the directory instead.
  useEffect(() => {
    try {
      const w = watch(dirname(paths.statePath), (_ev, file) => {
        if (file === "state.json") reload();
      });
      return () => w.close();
    } catch {
      return; // no watch is survivable: every action reloads anyway
    }
  }, [paths.statePath, reload]);

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
  }, [current, onSelect, setCursorKey]);
  const summary = current?.entry.summary;
  // Only read when the panel would actually fall back to it: with a headline
  // recorded on the entry, the run log has nothing left to tell this view.
  // A mine entry with no run yet shows what sync recorded instead: their
  // verdict and who left it.
  const assessment = useMemo(() => {
    if (!current || summary?.headline)
      return { kind: "none", reason: "" } as const;
    const a = readAssessment(runLogPath(paths, current.key));
    if (a.kind === "none" && kind === "mine" && current.entry.reviewer) {
      return {
        kind: "text",
        text: `${current.entry.status} by ${current.entry.reviewer} — feedback awaiting you`,
      } as const;
    }
    return a;
  }, [current, summary, paths, kind]);

  // A failed run has no session to resume, which is exactly where the denials
  // are: enter was dead on the one row that most needed it. There it resolves
  // them instead.
  const enterResolves = useMemo(() => {
    if (!current?.entry.denials?.length || !current.entry.local_path)
      return false;
    return "error" in buildResume(current.entry, cfg, kind);
  }, [current, cfg, kind]);

  // Computed per row, never per keypress: a verb the machine cannot run is
  // greyed in the legend with its reason in the preview, not a dead key.
  const unavailable = useMemo(() => {
    const u: Record<string, string> = {};
    if (!current) return u;
    const resume = buildResume(current.entry, cfg, kind);
    // Not greyed when enter resolves: it still opens claude, just on the
    // denials rather than on a session that was never written. In the mine
    // view a fresh chat in the checkout is the second fallback.
    if ("error" in resume && !enterResolves) {
      if (kind !== "mine") {
        u.claude = resume.error;
      } else {
        const fresh = buildFreshChat(current.entry, cfg);
        if ("error" in fresh) u.claude = fresh.error;
      }
    }
    const wt = resolveEntryWorktree(current.key, current.entry);
    for (const verb of ["shell", "diff"]) {
      if (!resolved[verb]) u[verb] = `no ${verb} opener found on PATH`;
      else if ("missing" in wt) u[verb] = wt.missing;
    }
    if (kind === "mine") {
      // Only the statically known reasons grey R: a dirty/ahead checkout is
      // found out by the trigger flow (probing git per row per render is too
      // heavy) and lands in the panel as skipped + reason.
      const { repo } = splitKey(current.key);
      if (!current.entry.local_path && !(repo in liveCfg.repos)) {
        u.receive = NO_CLONE_REASON;
      } else if (isLiveReview(current.entry)) {
        u.receive = "a run is already in flight — w watches it";
      }
    }
    if (!current.entry.denials?.length) u.denials = "no denials recorded";
    if (!current.entry.local_path) {
      u.handoff = NO_CLONE_REASON;
    } else if (!current.entry.denials?.length) {
      u.handoff = "no denials recorded";
    }
    return u;
  }, [current, cfg, resolved, enterResolves, kind, liveCfg]);

  const notes = useMemo(() => {
    const byReason = new Map<string, string[]>();
    for (const [verb, reason] of Object.entries(unavailable)) {
      // A review that tripped no denials is the normal case, not a machine
      // this verb cannot run on: the greyed key says it, the panel need not.
      if (verb === "denials" || verb === "handoff") continue;
      byReason.set(reason, [...(byReason.get(reason) ?? []), verb]);
    }
    return [...byReason].map(
      ([reason, verbs]) => `${verbs.join("/")}: ${reason}`,
    );
  }, [unavailable]);

  // Last in line: action feedback is what the user just asked for, so it takes
  // the line while it lasts. The warning is still there when it clears. An
  // open `n` input takes the same row, so it counts as a footer for layout.
  const footer =
    prInput !== undefined ? "input" : (status ?? notice ?? authWarning);
  const footerColor =
    notice !== undefined && footer === notice ? "red" : "yellow";
  const queueHeight = Math.max(
    1,
    Math.min(rows.length || 1, Math.min(10, height - 8)),
  );
  const denials = current?.entry.denials;
  // Bounded, and it shrinks with the terminal — the panel never takes the
  // screen away from the queue the way the old scrolling pane did. The `- 3`
  // is the two bars plus the row the frame must leave spare: fill every row
  // and the terminal scrolls the whole thing on each render. A run with
  // denials asks for the teaser's rows on top of the summary's.
  const panelHeight = Math.max(
    1,
    Math.min(
      PANEL_HEIGHT + (denials?.length ? TEASER_HEIGHT + 1 : 0),
      height - 1 - queueHeight - 3 - (footer ? 1 : 0),
    ),
  );
  const panel = useMemo(
    () =>
      panelLines({
        summary,
        assessment,
        notes,
        denials,
        cfg: liveCfg,
        kind,
        enterResolves,
        width: width - 2,
        height: panelHeight,
      }),
    [
      summary,
      assessment,
      notes,
      denials,
      liveCfg,
      kind,
      enterResolves,
      width,
      panelHeight,
    ],
  );

  // The view reads the PR D was pressed on, not whatever the queue cursor has
  // drifted to since — retrying the wrong row bills a second review. Its kind
  // rides with the key, so the rules aim at the right allowlist.
  const denialRow = rows.find((r) => r.key === denialKey);
  const denialKind: EntryKind = denialKey ? entryKind(denialKey) : kind;
  const viewGroups = denialRow?.entry.denials ?? [];
  // The denials view takes the whole region below the bars: legend, the two
  // bars and the row the frame must leave spare (see panelHeight).
  const denialPanel = useMemo(
    () =>
      denialView({
        groups: viewGroups,
        kind: denialKind,
        cfg: liveCfg,
        scroll,
        width: width - 2,
        height: Math.max(1, height - 4 - (footer ? 1 : 0)),
      }),
    [viewGroups, denialKind, liveCfg, scroll, width, height, footer],
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
      .finally(reload);
  };

  // Reached from the queue and from the denials view, on the same terms.
  const handOff = (key: string, entry: Entry, groups: DenialGroup[]) => {
    const r = buildHandoff(entry, liveCfg, paths, key, groups, entryKind(key));
    if ("error" in r) return setStatus(`hand off: ${r.error}`);
    request({
      ...r,
      banner: `hand off: ${key}`,
      // an interactive claude session's exit status is whatever the user last
      // ran in it, not a verdict on the hand-off
      interactive: true,
    });
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

  // The `n` submit: parse, then hand to the view's verb — review a PR from
  // the queue, receive feedback on one of the user's own from the mine view.
  const submitPr = (text: string) => {
    setPrInput(undefined);
    const r = parsePrInput(text, liveCfg);
    if ("error" in r) return setStatus(r.error);
    if (list === "mine") {
      setCursorKey(entryKind(r.key) === "mine" ? r.key : `mine:${r.key}`);
      return run(`receiving ${r.key}`, () => actions.receive(r.key, r.note));
    }
    setCursorKey(r.key);
    run(`reviewing ${r.key}`, () => actions.review(r.key, r.note));
  };

  useInput((input, key) => {
    if (prInput !== undefined) {
      // The footer input owns the keyboard while it is open.
      if (key.escape) return setPrInput(undefined);
      if (key.return) return submitPr(prInput);
      if (key.backspace || key.delete) return setPrInput(prInput.slice(0, -1));
      if (input && !key.ctrl && !key.meta) return setPrInput(prInput + input);
      return;
    }
    if (input === "q") return exit(); // quits from any view, help included
    if (view === "help") {
      if (input === "?" || key.escape) setView(helpFrom);
      return;
    }
    if (view === "denials") {
      if (input === "D" || key.escape) return setView("list");
      if (input === "?") {
        setHelpFrom("denials");
        return setView("help");
      }
      if (input === "j" || key.downArrow)
        return setScroll(Math.min(denialPanel.maxScroll, scroll + 1));
      if (input === "k" || key.upArrow)
        return setScroll(Math.max(0, scroll - 1));
      if (input === "a") {
        // One write for N rules: the selector decides which, so what the action
        // line promised and what reaches the config are the same set.
        const { add } = addable(viewGroups, liveCfg, denialKind);
        if (!add.length) return setStatus("nothing to add");
        try {
          let text = readFileSync(paths.configPath, "utf8");
          for (const g of add)
            text = applySuggestion(text, g.suggestion, denialKind);
          writeConfigText(paths.configPath, text);
          setLiveCfg(JSON.parse(text) as Config);
          setStatus(`added ${add.length} rule${add.length === 1 ? "" : "s"}`);
        } catch (e) {
          setStatus(`add failed: ${e}`);
        }
        return;
      }
      if (input === "r" && denialRow) {
        const target = denialRow.key;
        return run(`retrying ${target}`, () => actions.retry(target));
      }
      if (key.return) {
        if (!denialRow) return;
        return handOff(denialRow.key, denialRow.entry, viewGroups);
      }
      return;
    }
    if (input === "?") {
      setHelpFrom("list");
      return setView("help");
    }
    if (key.tab) return setList(list === "queue" ? "mine" : "queue");
    if (input === "n") return setPrInput("");
    if (input === "j" || key.downArrow) return move(1);
    if (input === "k" || key.upArrow) return move(-1);
    if (input === "p") return run("polling", actions.poll);
    if (input === "S") return run("syncing", actions.sync);
    if (!current) return;
    if (key.return) {
      // enter opens claude either way: the review's own session when there is
      // one, and otherwise the denials of a run that failed before it made one.
      if (enterResolves)
        return handOff(current.key, current.entry, current.entry.denials ?? []);
      const r = buildResume(current.entry, cfg, kind);
      if ("error" in r) {
        // Mine view: no session yet, but the checkout is there — a fresh chat
        // in it beats a dead key.
        if (kind === "mine") {
          const fresh = buildFreshChat(current.entry, cfg);
          if (!("error" in fresh)) return request(fresh);
          return setStatus(`${current.key} ${fresh.error}`);
        }
        return setStatus(`${current.key} ${r.error}`);
      }
      request({
        argv: r.argv,
        cwd: r.cwd,
        env: r.env,
        banner: `resuming ${current.key}`,
      });
      return;
    }
    if (input === "R" && kind === "mine") {
      if (unavailable.receive)
        return setStatus(`${current.key}: ${unavailable.receive}`);
      const target = current.key;
      return run(`receiving ${target}`, () => actions.receive(target));
    }
    if (input === "D") {
      if (!denials?.length) return setStatus(`${current.key}: no denials`);
      setDenialKey(current.key);
      setScroll(0);
      return setView("denials");
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
      return reload();
    }
    if (input === "K") {
      setStatus(actions.kill(current.key));
      return reload();
    }
  });

  return (
    <Box flexDirection="column" width={width}>
      {/* the legend leads: fixed at the top, it cannot be moved around by
          however much assessment the row below it happens to have */}
      <Legend
        view={view === "denials" ? "denials" : list}
        unavailable={unavailable}
      />
      <Bar
        label={list === "mine" ? "docket · my PRs" : "docket"}
        right={rows.length ? `${cursor + 1}/${rows.length}` : "empty"}
        width={width}
      />
      {view === "help" ? (
        <Help unavailable={unavailable} />
      ) : view === "denials" ? (
        <>
          <Bar
            label={`denials: ${denialKey ?? ""}`}
            right={viewGroups.length ? denialTitle(viewGroups) : undefined}
            width={width}
          />
          <Panel lines={denialPanel.lines} />
        </>
      ) : (
        <>
          <Queue rows={rows} cursor={cursor} height={queueHeight} />
          {/* the bar names the row the panel belongs to, so the two regions
              read as queue-then-detail rather than one column of text */}
          <Bar label={current?.key ?? "no selection"} width={width} />
          <Panel lines={panel} />
        </>
      )}
      {prInput !== undefined ? (
        <Text color="cyan" wrap="truncate-end">
          {list === "mine" ? "receive" : "review"} PR ▸ {prInput}█{" "}
          <Text dimColor>
            (URL or ORG/REPO#N, then a note · enter runs, esc cancels)
          </Text>
        </Text>
      ) : footer ? (
        <Text color={footerColor} wrap="truncate-end">
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
  // that runs bare `docket` still gets the queue instead of a stack trace.
  if (!process.stdin.isTTY) return Promise.resolve(printPending(ctx));
  const resolved = resolveOpeners(ctx.cfg);
  // Probed once, like the openers — it costs a subprocess, and the answer
  // cannot change while the queue is on screen. `unknown` stays quiet, the
  // same way the poller carries on rather than blocking on a broken probe.
  const auth = claudeAuth(ctx.cfg);
  const authWarning =
    "ok" in auth && !auth.ok
      ? `claude is not logged in (${auth.dir}) — run: docket doctor`
      : undefined;
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
        authWarning={authWarning}
        initialKey={selected}
        onSelect={(key) => {
          selected = key;
        }}
      />,
    ),
  );
}
