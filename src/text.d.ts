// Markdown imported with `{ type: "text" }` — Bun hands back the file's raw
// text, which TypeScript has no built-in notion of.
declare module "*.md" {
  const content: string;
  export default content;
}
