import { Box, Text } from "ink";
import type { PanelLine } from "../panel";

export function Panel({ lines }: { lines: PanelLine[] }) {
  return (
    <Box flexDirection="column" paddingX={1}>
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
