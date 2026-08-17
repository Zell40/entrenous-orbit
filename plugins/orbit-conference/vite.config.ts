import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: 'src/index.tsx',
      formats: ['iife'],
      name: 'OrbitPluginConference',
      fileName: () => 'orbit-conference.js',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        globals: {
          react: 'Orbit.React',
          'react-dom': 'Orbit.ReactDOM',
          'react/jsx-runtime': 'Orbit.jsxRuntime',
        },
      },
    },
    emptyOutDir: true,
    outDir: 'dist',
  },
});
