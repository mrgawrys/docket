import { Box, Text } from "ink";
import type { PanelLine } from "../panel";

// minHeight pads short content with blank rows, so what follows the panel
// stays put as the cursor moves between a one-line and a four-line headline.
export function Panel({
  lines,
  minHeight = 0,
}: {
  lines: PanelLine[];
  minHeight?: number;
}) {
  return (
    <Box flexDirection="column" paddingX={1} minHeight={minHeight}>
      {lines.map((line, i) => (
        <Text
          key={`${i}:${line.text}`}
          color={line.color}
          dimColor={line.dim}
          wrap="truncate-end"
        >
          {line.text}
        </Text>
      ))}
    </Box>
  );
}
