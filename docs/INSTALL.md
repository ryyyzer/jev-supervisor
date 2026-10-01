# 安装、启用与排错

**简体中文** · [English](./README.en.md)

## 兼容性

| 项目 | 值 |
|---|---|
| 开发与验证环境 | DeepSeek Harness **Desktop 0.2.0-rc.2**，commit `5e9e301dd9dc8923b2762f76dacfc5751f6ca851`，macOS arm64 |
| 插件版本 | `dsh-plugin-jev-supervisor@1.0.0` |
| 需要的 Harness 版本 | `0.2.0-rc.2`（package.json 的 `peerDependencies` 声明为精确版本） |
| 需要的运行时服务 | `tools`、`agents`、`sessionProjections`、`commands`（桌面版 base bundle 全部自带） |
| 可选服务 | `credentials`（缺省则无法保存/读取 key）、`storageDomain`（缺省则设置退回 profile 内 JSON）、`connection`（缺省则设置页与控制条的数据入口不挂载） |
| 外部依赖 | 无。只用 Harness 已提供的服务和 Node 内置模块 |

插件**没有**自带 harness 依赖，也**不会**去 patch `.app`、内置运行时或 DeepSeek provider。它通过官方 bundle 层插入一行 plugin 记录：

```yaml
# cordis.patch.yml（包内自带）
- insert:
    - id: jev-supervisor
      name: dsh-plugin-jev-supervisor
      config: { mode: shadow, apiEnabled: true, model: jev-1.13.0, … }
```

版本不匹配时，官方插件管理器会在安装前拒绝（`incompatible-version`），不会留下半装状态。真要装到别的版本上，用官方 `plugin_manager` 的 `set_version_exemption` / CLI `dsh plugin version-exemptions`，看清风险再放行 —— 本项目不会替你做这个决定。

## 安装（桌面版界面，推荐）

1. 打开一个会话，左侧边栏进入 **插件** 页。
2. 点 **添加插件**。
3. 「包名或地址」填：

   ```
   https://github.com/ryyyzer/jev-supervisor.git
   ```

   想固定在某个 release：

   ```
   https://github.com/ryyyzer/jev-supervisor.git#v1.0.0
   ```

4. 点安装。安装完成后插件会作为 bundle 被选中；界面提示需要重启时**重启 Harness**（替换/新增包必须重启才会加载新的模块代）。
5. 侧边栏插件页确认 `dsh-plugin-jev-supervisor` 处于启用、组件 `jev-supervisor` 显示「运行中」。

### 安装需要什么

- `pnpm` 在 PATH 上（桌面版自带运行时，一般已经可用）。
- 访问 GitHub 的网络（或代理）。插件本身不发 npm 包，从 GitHub 拉取。
- 不需要你预装 Node、不需要 clone、不需要改任何配置文件。

## 安装（CLI，等价路径）

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop add 'https://github.com/ryyyzer/jev-supervisor.git'
```

写 profile 需要当前用户对该目录的写权限；在某些受限沙箱里会被拒（`EPERM`），此时用界面安装。

## 第一次启用

装完启动后，**没有配置 key 时会出现一次首次引导面板**（应用内浮层，不是新窗口）。它提供：

1. **TypeSafe API key** 密码输入框；
2. **保存**——走官方凭据接口写入本 profile 专属的凭据条目，随后立刻做**一次真实连接检测**；
3. **检测并启用强制模式**——再检测一次，成功才切到 `enforce`，失败则模式原样不动；
4. **稍后配置 / 关闭**——记录「已决定」，以后再启动不再自动弹出；不改变模式、不提高任何权限。

它**只在没有配置 key 且没有做过决定时**出现；已经有 key 的安装不会再看到，已保存的 key 也不会回显。想手动配置随时打开 **设置 → Jev Supervisor**，那里有同样的操作。

输入框下方的控制条应显示 `Jev | 模式: enforce | 已连接 · 监督中`。

装完默认是 **shadow**。**没填 key 之前，一次监督请求都不会发出**（日志里也不会出现调用记录）。

## 控制条：连接与监督是两件事

| 显示 | 含义 |
|---|---|
| 连接 | 已连接 / 未配置密钥 / 连接失败 / 未检测。**「未检测」= 还没有任何一次真实请求成功过**；只存了 key 不算。 |
| 监督 | 监督中 / 影子记录 / 受限（预算用尽 · 干预达上限 · 故障熔断）/ 待你决定 / 未监督 / 未检测。 |

`已连接` 只说明接口能通，**不代表当前任务还在被监督**。每任务默认 12 次调用、3 次干预；用完之后控制条显示「受限（预算用尽）」，原任务继续跑，但不再有监督。`详情` 会写明用了多少次、以及是按会话记账还是按目标记账。

## 日常使用

- 控制条：模式下拉、连接与监督状态、`详情`（模型 / 预算 / 记账范围 / 设置存储）、`刷新`，同一行。暂停时出现 `恢复`。
- **预算怎么改**：设置页「Jev 调用预算」选 12 / 24 / 48，或选「自定义」填 1–100 的整数后保存；界面显示 Host 回报的实际生效值与本任务已用次数。**改预算不会清零已用计数**；把预算调大，受限的任务会恢复监督并带着已用次数继续。「高级」里是**独立**的「实际干预上限」（0–10，默认 3）。
- **额度用完怎么办**：不会自动续，也不会无限。**空闲时**（没有正在执行的工具、没有未结算的 Jev 请求）发 `/jev reset`，再 `/jev status` 确认计数归零、上限不变，就能再用这轮额度；可重复手动执行。每轮新请求照常计费。详见 [README 的「手动重新使用预算」](../README.md#手动重新使用预算jev-reset)。
- 指令：见 [README 的开关表](../README.md#开关)。
- 删除 key：设置页 **清除密钥**。卸载插件不会自动删 key。
- 升级：先卸载再安装新版本（当前官方插件管理不支持原地升级），设置与 key 都会保留。

## 重启后会发生什么

- 模式从存储里恢复（存储域或 profile 内 `settings.json`）。
- key 不缓存到任何文件：每次监督调用即时从凭据存储读取，所以你换了/删了 key，下一次调用立刻生效。
- 每任务的调用与干预预算**重置**（预算只存在内存里，不落盘）。
- 凭据与模式是两件事：key 还在但模式是 `off`，就一次都不调。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 控制条显示「未配置密钥」 | 还没保存 key，或 key 被清除。到设置页保存。 |
| 保存后提示连接失败 `HTTP_401` / `HTTP_403` | key 无效或无权限。确认用的是 TypeSafe 的 key。 |
| 连接失败 `timeout` | 5 秒超时。检查网络/代理。超时不会重试，原任务继续。 |
| 设置页显示「当前凭据来自只读来源」 | 启动了 `JEV_TYPESAFE_API_KEY=…` 环境变量或 `.env` 里有同名项，它会覆盖存储。想让界面可写就先取消那个来源。 |
| 设置页显示「没有挂载凭据存储」 | 这个部署没装 `dsh-credentials-local`。插件仍可用 `off`/`shadow`，但无法保存 key。 |
| 插件页显示组件「异常」 | 看插件详情里的错误文本。最常见的是 Harness 版本与 `peerDependencies` 不匹配，或 profile 里 `jev-supervisor` 这一行被更高优先级的 patch 覆盖。 |
| 控制条显示「已连接 · 受限」 | 正常：接口通，但这个任务的预算/干预/熔断已经用完。看 `详情` 里的计数；正对应原任务仍在继续。想继续被监督就把预算调大（计数会保留），或新开会话。 |
| 输入预算后提示无效 | 只接受 1–100 的整数；自定义框里 `0`、`101`、`1.5`、`abc` 都会被拒绝，且不会改动当前生效值。 |
| 首次引导面板没出现 | 已有 key，或此前点过「稍后配置」。两者都会记在设置里；想再配置走设置页。 |
| 改了源码后界面没变 | 客户端 bundle 由 Harness 在启动时服务；改完要重启 Harness 并刷新页面。 |
| 想立刻停止监督 | 控制条选 `off`，或 `/jev off`。 |
| 额度用完，想再用一轮 | **空闲时**发 `/jev reset`，用 `/jev status` 确认计数归零。不要在有未结算请求时 reset。 |

## 凭据条目与 profile 隔离

设置页会显示**本 profile 实际使用的凭据引用名**，形如：

```
凭据条目: JEV_TYPESAFE_API_KEY_1A2B3C4D5E
```

它由 `ctx.profileContext.dir` 派生。同一个 harness home 下的两个 profile 用两个不同的名字，各写各的条目，互不读取、互不覆盖。设置、保存、读取、检测、替换、清除全部用这一个名字。

- 从 1.0.x（固定名 `JEV_TYPESAFE_API_KEY`）升级：旧 key 在旧条目里，**重新填一次**即可；插件不会去读、迁移或复制它。
- 想固定名字的部署：在 `cordis.patch.yml` 的该行 `config.keyRef` 写死一个名字。
- 官方本地凭据提供者是**一个文件**（默认 `$DSH_HOME/.credentials.yaml`，0600、目录 0700、原子写入），**不是 macOS 钥匙串**。它能挡住其他 OS 用户，挡不住以你身份运行的 agent 工具进程——这是官方提供者自己的边界，本插件如实沿用，不做加密或系统级安全存储的宣传。

## 数据与卸载

- 设置：存储域优先，其次 `<profile 目录>/.jev-supervisor/settings.json`。
- 日志：`<profile 目录>/.jev-supervisor/supervisor.jsonl`（0600，5 MiB 轮转）。日志里不含 key。
- 卸载：侧边栏 **插件** → 本插件 → 卸载。日志文件与凭据保留，需要就手动删/清。插件不长期持有 key，卸载后进程内不留旧值。
