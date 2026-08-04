import { basename } from "node:path";

// What the TUI asks for when a verb hands the terminal to another program.
export interface SuspendRequest {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  // Printed after Ink is gone: the only feedback while the child owns the screen.
  banner?: string;
}

export type Spawner = (req: SuspendRequest) => Promise<number>;

export interface Mounted {
  waitUntilExit(): Promise<unknown>;
  unmount(): void;
}

export type Mount = (
  request: (req: SuspendRequest) => void,
  notice?: string,
) => Mounted;

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
  try {
    const p = Bun.spawn(req.argv, {
      cwd: req.cwd,
      env: { ...process.env, ...(req.env ?? {}) } as Record<string, string>,
      stdio: ["inherit", "inherit", "inherit"],
    });
    return await p.exited;
  } finally {
    process.off("SIGINT", ignore);
    process.stdin.resume();
  }
};

// Ink and a child with inherited stdio cannot both own the terminal, so a verb
// unmounts, lets the child run, then mounts again — a fresh mount, which is
// also what re-reads state.json a resumed claude session may have changed.
export async function suspendLoop(
  mount: Mount,
  spawn: Spawner = spawnInherit,
): Promise<number> {
  let notice: string | undefined;
  for (;;) {
    let pending: SuspendRequest | undefined;
    let ui: Mounted | undefined;
    ui = mount((req) => {
      pending = req;
      ui?.unmount();
    }, notice);
    if (pending) ui.unmount(); // requested during the first render, before ui was set
    await ui.waitUntilExit();
    if (!pending) return 0;

    if (pending.banner) console.log(pending.banner);
    const code = await spawn(pending);
    notice =
      code === 0
        ? undefined
        : `${basename(pending.argv[0] ?? "?")} exited ${code}`;
  }
}
