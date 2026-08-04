import { Box, Text } from "ink";

// Wrap here rather than letting the terminal do it: scrolling counts lines, and
// a line the pane never counted would scroll past content.
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      let w = word;
      while (w.length > width) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= width) line += ` ${w}`;
      else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

export function Preview({
  lines,
  notes,
  height,
  scroll,
  dim,
}: {
  lines: string[];
  notes: string[];
  height: number;
  scroll: number;
  dim: boolean;
}) {
  const room = Math.max(1, height - notes.length);
  return (
    <Box flexDirection="column" paddingX={1}>
      {notes.map((n) => (
        <Text key={n} color="yellow" wrap="truncate-end">
          {n}
        </Text>
      ))}
      {lines.slice(scroll, scroll + room).map((line, i) => (
        <Text key={`${scroll + i}:${line}`} dimColor={dim} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}
