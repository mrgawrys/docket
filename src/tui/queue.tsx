import { Box, Text } from "ink";
import { denialChip } from "../denialview";
import type { Entry, Status } from "../state";
import { issueChip, riskChip } from "../summary";

export interface Row {
  key: string;
  entry: Entry;
}

const STATUS_COLOR: Partial<Record<Status, string>> = {
  open: "blue",
  ready: "green",
  reviewing: "cyan",
  failed: "red",
  canceled: "red",
  skipped: "gray",
  approved: "green",
  "changes-requested": "red",
  commented: "yellow",
};

// Keep the cursor inside the visible window without jumping it to the middle
// on every move.
function windowStart(cursor: number, count: number, height: number): number {
  if (count <= height) return 0;
  return Math.max(0, Math.min(cursor - Math.floor(height / 2), count - height));
}

export function Queue({
  rows,
  cursor,
  height,
}: {
  rows: Row[];
  cursor: number;
  height: number;
}) {
  if (rows.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>
          No pending reviews — p polls GitHub, S syncs, q quits.
        </Text>
      </Box>
    );
  }
  const start = windowStart(cursor, rows.length, height);
  const keyWidth = Math.min(34, Math.max(...rows.map((r) => r.key.length)) + 1);
  // The other chips hold their column whether or not the row fills it, so the
  // grid stays a grid. This one is rarer than it is wide: with nothing in the
  // queue to show, its six columns go back to the title.
  const anyDenials = rows.some((r) => r.entry.denials?.length);
  return (
    <Box flexDirection="column">
      {rows.slice(start, start + height).map(({ key, entry }, i) => {
        const index = start + i;
        const selected = index === cursor;
        const flags = (entry.flags ?? []).map((f) => `+${f}`).join(" ");
        return (
          // only the title may shrink; without this a long row pulls the
          // columns of that one row out of alignment with its neighbours
          <Box key={key} flexShrink={0}>
            <Box flexShrink={0}>
              <Text color="cyan">{selected ? "▸ " : "  "}</Text>
              <Text dimColor>{String(index + 1).padStart(2)} </Text>
              <Text bold={selected}>{key.padEnd(keyWidth)}</Text>
            </Box>
            <Box width={18} flexShrink={0}>
              <Text color={STATUS_COLOR[entry.status]} wrap="truncate-end">
                {entry.status}
              </Text>
            </Box>
            {/* fixed widths, so an entry with no summary leaves a gap rather
                than shifting every other row's columns out of line */}
            {/* "⚠ 12 issues" is 11 wide; anything narrower collides with the
                risk chip */}
            <Box width={12} flexShrink={0}>
              <Text color={issueChip(entry.summary)?.color} wrap="truncate-end">
                {issueChip(entry.summary)?.text ?? ""}
              </Text>
            </Box>
            <Box width={5} flexShrink={0}>
              <Text color={riskChip(entry.summary)?.color} wrap="truncate-end">
                {riskChip(entry.summary)?.text ?? ""}
              </Text>
            </Box>
            {/* "⊘ 999" is 5 wide; the sixth column is the gap before the
                flags, which have none of their own on the left */}
            {anyDenials ? (
              <Box width={6} flexShrink={0}>
                <Text
                  color={denialChip(entry.denials)?.color}
                  wrap="truncate-end"
                >
                  {denialChip(entry.denials)?.text ?? ""}
                </Text>
              </Box>
            ) : null}
            {flags ? (
              <Box flexShrink={0}>
                <Text color="yellow">{flags} </Text>
              </Box>
            ) : null}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor={!selected} wrap="truncate-end">
                {entry.title ?? ""}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
