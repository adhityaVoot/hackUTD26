// The module imports `spacetime:sys@2.x`, which only exists inside the database runtime.
// Tests that load index.ts (reducers, procedures, views) resolve those imports to stubs.
const stub = (v: string) => new URL(`./src/ai/__tests__/stubs/sys${v}.ts`, import.meta.url).pathname;

export default {
  // Inline the SDK so the aliases below apply to its imports too.
  test: { include: ['src/**/*.test.ts'], server: { deps: { inline: ['spacetimedb'] } } },
  resolve: {
    alias: [
      { find: /^spacetime:sys@2\.0$/, replacement: stub('20') },
      { find: /^spacetime:sys@2\.1$/, replacement: stub('21') },
      { find: /^spacetime:sys@2\.2$/, replacement: stub('22') },
    ],
  },
};
