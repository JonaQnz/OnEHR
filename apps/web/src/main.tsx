import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// Polyfill global for draft-js / fbjs compatibility in Vite
if (typeof global === 'undefined') {
  (window as any).global = window;
}

import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
