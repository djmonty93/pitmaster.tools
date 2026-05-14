// Vite ?raw imports — picked up by vitest's Vite-based test runner and
// turned into a string at transform time. Type declaration so tsc
// doesn't reject the import in test files.
declare module '*?raw' {
  const content: string;
  export default content;
}
