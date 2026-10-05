import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      '/api': {
        target: 'http://localhost:4001',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Everything used to land in one ~2.1 MB chunk, so the first visit
        // downloaded the charting, diagramming and animation libraries before
        // the login form could render -- and any change to any page
        // invalidated the whole thing for every returning user.
        //
        // Split by what changes together rather than by page: these four are
        // large, versioned dependencies that change only when they are
        // upgraded, so once cached they stay cached across deploys. App code
        // is left as one chunk on purpose -- the pages share enough state and
        // components that splitting them produces a web of tiny
        // cross-importing chunks for very little gain.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          diagram: ['@xyflow/react', '@dagrejs/dagre'],
          motion: ['framer-motion'],
        },
      },
    },
    // The app chunk lands around 1.2 MB. The limit sits just above that, so a
    // clean build stays quiet but real growth still speaks up -- rather than
    // warning on every single build, which trains everyone to ignore it.
    // Cutting it further means route-level lazy loading, which is a separate
    // change with its own Suspense boundaries to get right.
    chunkSizeWarningLimit: 1300,
  },
});
