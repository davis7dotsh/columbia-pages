// Bun inlines `with { type: "text" }` imports as strings, both under
// `bun run` and inside `bun build --compile` binaries.
declare module "*.css" {
  const content: string;
  export default content;
}
