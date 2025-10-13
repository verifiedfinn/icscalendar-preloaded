// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// IMPORTANT: replace with your repo name
export default defineConfig({
  plugins: [react()],
  base: '/icscalendarheatmap/',   // <= repo name with leading & trailing slashes
})