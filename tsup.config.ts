import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'adapters/MemoryAdapter': 'src/adapters/MemoryAdapter.ts',
    'adapters/PostgresAdapter': 'src/adapters/PostgresAdapter.ts',
    testing: 'src/testing/ApprovalTestKit.ts',
    nestjs: 'src/nestjs/index.ts',
    'plugins/audit': 'src/plugins/audit/index.ts',
    'plugins/metrics': 'src/plugins/metrics/index.ts',
    'plugins/notify': 'src/plugins/notify/index.ts',
    'plugins/resilience': 'src/plugins/resilience/index.ts',
    'plugins/tracing': 'src/plugins/tracing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
