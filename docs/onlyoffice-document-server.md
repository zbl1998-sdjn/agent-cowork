# ONLYOFFICE Document Server 接入与验收

## 运行面

- `Agent Cowork host`：文件归属、路径牢笼、审批、JWT 会话、回调和原子副本发布。
- `ONLYOFFICE Document Server 9.4.0.1`：DOCX/XLSX/PPTX 的全功能网页编辑，不是成果文件的最终存储。
- `Windows/Tauri UI`：常驻编辑面板。组件编辑器继续可用，ONLYOFFICE 是可选增强模式。

原文件永不覆盖。用户启动会话时先批准目标副本；Document Server 关闭文档并发送状态 `2` 后，host 才从配置的 Document Server origin 下载结果并原子创建副本。状态 `6` 仅确认中间强制保存，不发布最终副本。

## 首次部署

1. 将 `deploy/onlyoffice/.env.example` 复制为同目录 `.env`，生成至少 32 字符的随机 secret。不要把 `.env` 提交到 Git。默认监听宿主机 `8082`；端口冲突时在该文件设置 `ONLYOFFICE_PORT=<空闲端口>`，并同步修改后续 URL。
2. 将同一 secret 写入 Agent Cowork 根目录 `.env` 的 `KCW_ONLYOFFICE_JWT_SECRET`，并设置：

   ```dotenv
   KCW_ONLYOFFICE_ENABLED=true
   KCW_ONLYOFFICE_DOCUMENT_SERVER_URL=http://127.0.0.1:8082
   KCW_ONLYOFFICE_PUBLIC_BASE_URL=http://host.docker.internal:3017
   KCW_ONLYOFFICE_JWT_HEADER=Authorization
   ```

3. 启动 Document Server：

   ```powershell
   docker compose --env-file deploy/onlyoffice/.env -f deploy/onlyoffice/docker-compose.yml up -d
   docker compose -f deploy/onlyoffice/docker-compose.yml ps
   Invoke-RestMethod http://127.0.0.1:8082/healthcheck
   ```

4. 重启 Agent Cowork host。打开 DOCX/XLSX/PPTX 的可视化编辑页；状态健康时会出现“全功能编辑”。

`KCW_ONLYOFFICE_PUBLIC_BASE_URL` 必须是 Document Server 容器实际可达的 host 地址。Compose 已将 `host.docker.internal` 映射到宿主机。正式远程部署必须改用受信任 HTTPS 域名，不能暴露本地文件 API 的其他路由。

## JWT 与网络边界

- 初始化 `config` 整体使用 HS256 签名，secret 只存在于 host 环境和 Document Server 环境。
- 回调必须携带 `Authorization: Bearer <JWT>`；host 使用 JWT 内的 `payload` 作为权威数据，并检查开放 body 与 JWT 一致。
- 会话 URL 是有期限的签名 token，绑定 owner、trusted root、源版本、目标路径和 document key；host 重启后仍可验证。
- 回调下载 URL 必须与 `KCW_ONLYOFFICE_DOCUMENT_SERVER_URL` 同 origin；请求上限 100 MB、默认超时 15 秒、无内部重试。Document Server 自身可重试回调，副本写入是幂等的。
- 对 Document Server 仅开放签名保护的 content/callback 路由；其他 `/api/*` 仍需要 Agent Cowork 身份。

## 验收目标与观测

建议的受控部署目标（上线前需在实际环境测量）：

- Document Server `/healthcheck` 可用率 ≥ 99.5%。
- 编辑器打开成功率 ≥ 99%，p95 ≤ 10 秒。
- 用户关闭编辑器后，状态 `2` 回调到副本可见的 p95 ≤ 20 秒。
- 回调保存错误率 < 1%，且不出现源文件变化、跨 owner 写入或同名不同内容覆盖。

检查命令：

```powershell
docker compose -f deploy/onlyoffice/docker-compose.yml ps
docker compose -f deploy/onlyoffice/docker-compose.yml logs --tail 200 document-server
Invoke-RestMethod http://127.0.0.1:8082/healthcheck
Invoke-RestMethod http://127.0.0.1:3017/api/artifacts/onlyoffice/status -Headers @{ Authorization = "Bearer <local-session-token>" }
```

Host 日志使用 `[onlyoffice]` 前缀记录 Document Server 的状态 `3/7` 与回调保存失败，不记录 JWT、secret 或下载 URL。运维责任人应在部署单中明确；当前仓库不预设真实 on-call 人员。

## 故障诊断

- `Document Server 不可用`：先检查容器健康和 `8082` 端口，再核对 host 环境变量是否在进程启动前加载。
- `Invalid token`：确认两侧 secret 和 `JWT_HEADER=Authorization` 完全一致，修改后重建容器并重启 host。
- 编辑器打开但文件下载失败：在容器中确认 `host.docker.internal:3017` 可达；不要通过关闭 Host 校验来绕过。
- 回调返回 `error:1`：查看 host 的 `[onlyoffice]` 日志；常见原因是下载 URL origin 不匹配、超时、文件超限、OOXML 损坏或目标名已被不同内容占用。
- 关闭后长时间未生成副本：等待官方约定的关闭保存延迟后检查 Document Server 回调日志；不要手工覆盖目标文件。

## 备份、恢复和回滚

- 成果源文件和回调副本位于 trusted root 的 `.AgentCowork/artifacts`，按项目现有备份策略保护；Document Server 卷不是成果的唯一副本。
- 升级前备份 `document_server_data`、`document_server_lib` 和 `document_server_logs` 三个命名卷，并在预发布环境做打开/关闭/回调恢复演练。
- 功能回滚：设置 `KCW_ONLYOFFICE_ENABLED=false` 并重启 host，用户立即回到本地组件编辑器。
- 服务回滚：执行 `docker compose -f deploy/onlyoffice/docker-compose.yml down`。不要加 `-v`，以保留卷；恢复时重新启动已固定的 `9.4.0.1` 镜像。
- 本接入没有数据库 schema 迁移；回滚不会修改或删除已有成果。

## 部署验收清单

- `docker compose config` 成功，镜像标签不是 `latest`。
- 容器 `healthy`，浏览器能加载 `/web-apps/apps/api/documents/api.js`。
- Host 状态接口返回 `configured=true, healthy=true`。
- 真实 DOCX、XLSX、PPTX 各完成一次“打开—编辑—关闭—状态 2 回调—新副本可见”。
- 原文件 SHA-256 不变；新副本可重新打开；重复回调不产生第二次写入。
- 错误 secret、缺失 JWT、跨 origin 下载、过期 session 和超限文件均失败且可诊断。
- 关闭功能开关后，本地组件编辑器仍正常；执行 `down` 后成果仍在。

只有以上真实环境证据和人工签字齐全时，才可把外部部署层标记为通过；源码测试或模拟回调不能替代它。
