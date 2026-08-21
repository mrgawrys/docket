import { expect, test } from "bun:test";
import {
  spawnInherit,
  suspendLoop,
  type Mount,
  type Mounted,
  type SuspendRequest,
} from "../src/tui/suspend";

type Round = (request: (r: SuspendRequest) => void) => void;

// A mount that plays scripted actions instead of rendering Ink: each round runs
// its action once mounted, and `mounts[i].unmount()` stands in for quitting.
function scripted(rounds: Round[]): {
  mount: Mount;
  mounts: Mounted[];
  notices: (string | undefined)[];
} {
  const mounts: Mounted[] = [];
  const notices: (string | undefined)[] = [];
  const mount: Mount = (request, notice) => {
    notices.push(notice);
    const act = rounds[mounts.length];
    let quit!: () => void;
    const exited = new Promise<void>((res) => {
      quit = res;
    });
    const m = {
      waitUntilExit: () => exited,
      unmount: () => quit(),
      clear() {},
    };
    mounts.push(m);
    queueMicrotask(() => act?.(request));
    return m;
  };
  return { mount, mounts, notices };
}

const req = (bin: string): SuspendRequest => ({ argv: [bin], cwd: "/tmp" });
const quitLater = async (m: Mounted[], i: number) => {
  await Bun.sleep(10);
  m[i]!.unmount();
};

test("suspendLoop runs the child between mounts and remounts after it exits", async () => {
  const spawned: string[] = [];
  const { mount, mounts } = scripted([
    (request) => request(req("/usr/bin/editor")),
    () => {}, // the second mount asks for nothing; quitting it ends the loop
  ]);
  const loop = suspendLoop(mount, async (r) => {
    spawned.push(r.argv[0]!);
    return { code: 0 };
  });
  await quitLater(mounts, 1);
  expect(await loop).toBe(0);
  expect(spawned).toEqual(["/usr/bin/editor"]);
  expect(mounts).toHaveLength(2);
});

test("suspendLoop carries a non-zero child exit into the next mount as a notice", async () => {
  const { mount, mounts, notices } = scripted([
    (request) => request(req("/usr/bin/revdiff")),
    () => {},
  ]);
  const loop = suspendLoop(mount, async () => ({ code: 3 }));
  await quitLater(mounts, 1);
  expect(await loop).toBe(3); // and out to a wrapper that branches on it
  expect(notices).toEqual([undefined, "revdiff exited 3"]);
});

test("the ways a child is meant to end are not reported as failures", async () => {
  // `w` documents Ctrl+C as the way out, and a shell exits with the status of
  // whatever the user last ran in it — neither is ours to call a failure.
  for (const [req, code] of [
    [{ argv: ["/bin/docket"], cwd: "/tmp" }, 130],
    [{ argv: ["/bin/zsh"], cwd: "/tmp", interactive: true }, 1],
  ] as [SuspendRequest, number][]) {
    const { mount, mounts, notices } = scripted([(r) => r(req), () => {}]);
    const loop = suspendLoop(mount, async () => ({ code }));
    await quitLater(mounts, 1);
    expect(await loop).toBe(0);
    expect(notices).toEqual([undefined, undefined]);
  }
});

test("a child that could not start reports instead of taking the loop down", async () => {
  const { mount, mounts, notices } = scripted([
    (request) => request(req("/gone/claude")),
    () => {},
  ]);
  const loop = suspendLoop(mount, async () => ({
    code: 127,
    error: "/gone/claude: ENOENT",
  }));
  await quitLater(mounts, 1);
  expect(await loop).toBe(127);
  expect(notices).toEqual([undefined, "/gone/claude: ENOENT"]);
});

test("spawnInherit turns a spawn that throws into an error outcome", async () => {
  // Bun.spawn throws synchronously on a missing cwd; uncaught it unwinds past
  // the already-unmounted Ink and kills the whole TUI.
  const out = await spawnInherit({ argv: ["/bin/echo"], cwd: "/no/such/dir" });
  expect(out.code).not.toBe(0);
  expect(out.error).toContain("/bin/echo");
});

test("suspendLoop exits without spawning when the TUI just quits", async () => {
  let spawns = 0;
  const { mount, mounts } = scripted([() => {}]);
  const loop = suspendLoop(mount, async () => {
    spawns++;
    return { code: 0 };
  });
  await quitLater(mounts, 0);
  expect(await loop).toBe(0);
  expect(spawns).toBe(0);
});
