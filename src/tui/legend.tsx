import { Box, Text } from "ink";

export interface Binding {
  keys: string;
  label: string;
  // Set when the binding hands the terminal to something that may be missing.
  verb?: string;
}

export const KEYMAP: Binding[] = [
  { keys: "j/k ↑/↓", label: "move" },
  { keys: "enter", label: "claude", verb: "claude" },
  { keys: "s", label: "shell", verb: "shell" },
  { keys: "d", label: "diff", verb: "diff" },
  { keys: "w", label: "watch live" },
  { keys: "r", label: "retry" },
  { keys: "x", label: "dismiss" },
  { keys: "K", label: "kill" },
  { keys: "p", label: "poll" },
  { keys: "S", label: "sync" },
  { keys: "?", label: "help" },
  { keys: "q", label: "quit" },
];

// The one-line footer: the per-entry verbs plus the way out.
const FOOTER = ["enter", "s", "d", "w", "x", "?"];

export function Legend({
  unavailable,
}: {
  unavailable: Record<string, string>;
}) {
  const items = KEYMAP.filter((b) => FOOTER.includes(b.keys));
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

export function Help({ unavailable }: { unavailable: Record<string, string> }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>keys</Text>
      {KEYMAP.map((b) => {
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
      <Text dimColor>? or esc closes this</Text>
    </Box>
  );
}
