import { Box, Text } from "ink";

// Wrap here rather than letting the terminal do it: scrolling counts lines, and
// a line the pane never counted would scroll past content.
export function wrapText(text: string, rawWidth: number): string[] {
  // A pane can be narrower than a single column. At width 0 the slicing below
  // never shortens the word, and the loop spins on the render thread forever.
  const width = Math.max(1, rawWidth);
  const out: string[] = [];
  for (const para of text.split("\n")) {
    // Assessments are markdown: leading spaces are what tell a nested bullet
    // from its parent and a quoted snippet from the prose around it. Wrap
    // inside the indent and re-apply it, rather than letting split(" ") eat it.
    const indent = /^ */.exec(para)?.[0] ?? "";
    const avail = Math.max(1, width - indent.length);
    const push = (s: string) => out.push(indent + s);
    let line = "";
    for (const word of para.slice(indent.length).split(" ")) {
      let w = word;
      while (w.length > avail) {
        if (line) {
          push(line);
          line = "";
        }
        push(w.slice(0, avail));
        w = w.slice(avail);
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= avail) line += ` ${w}`;
      else {
        push(line);
        line = w;
      }
    }
    push(line);
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
  // Rows for the assessment itself; the caller has already taken the notes out,
  // because it needs the same number to clamp scrolling.
  height: number;
  scroll: number;
  dim: boolean;
}) {
  return (
    <Box flexDirection="column" paddingX={1}>
      {notes.map((n) => (
        <Text key={n} color="yellow" wrap="truncate-end">
          {n}
        </Text>
      ))}
      {lines.slice(scroll, scroll + height).map((line, i) => (
        <Text key={`${scroll + i}:${line}`} dimColor={dim} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}
