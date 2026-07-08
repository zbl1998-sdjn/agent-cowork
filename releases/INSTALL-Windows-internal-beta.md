# Agent Cowork v0.2.1 Internal Beta 安装教程（Windows）

这份教程给第一次安装的朋友使用。当前版本是 **Internal Beta / 朋友试用版**，适合小范围可信测试，不是公开生产版。

## 1. 压缩包里有什么

解压后应看到这些文件：

- `Agent-Cowork-Setup-v0.2.1-internal-beta.exe`：Windows 安装程序。
- `Agent-Cowork-Setup-v0.2.1-internal-beta.exe.sha256`：安装程序的 SHA256 指纹。
- `README-internal-beta.txt`：beta 范围和边界说明。
- `INSTALL-Windows-internal-beta.md`：本安装教程。

如果文件名不一致，或者你不是从发布者本人拿到这个压缩包，请先不要运行安装程序。

## 2. 安装前先验 SHA256

SHA256 用来确认你手里的 `.exe` 没损坏、没被替换。

1. 右键解压后的文件夹，选择“在终端中打开”或“在 PowerShell 中打开”。
2. 运行：

```powershell
Get-FileHash -Algorithm SHA256 .\Agent-Cowork-Setup-v0.2.1-internal-beta.exe
```

3. 确认输出的 `Hash` 等于：

```text
B5F6DA1A8959287B03F8FF68FA4DB99B6123CADAF77E3B60C4A4ED365584F8D1
```

如果不一致，停止安装，并把文件来源反馈给发布者。

## 3. 安装步骤

1. 先把 zip 完整解压到普通文件夹，不要直接在压缩包窗口里运行 `.exe`。
2. 双击 `Agent-Cowork-Setup-v0.2.1-internal-beta.exe`。
3. 如果 Windows 提示“未知发布者”或 SmartScreen 提醒：
   - 这是因为当前 beta 安装包还没有代码签名。
   - 先确认文件名和 SHA256 都正确。
   - 只有在确认来源可信时，才继续选择“更多信息”/“仍要运行”。
4. 按安装器提示完成安装。当前安装版按当前 Windows 用户安装，一般不需要管理员权限。
5. 安装完成后，从开始菜单打开 `Agent Cowork`。如果开始菜单里找不到，可尝试打开：

```text
%LOCALAPPDATA%\Agent Cowork\agent-cowork-desktop.exe
```

## 4. 第一次打开怎么用

打开后会看到登录/注册界面：

- 想快速试用：点击 `跳过，先在本地使用 →`。
- 想隔离本机数据：注册一个本地账户。账户信息只保存在本机。

没有配置模型密钥时，本地文件、界面和部分离线能力仍可使用；需要模型回复时，再配置 Kimi / Moonshot 或本地 OpenAI-compatible 模型。

## 5. 配置 Kimi API Key（可选）

如果你已经有 Kimi / Moonshot API Key：

1. 打开 Agent Cowork。
2. 进入 `设置`。
3. 切到 `密钥`。
4. 提供商选择 `Kimi(月之暗面)` 或 `Kimi / Moonshot`。
5. 在 `API Key` 输入框粘贴你的 key。
6. 点击 `保存`。

如果你还没有 API Key，可以到 Kimi Open Platform 的 API Keys 页面创建。不要把 API Key 发给别人，也不要截图发群里。

密钥只会保存在你本机的 `.AgentCowork/config.json`，界面不会回显明文。

## 6. 常见问题

### Windows 提示未知发布者，能不能装？

当前 beta 包未签名，所以 Windows 可能会提示未知发布者。只在确认来源可信、SHA256 一致时继续。公司电脑或受管电脑可能被策略禁止继续运行，这种情况不要强行绕过。

### 杀毒软件提示怎么办？

先不要继续运行。把提示截图、杀毒软件名称、安装包 SHA256 发给发布者确认。

### 打开后提示未配置 Kimi API Key

这不是安装失败。说明还没有配置模型密钥。进入 `设置` -> `密钥` 填入 API Key 后再试。

### 如何卸载？

在 Windows 的“设置” -> “应用”里找到 `Agent Cowork` 卸载；也可以运行安装目录里的 `uninstall.exe`。

## 7. 给 beta 测试者的反馈信息

反馈问题时，请尽量带上：

- Windows 版本。
- 安装包文件名。
- SHA256 是否一致。
- 出错截图或错误文字。
- 是安装失败、打开失败，还是模型回复失败。

不要发送自己的 API Key、token、密码、私密文件内容或浏览器 Cookie。
