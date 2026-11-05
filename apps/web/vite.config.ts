import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const outDir = resolve(import.meta.dirname, '../api/public');

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'keep-gitkeep',
      closeBundle() {
        writeFileSync(resolve(outDir, '.gitkeep'), '');
      },
    },
  ],
  build: { outDir, emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
