# Jev Supervisor for DeepSeek Harness

**简体中文** · [English](./README.en.md)

给 DeepSeek Harness（macOS 桌面版 / `dsh web`）用的外部 Cordis 插件。它在每个工具调用**执行前**和**执行后**，用 TypeSafe 的监督接口（`api.typesafe.ai/v1/systemone`，固定模型 **jev-1.13.0**）判断这次调用该不该继续，并在你明确开启强制模式后，拦截调用、暂停要求你决策，或给下一步补上有证据的纠正上下文。

监督数据会发送到 **TypeSafe**。用的是**你自己的** TypeSafe key。

> 兼容性：已在 **DeepSeek Harness Desktop 0.2.0-rc.2**（commit `5e9e301`，macOS arm64）上开发并验证。dsh 还没到 1.0，插件用到的都是当前版本公开的扩展点与服务；换版本前请先看[兼容性与能力核对](./docs/INSTALL.md#兼容性)。

---

## 它做什么

一次工具调用的完整链路：

| 阶段 | 监督行为 |
|---|---|
| 模型要调用工具 | 先走原来的审批/安全判断。原来拒绝或取消的，监督**不覆盖**。原来是 allow 时，才发一次 Jev 请求。 |
| 判断需要拦截 | 拒绝这次调用（工具函数**不会执行**），把带证据的说明作为错误结果返回给模型。 |
| 判断需要用户决策 | 抛 `ask`，走 Harness 原来的审批通道；用户拒绝则调用不执行。 |
| 工具执行完成 | 再判断一次。需要改变方法时，**不改写**真实结果，只追加一条纠正上下文到下一步。 |
| 判断需要暂停 | 结束当前 turn（blocked）。不会自动重新规划，也不会强制续跑；你决定后用 `/jev resume` 继续。 |

判断依据是一份**真实且有限**的状态快照：用户的真实指令、显式目标、本轮/本步位置、真实工具调用与失败记录、以及实际工具结果。不发送完整文件、完整历史或密钥。

**不新增 DeepSeek 总结调用**：主模型链路完全不动，监督只调 TypeSafe。

## 界面

- **输入框下方（composer dock）**：`Jev`、模式、**连接**、**监督状态**、详情、刷新。就这些。
- **设置 → Jev Supervisor**：填 key、检测连接、切换模式、启用强制模式、清除 key。关于「数据发到 TypeSafe」的说明只在这里出现一次。
- **首次安装的引导面板**：没有配置 key 时自动出现一次（可关闭、可「稍后配置」，不会反复弹）。已有 key 的用户不会再看到；已保存的 key 从不在界面回显。

### 连接 ≠ 正在被监督

这两个事实分开显示，因为它们是两件事：

| 显示 | 含义 |
|---|---|
| 连接：已连接 / 未配置密钥 / 连接失败 / 未检测 | TypeSafe 接口能不能通。**「未检测」表示还没有任何一次真实请求成功过**，只有 key 不算连接成功。真实监督调用成功即更新为「已连接」并记录时间；真实故障按原因更新。「未检测」不会被额外的探测请求"补救"。 |
| 监督：监督中 / 影子记录 / 受限 / 待你决定 / 未监督 / 未检测 | 这次会话的任务是否还在接受监督。 |

**「受限」有三种原因**，悬停文本与详情里写明是哪一种：`预算用尽`（每任务调用次数用完）、`干预达上限`（每任务干预次数用完）、`故障熔断`（连续 3 次调用失败）。受限时原任务继续照常执行，只是不再有监督；**连接显示「已连接」的同时监督完全可能显示「受限」**——别把前者当成后者。

预算按**会话任务**记账（有显式 goal 时按 goal）。详情行会写明是「按会话记账」还是「按目标记账」，不会臆造任务边界。

## 安装

完整步骤见 [docs/INSTALL.md](./docs/INSTALL.md)。最短路径：

1. 打开 Harness → 侧边栏 **插件** → **添加插件**。
2. 在「包名或地址」里填：

   ```
   https://github.com/ryyyzer/jev-supervisor.git#v1.0.0
   ```

   `#v1.0.0` 是固定版本，安装的是这个 tag 的代码，不会被后续改动影响；想去掉 tag 跟最新版就填不带 `#` 的地址。仓库默认分支与唯一的正式 release 都是 v1.0.0。

3. 点安装。插件以 bundle 形式装入当前 profile。
4. 重启 Harness（替换/新增包后需要重启才会加载新的 JavaScript 模块代）。
5. 打开 **设置 → Jev Supervisor**，粘贴你自己的 TypeSafe key → **保存**（会自动做一次真实连接检测）→ **检测并启用强制模式**。

装完默认是 **shadow**：会调用 Jev、会记录判断，但**不会干预**。没填 key 之前一次请求都不会发。

## 开关

| 方式 | 说明 |
|---|---|
| 设置页 | 保存/清除 key、检测连接、off/shadow/enforce |
| `/jev status` | 当前模式、连接、key 是否已配置、预算、任务状态（JSON） |
| `/jev off` \| `/jev shadow` \| `/jev enforce` | 切模式；`off` 完全不调用 Jev |
| `/jev resume` | 解除暂停（ask_user 之后的恢复） |
| `/jev reset` | 手动清空**当前记账任务**的运行状态（调用/干预/故障计数、暂停、限制、反馈去重），让这轮额度重新可用；不改模式、不改预算、不动 key |
| `/jev model jev-x.y.z` | 改固定版本；不接受 `latest` 之类的别名 |
| `/jev verify` | 用当前 key 做一次真实连接检测 |
| `jev_supervisor_status` | 只读工具。**不能**改模式、不能碰凭据、不能放宽任何权限 |

## 安全与数据

- **key 走官方凭据接口**。输入框 → `ctx.remote.credentials.set(<本 profile 的引用名>, …)` → Harness 凭据存储（`dsh-credentials-local`）。插件读的时候只经过 `ctx.credentials.resolve()` 的同一个引用名。
- **引用名按 profile 隔离**：形如 `JEV_TYPESAFE_API_KEY_<10 位摘要>`，由 `ctx.profileContext.dir` 派生，设置页会把实际引用名显示出来。同一个 harness home 里的两个 profile 各写各的条目，谁也读不到、覆盖不了谁。设置、读取、检测、替换、清除全部用同一个名字。
  - 想固定名字的部署可以把 `keyRef` 配在 `cordis.patch.yml` 里。
  - 从 1.0.x（固定名 `JEV_TYPESAFE_API_KEY`）升级上来的用户，key 在旧条目里；**重新在设置页填一次**即可，插件不会去读旧条目，也不会迁移或复制它。
- key **不会**进入：模型消息、会话记录、`cordis.patch.yml`、插件源码、日志、工具结果、命令行参数、`localStorage`/`sessionStorage`。这条有测试盯着（快照脱敏、日志清洗、源码扫描、日志不含明文）。
- **插件不长期持有 key**：每次监督调用即时向凭据存储读取，用完立刻释放；清除 key、关闭 API、卸载插件之后插件内不留旧值。日志脱敏所需的那一份值只在单次调用期间存在。
- 凭据文件的存储位置与保护级别由 Harness 自身决定；本插件不做第二套存储，**也不声称这是 macOS 钥匙串或系统级安全存储**。官方本地提供者是一个文件（默认 `$DSH_HOME/.credentials.yaml`，权限 0600、目录 0700、写入用原子替换）：它能挡住其他 OS 用户，**挡不住以你身份运行的 agent 工具进程**——这是 `dsh-credentials-local` 自己的已知边界，本插件如实沿用，详见 [docs/SECURITY.md](./docs/SECURITY.md)。
- 如果要更强的隔离，把凭据放进**启动环境变量**：`JEV_TYPESAFE_API_KEY_<你的摘要>=… open -a "DeepSeek Harness"`。此时 Harness 会把该引用报为只读，设置页会说明无法在此覆盖。

发往 TypeSafe 的内容、脱敏规则、以及「不发送什么」，见 [docs/SECURITY.md](./docs/SECURITY.md)。

## 运行边界

- **Jev 调用预算**：设置页（以及首次配置面板）可选 **12 / 24 / 48 / 自定义**，新安装默认 **24**，自定义范围 1–100。**一次工具动作前后各可能判断一次，各计 1 次调用**，所以 24 次通常约覆盖 12 个工具动作。提高预算**不保证更省 token**，也不代表判断更准。
- **实际干预上限**默认 **3**，与调用预算**独立**，只统计真正的干预（拒绝 / 询问 / 纠正反馈），放在设置页的「高级」里。
- 计数范围：真实目标任务（有显式 goal 时按 goal，取不到目标 ID 时按会话）。**修改预算、刷新、切换模式、重新渲染都不会清零已用计数**；提高预算会让受限的任务在下次读取时恢复监督，并带着已经用掉的次数继续。界面显示的永远是 Host 回报的实际生效值与已用值。
- 预算耗尽时显式显示「受限（预算用尽）」并回到原流程，不会误报成连接故障，也不会改成无限预算。
- 单次请求超时 **5 秒**；连续 **3 次**故障熔断（成功即清零）。无自动重试。
- 低置信度、证据不足、重复证据、超预算、异常、取消 —— 一律**回到原流程**。原来的安全审批始终有效。
- 暂停（ask_user）结束 blocked turn；不启用 Stop 强制续跑。
- 快照上限 **8000 字节**（可配 2000–16000），超预算先丢近期结果与失败记录。
- 概率与置信度**不保证正确率**。

## 手动重新使用预算（/jev reset）

预算用完不会自动续。要让这轮额度重新可用，**由你主动**发 `/jev reset`。不会自动 reset，也不会无限预算。

举个例子（预算设为 12）：

1. 12 次判断用完后，Jev 停止调用，**DS 原任务继续照常执行**。控制条这时显示「已连接 · 受限（预算用尽）」。12 是 **Jev 判断次数**：一次工具动作前后各可能判断一次，因此通常约覆盖 **6 个工具动作**。
2. 在当前对话输入 `/jev status`，可以直接看到当前模式、已用计数和上限。
3. **在任务空闲、没有正在执行的工具、也没有未结算的 Jev 请求时**，输入 `/jev reset`，然后 `/jev status` 确认已用计数归零、上限仍是 12。这只是清空计数，**不是修改预算**。
4. 于是可以再用这 12 次判断额度。需要的话可以重复手动执行，一轮一轮地继续。

> **并发注意**：确认空闲后再 reset。reset 会替换该任务的运行状态，若此刻仍有未结算的 Jev 请求，那个判断在结算时会被丢弃并记为 `task_reset`（它的计数已花掉、不会写回新状态）。**目前没有验证"任意时刻 reset 都安全"，所以文档只承诺空闲时重置。**

必须说清楚的事实：

- **每一轮的新请求照常产生 TypeSafe API 使用量及费用。** 12 不是免费额度，也不是累计总费用上限。
- reset 只清当前**记账任务**的运行状态：调用次数、干预次数、故障次数与熔断、暂停、限制、反馈证据去重集合。**它不删除原始会话失败记录**，所以相同的失败证据可能再次触发干预。
- reset **不改变** off/shadow/enforce、已配置预算、干预上限或 key；在 `off` 下 reset **不会**自行开启监督。它不取消已执行的工具、不撤回已发送的反馈、不清空聊天或审计日志，也不能替代网络或 key 故障的修复。
- 记账范围：有实际 goal ID 时按当前目标任务，取不到时按整个会话。同一对话继续发消息**不会**自动补充额度。
- **改预算 ≠ reset**：把预算从 12 调高到 24 会保留已用的 12 次（只抬高上限），而 reset 才是把已用计数清零。刷新、切换模式、重新渲染都不清零计数。
- **只有用户主动指令才能清零。** 只读的 `jev_supervisor_status` 工具**不能**替模型执行 reset，也不会自动循环补充额度或强制续跑。

## 审计记录长什么样

每条真实判断单独一行（`kind: pre` / `post`），除会话、turn/step、call ID、工具名、实际动作、证据指纹、DeepSeek usage 之外，**带完整的判断元数据**：

```jsonc
{
  "kind": "pre", "tool": "read", "action": "none", "reason": "low_confidence",
  "decision": "replan",              // 规范化后的选择，便于筛选
  "judgment": {                      // 该判断的原始数字
    "choice": "replan",
    "confidence": 0.84,
    "probabilities": { "continue": 0.15, "replan": 0.84, "ask_user": 0.01 },
    "repeatedFailure": 0.2, "goalDrift": 0.1,
    "model": "jev-1.13.0",           // API 实际返回并已校验等于固定版本的模型
    "usage": { "input_tokens": 1435, "output_tokens": 78 },
    "latencyMs": 697, "at": "…", "unknown": false
  }
}
```

- **不伪造**：API 没给的字段记 `null` 并把 `unknown` 置为 `true`，绝不写成 0。跳过的阶段（off、预算耗尽、原审批已拒绝）写 `judgment: null`，不会被误读成发生过调用。
- 连接检测的 `connection-verified` 记录**不能替代**逐次判断审计，两者是不同的事件。
- 日志只落本机文件，**不注入模型上下文**（shadow 尤其如此）。
- 纠正反馈进入下一步请求时，来源标识是当前会话格式 V4 要求的**生产者专属 kind**：`plugin:dsh-plugin-jev-supervisor`。它**不是** `user`（否则监督的措辞会被当成你的真实指令），也**不是**已退役的 V3 包装写法 `plugin`（V4 会拒绝它）。`test/v4-contract.test.js` 用安装版真实的行准入函数盯着这条契约。

## 数据放在哪

- 模式等设置：优先走官方存储域 `ctx.storageDomain`；该服务缺失时退回 **profile 目录**下的 `.jev-supervisor/settings.json`。
- 日志：`<profile 目录>/.jev-supervisor/supervisor.jsonl`（目录 0700、文件 0600、5 MiB 轮转，保留一个 `.previous`）。
- 路径来源只有 `ctx.profileContext`。**没有**任何个人用户名、固定 profile 名、钥匙串服务名或绝对路径硬编码；同一个插件装进两个 profile 就是两份独立数据。

## 卸载

侧边栏 **插件** → 找到本插件 → 卸载。凭据不会自动删除；要清就在设置页点「清除密钥」（或 `ctx.credentials.unset('JEV_TYPESAFE_API_KEY')` 等价的官方入口）。

升级：当前版本的插件管理不支持原地升级 —— 先卸载再装新版本。设置与凭据不受影响。

## 开发

```bash
npm run prepare:runtime   # 一次性：把已安装 Harness 的包链接成测试夹具
npm test                  # 109 项：核心规则 43、存储 7、客户端 16、真实运行时集成 38、V4 来源契约 5
```

测试里的集成部分会加载**已安装的** `@deepseek-ai/dsh-tools` / `dsh-commands`，用真实的 `tools/pre-execute` waterfall、guard、`tools/post-execute`、`tools/result` 顺序跑一遍，只替换对 TypeSafe 的出站 `fetch`。所以「拒绝后工具函数没执行」是拿真实调度器验证的，不是拿 mock 事件总线。

集成测试需要真实 Harness 包，夹具由一条命令显式生成（软链接，不安装、不改动任何现有文件）：

```bash
DSH_TEST_RUNTIME=/path/to/installed/dsh/node_modules \
DSH_TEST_PROFILE=~/.dsh/profiles/desktop/node_modules \
node test/prepare-runtime.mjs
```

`DSH_TEST_RUNTIME` 是已安装 Harness 的 `node_modules`（桌面版可从 `app.asar` 提取，或用你自己的源码 checkout）；`DSH_TEST_PROFILE` 是任一真 profile 的 `node_modules`，提供 `zod` 这类运行时没有 hoist 的第三方包。夹具落在 `test/runtime/`，**不发布**，已在 `.gitignore` 里；`npm test` 会先检查它是否存在，缺失时给出上面这条命令。

## 许可

MIT，见 [LICENSE](./LICENSE)。
