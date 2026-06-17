# 改动记录:桌面对话步数预算 8→20 / 上限 16→40

> 日期:2026-06-15。动机:桌面端"在桌面生成 .md"失败的根因修复。

## 根因(实测)
run `run_20260614170944_5f40b901`:本轮 `maxSteps=8`,实际调用 **Shell×7 + Glob×4,Write 0 次** → 步数全耗在探索(列桌面、试装 python-docx)上,**没轮到 Write 就到上限**,于是 `summarizeAfterBudget` 把内容当文本吐出,文件没生成。
→ 与路径牢笼无关、与 .md 无关、桌面也在工作区内。纯粹是**步数预算太低 + 硬上限压制**。

## 改动
两处把"默认 8 / 上限 16"抬到"默认 20 / 上限 40":
- `apps/host/src/routes/agent-stream.ts:189`
  `Math.min(Math.max(Number(body.maxSteps) || 8, 1), 16)` → `... || 20, 1), 40)`
- `apps/host/src/routes/agent-config-snapshot.ts:112`(同式,保持一致)

注:只抬默认不够——原硬上限 16 会把更大的值压回,所以**默认和上限一起抬**。

## 为什么安全
步数上限只是"粗刹车"。真正防失控的是 `loopGuard`(循环/空转检测)+ `budgetGuard`(成本中止),它们不受步数数值影响,照常兜底。20/40 仍是有界的。

## 生效方式
host 从源码运行(`run-host-node.mjs apps/host/src/main.ts`),**无需 build,重启 host 进程即生效**。

## 实测
重跑"请在 C:\Users\Administrator\Desktop 生成一份…的 .md",应能直接走到 Write、文件落盘成功(不再只吐文本)。

## 下一版(roadmap,本次未做)
- 耗尽时不直接收尾,**弹"还差一步,继续吗?"**(复用审批门 + resume)。
- 真·自适应:**按进展续命**——把 `loopGuard`"在空转"反过来用作"仍有进展则续",到硬天花板再问人。
