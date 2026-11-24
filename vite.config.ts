import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // Keep the controller's math in the entry without pulling in WebGL.
    alias: [{ find: /^three$/, replacement: 'three/src/Three.js' }],
  },
});
