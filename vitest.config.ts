import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@shared': r('./src/shared'), '@main': r('./src/main'), '@ui': r('./src/ui') },
  },
  define: { __EXT_VERSION__: JSON.stringify('test') },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
  },
});
