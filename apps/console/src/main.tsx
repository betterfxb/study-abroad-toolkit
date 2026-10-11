import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/global.css';
import 'virtual:uno.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root 挂载点缺失');

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
