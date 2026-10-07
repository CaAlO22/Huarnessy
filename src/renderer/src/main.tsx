import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '@fontsource-variable/noto-sans-sc/wght.css'
import './styles.css'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github-dark.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
