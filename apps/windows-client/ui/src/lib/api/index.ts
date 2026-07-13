// API 汇总出口(UI · lib/api 传输层)
// ---------------------------------------------------------------------------
// 职责:把按域拆分的各 API 模块统一再导出,作为前端访问 host 的「单一入口面」。组件/hooks 只从这里取 API,
//       不直接 fetch(plan/00 前端分层规则)。transport 提供底层请求,其余文件按业务域分组。
export * from './transport';
export * from './runs';
export * from './tools';
export * from './artifacts';
export * from './officeEditor';
export * from './schedules';
export * from './kimiConfig';
export * from './auth';
export * from './conversations';
export * from './files';
export * from './recipes';
export * from './diagnostics';
export * from './chat';
export * from './prompt';
export * from './search';
export * from './memory';
export * from './onboarding';
export * from './runtimeDependencies';
export * from './capabilities';
export * from './desktopUpdates';
export * from './projects';
export * from './folder-grants';
