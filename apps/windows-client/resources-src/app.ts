// 资源版 UI 启动入口(resources · composition root)
// ---------------------------------------------------------------------------
// 这里只做四件事:创建状态、收集 DOM、构造共享服务、启动控制器装配。
// 业务逻辑留在各自模块中,避免入口文件重新膨胀成上帝脚本。
const { createInitialState, placeholders } = window.AgentCoworkAppState;
const state: AgentCoworkJson = createInitialState();

// 暴露调试句柄给桌面 webview/devtools,便于验收时查看当前 UI 状态。
window.agentCowork = state;

// DOM 和服务都先构造完成,再交给 controller assembly 做事件绑定与首屏启动。
const elements = window.AgentCoworkAppDom.collectAppDom();
const services = window.AgentCoworkShellServices.createShellServices({
  state,
  elements,
  placeholders,
  utils: window.AgentCoworkUtils,
  api: window.AgentCoworkApi,
});

window.AgentCoworkControllerAssembly.startApp({
  state,
  elements,
  services,
  utils: window.AgentCoworkUtils,
  api: window.AgentCoworkApi,
  runEvents: window.AgentCoworkRunEvents,
});
