import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
// Tailwind CSS — must be imported here (entry point) so it applies globally.
// The path is relative and explicit so Vite's import resolver finds it
// unambiguously. See src/index.css for the @import "tailwindcss" source.
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register the service worker for offline support / PWA installability.
// Only register in production (vite build) — in dev mode the HMR
// websocket and frequent file changes would conflict with the SW
// cache. The SW file lives in /public/sw.js so Vite copies it to the
// build output as /sw.js at the site root.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .catch((err) => {
        console.warn('[PWA] Service worker registration failed:', err.message);
      });
  });
}
