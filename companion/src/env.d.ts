// Bun imports these as plain strings (`with { type: "text" }`).
declare module "*.md" {
  const content: string;
  export default content;
}
// The browser extension's files, embedded by build.ts (src/browser/embedded-bundle.ts).
declare module "*.txt" {
  const content: string;
  export default content;
}
