// 兼容出口(host · L2 运行时 · runtime)
// 运行索引持久化实现已归属 L1 storage；保留旧路径以避免破坏现有调用方。
export * from '../storage/runs-index.js';
