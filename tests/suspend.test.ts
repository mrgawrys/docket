import { expect, test } from "bun:test";
import {
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
    const m = { waitUntilExit: () => exited, unmount: () => quit() };
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
    return 0;
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
  const loop = suspendLoop(mount, async () => 3);
  await quitLater(mounts, 1);
  await loop;
  expect(notices).toEqual([undefined, "revdiff exited 3"]);
});

test("suspendLoop exits without spawning when the TUI just quits", async () => {
  let spawns = 0;
  const { mount, mounts } = scripted([() => {}]);
  const loop = suspendLoop(mount, async () => {
    spawns++;
    return 0;
  });
  await quitLater(mounts, 0);
  expect(await loop).toBe(0);
  expect(spawns).toBe(0);
});
