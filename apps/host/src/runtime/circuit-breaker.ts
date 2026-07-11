// 兼容出口(host · L2 运行时 · runtime)
// 熔断器实现已下沉到 L0 util；保留旧路径以避免破坏现有调用方。
export * from '../util/circuit-breaker.js';
