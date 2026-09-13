import { defineConfig } from 'vitest/config';

/*
 * GitHub Pages deployment
 * ----------------------------------------------------------------------------
 * A project page is served from https://<user>.github.io/<REPOSITORY>/ so every
 * asset URL has to be prefixed with "/<REPOSITORY>/".  The CI workflow exports
 * BASE_PATH=/${{ github.event.repository.name }}/ so the bundle is always
 * correct for whatever the repository ends up being called.  Locally (and for
 * `npm run preview`) we default to "/" so nothing has to be configured.
 *
 * Never hard-code "/assets/..." anywhere in the app - use import.meta.env.BASE_URL
 * (see src/util/assets.ts) or a real `import` of the asset.
 */
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  /*
   * satellite.js ships an optional WebAssembly SGP4 core whose multi-threaded
   * build is an ES module with top-level await. Vite bundles workers as IIFE by
   * default, which cannot express top-level await, so workers are built as ES
   * modules here. Every browser that supports WebGL 2 also supports module
   * workers, so this costs nothing.
   */
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
