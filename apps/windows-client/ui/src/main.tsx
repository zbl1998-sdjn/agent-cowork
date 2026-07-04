// 前端入口(UI · 应用编排层)
// ---------------------------------------------------------------------------
// 职责:挂载 React 应用根——把 App 包在错误边界与 StrictMode 中渲染到 #root,引入全局样式。无业务逻辑。
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import './styles/index.css';

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
