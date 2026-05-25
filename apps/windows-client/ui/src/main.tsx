import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('root container missing');
}
createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary label="应用">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
