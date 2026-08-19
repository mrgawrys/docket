import { Box, Text } from "ink";

export interface Binding {
  keys: string;
  label: string;
  // Set when the binding hands the terminal to something that may be missing.
  verb?: string;
}

export type KeymapView = "queue" | "mine" | "denials";

export const QUEUE_KEYS: Binding[] = [
  { keys: "j/k ↑/↓", label: "move" },
  { keys: "tab", label: "my PRs" },
  { keys: "enter", label: "claude", verb: "claude" },
  { keys: "s", label: "shell", verb: "shell" },
  { keys: "d", label: "diff", verb: "diff" },
  { keys: "D", label: "denials", verb: "denials" },
  { keys: "w", label: "watch live" },
  { keys: "r", label: "retry" },
  { keys: "n", label: "review a PR by hand" },
  { keys: "x", label: "dismiss" },
  { keys: "K", label: "kill" },
  { keys: "p", label: "poll" },
  { keys: "S", label: "sync" },
  { keys: "?", label: "help" },
  { keys: "q", label: "quit" },
];

// The mine view: the user's own PRs. Same movement, receive instead of retry
// as the run verb, and every working verb aimed at the PR branch's checkout.
export const MINE_KEYS: Binding[] = [
  { keys: "j/k ↑/↓", label: "move" },
  { keys: "tab", label: "queue" },
  { keys: "enter", label: "claude", verb: "claude" },
  { keys: "s", label: "shell", verb: "shell" },
  { keys: "d", label: "diff", verb: "diff" },
  { keys: "R", label: "receive now", verb: "receive" },
  { keys: "D", label: "denials", verb: "denials" },
  { keys: "w", label: "watch live" },
  { keys: "r", label: "retry" },
  { keys: "n", label: "receive a PR by hand" },
  { keys: "x", label: "dismiss" },
  { keys: "K", label: "kill" },
  { keys: "p", label: "poll" },
  { keys: "S", label: "sync" },
  { keys: "?", label: "help" },
  { keys: "q", label: "quit" },
];

// The denials view is a mode, not a panel: its own keys, its own way out. The
// verbs are spelled out in full in the view's action block; what the legend
// adds is how to move and how to leave.
export const DENIAL_KEYS: Binding[] = [
  { keys: "enter", label: "hand all of it to claude", verb: "handoff" },
  { keys: "a", label: "add every safe rule to your config" },
  { keys: "r", label: "re-run this review" },
  { keys: "j/k ↑/↓", label: "scroll" },
  { keys: "esc D", label: "back to the queue" },
  { keys: "?", label: "help" },
  { keys: "q", label: "quit" },
];

const KEYMAPS: Record<KeymapView, Binding[]> = {
  queue: QUEUE_KEYS,
  mine: MINE_KEYS,
  denials: DENIAL_KEYS,
};

// The one-line footer: the per-entry verbs plus the way out.
const FOOTER: Record<KeymapView, string[]> = {
  queue: ["tab", "enter", "s", "d", "D", "w", "x", "?"],
  mine: ["tab", "enter", "s", "d", "R", "D", "x", "?"],
  denials: ["j/k ↑/↓", "esc D", "?", "q"],
};

export function Legend({
  view = "queue",
  unavailable,
}: {
  view?: KeymapView;
  unavailable: Record<string, string>;
}) {
  const items = KEYMAPS[view].filter((b) => FOOTER[view].includes(b.keys));
  return (
    <Box>
      {items.map((b, i) => {
        const off = b.verb !== undefined && b.verb in unavailable;
        return (
          <Text key={b.keys} color={off ? "gray" : undefined} dimColor={off}>
            {i > 0 ? " · " : ""}
            <Text bold={!off}>{b.keys}</Text> {b.label}
          </Text>
        );
      })}
    </Box>
  );
}

function Keys({
  title,
  bindings,
  unavailable,
}: {
  title: string;
  bindings: Binding[];
  unavailable: Record<string, string>;
}) {
  return (
    <>
      <Text bold>{title}</Text>
      {bindings.map((b) => {
        const reason = b.verb !== undefined ? unavailable[b.verb] : undefined;
        return (
          <Box key={b.keys}>
            <Box width={12}>
              <Text bold color={reason ? "gray" : "cyan"}>
                {b.keys}
              </Text>
            </Box>
            <Text color={reason ? "gray" : undefined}>{b.label}</Text>
            {reason ? <Text color="gray"> — {reason}</Text> : null}
          </Box>
        );
      })}
    </>
  );
}

export function Help({ unavailable }: { unavailable: Record<string, string> }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Keys title="queue" bindings={QUEUE_KEYS} unavailable={unavailable} />
      <Keys
        title="my PRs view"
        bindings={MINE_KEYS}
        unavailable={unavailable}
      />
      <Keys
        title="denials view"
        bindings={DENIAL_KEYS}
        unavailable={unavailable}
      />
      <Text dimColor>? or esc closes this</Text>
    </Box>
  );
}
