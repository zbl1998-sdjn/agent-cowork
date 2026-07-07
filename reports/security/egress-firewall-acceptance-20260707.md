# 切片 #3 · OS 级出网强制 —— 真机验收证据

- 日期: 2026-07-07T11:00:27+10:00
- 主机: DESKTOP-JSQ27QP (Windows 10 Pro 19045)
- 执行者: 管理员 PowerShell(elevated=True 已核)
- 被锁进程: `reports/security/probe/egress-probe.exe`(= System32\curl.exe 的副本,用作可控探针,避免锁真实工具链)
- 规则来源: `npm run security:egress-firewall-plan --exe <probe>` 生成,原样 apply

## 规则组(apply 后 Get-NetFirewallRule 实测)
- Agent Cowork Egress Lockdown - Allow Loopback   action=Allow  enabled=True  (RemoteAddress 127.0.0.0/8)
- Agent Cowork Egress Lockdown - Block egress-probe.exe  action=Block enabled=True (Program=probe)

## 探测结果(实测,原样记录)
| # | 场景 | 目标 | 结果 | 预期 | 判定 |
|---|---|---|---|---|---|
| PROBE1  | 被锁进程 经系统代理 | http://1.1.1.1 | http=301 exit=0 | 拦截 | ✗ 未拦(经代理绕过) |
| PROBE1b | 被锁进程 直连(--noproxy) | http://1.1.1.1 | http=000 exit=7 | 拦截 | ✓ 已拦 |
| PROBE1c | 被锁进程 直连(--noproxy) | https gstatic 域名 | http=000 exit=7 | 拦截 | ✓ 已拦 |
| PROBE2  | 被锁进程 | 127.0.0.1:11434 (本地 Ollama) | http=200 exit=0 | 放行 | ✓ 放行 |
| PROBE3  | 未锁 curl.exe(program-scoped 对照) | http://1.1.1.1 | http=301 exit=0 | 放行 | ✓ 放行(证明规则确按 program 生效) |
| PROBE4  | 回滚后 被锁进程 直连 | http://1.1.1.1 | http=301 exit=0 | 恢复 | ✓ 恢复 |

## 核心结论(诚实)
1. **防火墙规则本身有效**:对被锁进程的**直连**出站(PROBE1b/1c)确实被 OS 层拦死(exit=7 连接失败),
   本地 loopback(PROBE2)放行,未锁进程(PROBE3)不受影响 —— program-scoped 语义符合预期,回滚干净(PROBE4)。
2. **发现真实盲区 —— 本机级代理是绕过口**:本机 http(s)_proxy=127.0.0.1:7897(Mihomo)。
   被锁进程经系统代理时(PROBE1),流量目的地是 **127.0.0.1:7897(loopback)**,命中 Allow Loopback 规则,
   于是外呼成功(http=301)。真正出网的是代理进程,不是被锁进程 —— 防火墙按进程+目的 IP 判定,看不穿这一层。
3. 含义:**仅靠"放行 loopback + 阻断进程外连"不足以零出网**。要真隔离,机密档部署必须同时:
   (a) 清除进程环境里的 http(s)_proxy(切断经代理外泄),或
   (b) 用 WFP/规则**同时限制到本地代理端口**(Allow Loopback 需排除已知代理端口),或
   (c) 在隔离机上根本不装本机代理。
   这正是纯 netsh 规则"best-effort、非绝对默认拒绝"的现实写照,已在 plan/08 记录,本次真机验收把它具体化。

## 回滚
`Remove-NetFirewallRule -Group 'Agent Cowork Egress Lockdown'` 执行后 remaining=0,已还原。

## 复验补充(同日,更深根因)
用 `--loopback-port 11434` 收窄放行重测,发现比"放行规则太宽"更深的根因:
- 即使**完全没有 loopback 放行规则、只有 Block 规则**,被锁进程经系统代理(127.0.0.1:7897)仍外呼成功(http=301),只有直连被拦(exit=7)。
- **根因:Windows 防火墙不过滤 loopback 流量**(既定行为,与规则无关)。故进程→本机代理这一跳 netsh 永远拦不住,由代理进程代为外呼。
- 收窄 loopback 端口对代理旁路【无效】,只减小本地攻击面。修正命令 `-RemotePort` 需配 `-Protocol TCP`(否则 "The port is invalid"),已在代码修复并真机验证建规成功(Protocol=TCP RemotePort=11434)。

## 最终结论(修订)
- ✅ netsh program-scoped 出站封锁对**直连外呼**真实有效(PROBE1b/1c/C 全 exit=7),本地模型端口放行、未锁进程不受影响、回滚干净。
- ❌ 对**经本机转发代理的外呼**无效——Windows 不过滤 loopback,这是 netsh 层的硬限制,不是规则写法问题。
- 因此"隔离档零出网"的必要前提(除防火墙外):**机密档进程环境必须清除 http_proxy/https_proxy/ALL_PROXY,或隔离机不装本机代理**;否则应用层出口网关(air_gap)仍是唯一可靠防线。此结论已回写代码 warning 与 plan/08。

## 应用层闭环:机密模式剥离代理环境(2026-07-07)
针对上面"代理旁路"根因的代码强制修复,端到端实证(host 启动装配调用 applyConfidentialProxyLockdown → spawn 子进程看继承的 env):
- KCW_CONFIDENTIAL 关闭:`applied=false`,子进程仍继承 `http_proxy=http://127.0.0.1:7897`(旧行为不变)。
- KCW_CONFIDENTIAL=1:`applied=true stripped=[http_proxy,https_proxy,all_proxy]`,子进程 `http_proxy=<none> NO_PROXY=*`。
结论:机密模式下 host 及其 spawn 的所有子进程(shell 工具/curl/git/npm)不再经本机代理外呼,
把"零出网必要前提(清代理)"从部署须知变成代码强制。`/api/selfcheck` 新增 `confidential-proxy-stripped` 项供运行时核验。
