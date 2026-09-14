// Shared Vite settings; the real build is driven by scripts/build.mjs which
// invokes Vite three times (main-world IIFE, content IIFE, background ESM).
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@shared': r('./src/shared'), '@main': r('./src/main'), '@ui': r('./src/ui') },
  },
});
