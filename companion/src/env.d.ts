// Bun imports these as plain strings (`with { type: "text" }`).
declare module "*.md" {
  const content: string;
  export default content;
}
