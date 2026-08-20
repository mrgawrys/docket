import { basename } from "node:path";

// What the TUI asks for when a verb hands the terminal to another program.
export interface SuspendRequest {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  // Printed after Ink is gone: the only feedback while the child owns the screen.
  banner?: string;
  // A session the user ends themselves: its exit status is whatever they last
  // ran in it, so it says nothing about whether the hand-off worked.
  interactive?: boolean;
}

export interface SpawnOutcome {
  code: number;
  // Set when the child never started — a clone that was deleted, a claude_bin
  // that no longer exists. Distinct from a child that ran and failed.
  error?: string;
}

export type Spawner = (req: SuspendRequest) => Promise<SpawnOutcome>;

export interface Mounted {
  waitUntilExit(): Promise<unknown>;
  unmount(): void;
  // Erases the rendered frame; unmount alone leaves it on screen.
  clear(): void;
}

export type Mount = (
  request: (req: SuspendRequest) => void,
  notice?: string,
) => Mounted;

// A suspended child shares our process group, so a Ctrl+C meant for it also
// reaches us. Anything that installs its own SIGINT handler — a poll started
// with `p` and still running — has to know the signal was not aimed at it.
let childCount = 0;
export const childOwnsTerminal = (): boolean => childCount > 0;

export const spawnInherit: Spawner = async (req) => {
  // An interactive child (a shell, claude) takes the terminal's foreground
  // process group, which leaves our own reader reading from the background:
  // that read fails with EIO and kills stdin for good. Unmounting Ink is not
  // enough — it drops raw mode but not Bun's reader — so pause it explicitly.
  process.stdin.pause();
  // Ctrl+C reaches the whole foreground process group, and the child shares
  // ours. `w` is meant to end that way, so the parent has to survive it — a JS
  // handler is reset to the default on exec, so the child still dies.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  childCount++;
  try {
    const p = Bun.spawn(req.argv, {
      cwd: req.cwd,
      env: { ...process.env, ...(req.env ?? {}) } as Record<string, string>,
      stdio: ["inherit", "inherit", "inherit"],
    });
    return { code: await p.exited };
  } catch (e) {
    // Bun.spawn throws synchronously on a missing cwd or a missing binary.
    // Uncaught it would unwind past the unmounted Ink and take the queue with
    // it, so a hand-off that cannot start comes back as a footer line instead.
    return {
      code: 127,
      error: `${req.argv[0] ?? "?"}: ${(e as Error).message}`,
    };
  } finally {
    childCount--;
    process.off("SIGINT", ignore);
    process.stdin.resume();
  }
};

// Only a child that ended in a way the user did not ask for is worth reporting:
// 130 is the Ctrl+C that `w` documents, and an interactive session carries the
// status of the last command run inside it.
const failureOf = (req: SuspendRequest, code: number): string | undefined =>
  code === 0 || code === 130 || req.interactive
    ? undefined
    : `${basename(req.argv[0] ?? "?")} exited ${code}`;

// Ink and a child with inherited stdio cannot both own the terminal, so a verb
// unmounts, lets the child run, then mounts again — a fresh mount, which is
// also what re-reads state.json a resumed claude session may have changed.
export async function suspendLoop(
  mount: Mount,
  spawn: Spawner = spawnInherit,
): Promise<number> {
  let notice: string | undefined;
  // The status of the last child that failed for a reason of ours, so a
  // resumed session that died still shows up in `docket && next-step`.
  let code = 0;
  for (;;) {
    let pending: SuspendRequest | undefined;
    let ui: Mounted | undefined;
    ui = mount((req) => {
      pending = req;
      ui?.clear();
      ui?.unmount();
    }, notice);
    if (pending) {
      // requested during the first render, before ui was set
      ui.clear();
      ui.unmount();
    }
    await ui.waitUntilExit();
    if (!pending) return code;

    if (pending.banner) console.log(pending.banner);
    const out = await spawn(pending);
    notice = out.error ?? failureOf(pending, out.code);
    code = notice ? out.code : 0;
    // The child left the cursor wherever it stopped; without this the next
    // frame renders under its output, and under the banner, instead of where
    // the queue was.
    if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
  }
}
