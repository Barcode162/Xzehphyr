import { defineConfig } from 'vite';

// Everything is served locally. No analytics, no telemetry, no external requests.
// Cross-origin isolation enables finer performance.now() resolution (Chromium) and
// performance.measureUserAgentSpecificMemory(). Safe because the app loads nothing external.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './',
  server: { host: true, port: 5173, headers: isolation },
  preview: { host: true, port: 4173, headers: isolation },
  build: {
    target: 'es2020',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as any);
