import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,          // listen on 0.0.0.0 so phone can reach it
    port: 5174,          // fixed port
    proxy: {
      '/api': {
        target: 'http://localhost:3000',  // Node/Express server
        changeOrigin: true,
      },
    },
  },
})
