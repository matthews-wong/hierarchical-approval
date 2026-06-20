import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'adapters/MemoryAdapter': 'src/adapters/MemoryAdapter.ts',
    'adapters/PostgresAdapter': 'src/adapters/PostgresAdapter.ts',
    testing: 'src/testing/ApprovalTestKit.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
