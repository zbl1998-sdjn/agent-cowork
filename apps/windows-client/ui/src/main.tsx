// 前端入口(UI · 应用编排层)
// ---------------------------------------------------------------------------
// 职责:挂载 React 应用根——把 App 包在错误边界与 StrictMode 中渲染到 #root,引入全局样式。
//       打包桌面态先自举:经 IPC 拉起并校验 host,再整页跳到 host 同源地址(规避 WebView2 150
//       Local Network Access 对 tauri.localhost→127.0.0.1 跨地址空间 fetch/SSE 的拦截),
//       跳转发起后本文档即将卸载,不再渲染 App。
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { bootstrapHostOrigin } from './lib/api';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('root container missing');
}
const root = createRoot(container);

function BootScreen() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: '#8b93a7', font: '14px system-ui, sans-serif' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 15, marginBottom: 6 }}>正在启动本地服务…</div>
        <div style={{ fontSize: 12, opacity: 0.7 }}>首次或低配电脑可能需要十几秒,请稍候</div>
      </div>
    </div>
  );
}

function renderApp() {
  root.render(
    <React.StrictMode>
      <ErrorBoundary label="应用">
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

async function boot() {
  // 先显示启动占位,避免自举等待期间白屏;非打包/开发态 bootstrap 立即返回 render。
  root.render(<BootScreen />);
  try {
    if ((await bootstrapHostOrigin()) === 'redirecting') return; // 跳转已发起,等待新文档接管
  } catch {
    // 自举异常不应挡住使用:退回正常渲染(同源/回退路径仍可尝试登录)。
  }
  renderApp();
}

void boot();
