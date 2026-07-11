// 兼容出口(host · L2 运行时 · runtime)
// 模型熔断器实现归属 L1 kimi；保留旧路径以避免破坏现有调用方。
export * from '../kimi/model-breakers.js';
