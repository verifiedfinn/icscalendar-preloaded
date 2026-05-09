import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves from /icscalendar-preloaded/; Vercel and local dev serve from /
  base: process.env.GITHUB_ACTIONS ? '/icscalendar-preloaded/' : '/',
})
