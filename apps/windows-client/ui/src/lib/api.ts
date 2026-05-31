// API 兼容入口(UI · lib):保留 `lib/api` 旧导入路径,统一转发到拆分后的 lib/api/index(P0 拆分上帝类后的兼容垫片)。
export * from './api/index';
