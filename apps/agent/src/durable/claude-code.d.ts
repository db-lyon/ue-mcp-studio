/**
 * pi-claude-code ships as TypeScript source from its git commit, not as a
 * compiled package. The bundler and the tests resolve this name to its
 * src/provider.ts (scripts/bundle-agent.mjs, vitest.config.ts); only pi.ts
 * imports it.
 */
declare module "studio-pi-claude-code" {
  export function createClaudeCodeProvider(): unknown;
}
