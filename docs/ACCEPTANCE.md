# Codex 实机验收清单

对象：`dsh-plugin-jev-supervisor@1.0.0`（仓库唯一的正式版本），目标环境 **DeepSeek Harness Desktop 0.2.0-rc.2（macOS）**。

> 第 3 组（冷启动）是历史上最容易出问题的一段：官方凭据提供者的服务在冷启动时**晚于**同级插件注册。插件已把 `credentials` 声明为依赖，并在每次使用时重新解析，所以服务未就绪时插件只是尚未激活，就绪后自行激活。**请按 3.0 的步骤单独复验一次冷启动**，不要在热重启或首次安装的路径上代替它。

这份清单只包含**必须在真实 Desktop 上做**的事——本地自动化测试已覆盖的部分（109 项：核心规则 43、存储 7、客户端模块 16、真实运行时集成 38、V4 来源契约 5）不在这里重复，跑法见 [README 的测试一节](../README.md#测试)。

每一步都写明：**操作 → 预期 → 失败时看哪里**。请逐条记录真实结果，不要用模拟结果替代；不可控或无法完成的条目如实标注「未验证」。

## 0. 前置

- 一个可用的 TypeSafe key（**由验收者本人提供**；不要使用他人 key，不要从旧插件或旧 profile 读取）。
- 一个可写 workspace 目录（用于验证「拒绝后工具未执行」的文件不存在）。
- 建议先记录当前 profile 的 `cordis.patch.yml` 与 `package.json` 哈希，便于回滚比对。

## 1. 安装

| # | 操作 | 预期 | 失败时看 |
|---|---|---|---|
| 1.1 | 侧边栏 **插件 → 添加插件**，地址填 `https://github.com/ryyyzer/jev-supervisor.git#v1.0.0` | 安装成功，插件列表出现 `dsh-plugin-jev-supervisor` | 安装弹层里的失败分类与 `failedAt`；`incompatible-version` 表示版本范围不符 |
| 1.2 | 查看插件详情的组件列表 | 组件 `jev-supervisor` 显示「运行中」 | 详情里的错误文本（最常见：peer 版本、行被更高优先级 patch 覆盖） |
| 1.3 | 重启 Harness 并刷新页面 | 插件仍启用，组件仍「运行中」 | 设置 → 内置插件里的 `jev-supervisor` 行状态 |
| 1.4 | 记录 `cordis.patch.yml` 是否被自动写入该行 | 由官方管理器插入，**没有**手工改动 | 与步骤 0 的哈希对比 |

## 2. 首次安装引导

> 前置：该 profile **尚未**配置过本插件的 key（新装即满足）。

| # | 操作 | 预期 | 失败时看 |
|---|---|---|---|
| 2.1 | 打开一个空白会话并等待片刻 | 出现一次**首次配置浮层**：标题「配置 Jev Supervisor」、密码输入框、保存 / 检测 / 启用强制模式、`稍后配置` | 控制条是否显示「未配置密钥」；若已显示 key 已配置，说明该 profile 早前配过 key，本条不适用 |
| 2.2 | 浮层里**不输入**任何内容，点 `稍后配置` | 浮层关闭；不改变模式；不产生任何 TypeSafe 请求（看插件日志 `supervisor.jsonl`，应无 `connection-verified`） | 日志文件 `<profile 目录>/.jev-supervisor/supervisor.jsonl` |
| 2.3 | 刷新页面 / 重启 Harness | 浮层**不再**自动出现 | 若再次出现：`settings.json`/存储域里的 `onboarded` 是否落盘 |
| 2.4 | 打开 **设置 → Jev Supervisor** | 设置页始终可达，含同样的输入与按钮（引导只是入口，不是唯一入口） | — |
| 2.5 | 输入框检查 | 为 `type=password`，初值**空**，不显示任何已存 key | — |

## 3. 填写 key、真实 API、启用 enforce

| # | 操作 | 预期 | 失败时看 |
|---|---|---|---|
| 3.0 | **冷启动回归**：全新安装（或在干净 profile 里安装）→ 首配浮层点 `稍后配置` → **完全退出并重启 Harness** → 打开 **设置 → Jev Supervisor** | key 输入框与「保存/清除/检测」**可用**（未被禁用）；**不出现**「没有挂载凭据存储」；`/jev status` 的 `credentialProvider=true`、`keyWritable=true` | 若仍被禁用并报无提供者，说明激活与凭据服务的时序仍未解决；记录 `/jev status` 原文 |
| 3.1 | 在设置页填入你**自己的** TypeSafe key，点 `保存` | 提示「已保存到本机凭据存储」+ 一次真实检测结果（模型 `jev-1.13.0` 与耗时） | 提示 `连接失败: HTTP_401/403` → key 无效；`timeout` → 网络/代理 |
| 3.2 | 记录设置页显示的 **凭据条目** 名字 | 形如 `JEV_TYPESAFE_API_KEY_XXXXXXXXXX`（10 位十六进制大写） | 若显示 `JEV_TYPESAFE_API_KEY` 无后缀，说明 `config.keyRef` 被写死 |
| 3.3 | 打开 `$DSH_HOME/.credentials.yaml`（只读观察，**不要**粘贴内容到任何地方） | 其中出现该条目名；**没有**任何其他 profile 的条目被你这次操作改动 | 文件权限应为 0600 |
| 3.4 | 点 `检测并启用强制模式` | 再检测一次；成功后模式变为 `enforce`，控制条显示 `模式: enforce` | 检测失败时模式必须**保持原样**（回读设置页确认） |
| 3.5 | 控制条状态 | 连接「已连接」；监督「监督中」 | 若监督显示「未检测」，说明还没有一次调用真正成功过 |
| 3.6 | 日志核对 | 存在 `connection-verified` 记录，且**不含** key 明文 | 在日志里搜你 key 的前 8 位，必须搜不到 |

## 4. 重启恢复

| # | 操作 | 预期 |
|---|---|---|
| 4.1 | 完全退出并重开 Harness，回到同一会话 | 模式仍为 `enforce`；连接状态在探测后恢复；**不需要重新输入 key** |
| 4.2 | 检查控制条 | 不出现首次引导浮层 |
| 4.3 | 发一条普通任务（例如让它读一个文件） | 工具照常执行；日志里出现 `pre` / `post` 各一条真实判断 |
| 4.4 | **审计元数据**：检查那条 `pre` / `post` 记录 | 同时含 `decision` 与完整 `judgment`：`choice`、三项 `probabilities`、`confidence`、`repeatedFailure`、`goalDrift`、`model`（= `jev-1.13.0`）、`usage.input_tokens/output_tokens`、`latencyMs`、`at`；API 没给的字段是 `null` 且 `unknown=true`，**不是 0** |
| 4.5 | **连接状态由真实判断驱动**：重启后先看 `/jev status`（应为 `reachability=unverified`），发一次真实任务，再看一次 | 变成 `connected`，`lastCallAt` 非空；期间**没有**额外的探测请求（日志里不出现 `connection-verified`） |
| 4.6 | 制造一次真实故障（例如临时断网或让 key 无效）后再看 `/jev status` | `reachability=unreachable` 且 `lastReason` 是具体原因（如 `HTTP_429` / `timeout`）；恢复后下一次成功判断回到 `connected` |
| 4.7 | 预算耗尽后再看 `/jev status` | `limit=call_budget`、`supervision=limited`，但 `reachability` 仍为 `connected`——**预算耗尽不算连接故障** |

## 5. 拒绝未执行（可控模拟判断 + 真实 Desktop）

> 这一条要用**可控的模拟判断**触发拦截，并如实标注为模拟；工具是否真的没执行是真实的。

| # | 操作 | 预期 |
|---|---|---|
| 5.1 | 在 enforce 模式下，构造一个会触发 `replan` 的场景（同一方法连续两次真实失败后仍有第三次同类调用）或用可控模拟判断注入 `replan` | 该次工具调用被拒绝 |
| 5.2 | 检查该调用的工具结果 | `isError=true`，文本含 `[Jev Supervisor]` 与证据引用（`session:<id>/seq:<n>`） |
| 5.3 | 检查副作用 | 该工具本应产生的文件/状态**不存在**（用明确的哨兵文件名验证；不要只看返回文本） |
| 5.4 | 检查后续步骤 | 模型收到的是拒绝结果（而不是「假装成功」），原审批通道未被绕过 |

## 6. 重新规划反馈进入后续真实模型请求

| # | 操作 | 预期 |
|---|---|---|
| 6.1 | 触发 post 阶段的 `replan`（工具已成功执行） | **真实工具结果保持不变**（`isError=false`，内容未被改写） |
| 6.2 | 检查该结果 | 额外挂了一条纠正上下文，正文含 `[Jev Supervisor]`；其 `source.kind` 为 `plugin`（不是 `user`） |
| 6.3 | 观察下一步真实模型请求 | 该纠正文本出现在冻结的请求消息里（日志中的 `feedback-actual-model-request action=present`） |
| 6.4 | 区分证据 | 「进入后续请求」的证明必须来自真实请求；不要用「已提交会话消息」代替 |
| 6.5 | **来源契约（V4）**：检查该反馈消息的 `source` | `kind` 为 `plugin:dsh-plugin-jev-supervisor`，**没有** `plugin` 字段，**不是** `plugin`，**不是** `user` |
| 6.6 | 同一次观察：本轮与下一轮 | 都不出现 `format v4 message requires a producer-owned source kind`；下一轮工具照常执行；日志出现 `feedback-actual-model-request action=present` |
| 6.7 | **失败不阻断**：若反馈构造或准入失败 | 真实工具结果原样返回（不被替换、不变成错误），该轮与下一轮继续；日志出现 `feedback-rejected` 且注明 `the original tool result continues unchanged` |
| 6.8 | **受限原因语义**：预算设为 1，先做一次低置信度判断耗尽额度 | 第一条 `limited` 记录 `reason=call_budget_exhausted`、`limit=call_budget`，并另留 `lastDecisionReason=low_confidence`；`/jev status` 的 `limitReason` 同为预算原因 |
| 6.9 | 调大预算再调小 | 调大后 `limit=null` 且已用计数不变、监督恢复；调小到低于已用后重新 `limit=call_budget`；期间计数从不清零 |

## 7. 预算与「受限」状态（不要重置、不要提高预算）

| # | 操作 | 预期 |
|---|---|---|
| 7.1 | 在一个会话里连续做足够多的工具调用，直到每任务预算（默认 12 次调用 / 3 次干预）用尽 | 控制条连接仍是「已连接」，监督变为「受限」并注明原因（预算用尽 / 干预达上限 / 故障熔断） |
| 7.2 | 继续让任务执行 | **原任务继续正常执行**，只是不再有监督；日志出现一条 `limited`（只记一次），之后不再有新的 Jev 请求 |
| 7.3 | 展开 `详情` | 显示实际计数（如 `12/12`）与记账范围（按会话 / 按目标） |
| 7.4 | 不要为了继续验收而重置预算或改高预算；如需新预算，**新开一个会话**（那是新任务记账） | — |
| 7.5 | **预算可配置**：新安装（干净 profile）打开设置页 | 预算默认 **24**；都能看到 `12 / 24 / 48 / 自定义` |
| 7.6 | 选 `48`，再选 `自定义` 输入 `5` 保存 | 界面显示实际生效值 `5`；`/jev status` 的 `callBudget=5` |
| 7.7 | 输入非法值（`0`、`101`、`1.5`、`abc`） | 被拒绝并给出中文提示；`/jev status` 的 `callBudget` **不变** |
| 7.8 | 把预算从很小改大（例如 `2` → `24`），观察已用计数 | **已用计数不清零**；任务从「受限」回到「监督中」，随后继续消耗新额度 |
| 7.9 | 展开「高级」，把干预上限改成 `5` | 生效；`/jev status` 的 `interventionLimit=5`，`callBudget` 不受影响 |
| 7.10 | **升级不覆盖**：在已保存过预算的 profile 上更新插件 | 原来保存的值保留，不被新默认 24 覆盖 |
| 7.11 | **非法组合原子性**：初始 24/3，提交 `{callBudget:48, interventionLimit:99}` | 返回 400 `invalid_budget`；随后 `/jev status` 仍是 **24/3**；日志**没有**新增 `budget-change` 记录，`settings.json` 未被改写 |
| 7.12 | 反方向 `{callBudget:0, interventionLimit:9}` 与双非法 `{callBudget:101, interventionLimit:-1}` | 同样整体被拒，生效值不变 |
| 7.13 | 全合法组合 `{callBudget:48, interventionLimit:5}` | 一次性生效为 48/5，并且**只有这一次**写入 `budget-change` 审计 |
| 7.14 | **手动重置**：预算设 2 → 用到受限 → **空闲时** `/jev reset` → `/jev status` | 已用计数归零、上限仍为 2、模式/干预上限/key 不变；随后新工具调用**恢复**判断（日志出现新的 pre/post）；日志出现一条 `task-reset` |
| 7.15 | 重置范围：制造一次干预与一次暂停后 reset | 干预次数、暂停、故障/熔断与反馈去重都被清空；**同一失败证据可以再次干预**；原始会话失败记录与已提交反馈仍在 |
| 7.16 | 任务隔离：两个会话各消耗额度，只对其中一个 reset | 另一个会话的计数不受影响 |
| 7.17 | `off` 下 reset | 仍然零 API 调用；reset 不会开启监督 |
| 7.18 | **并发语义**：在有一次未结算 Jev 请求时 reset | 该判断被丢弃并记为 `task_reset`，不写回新的任务状态；已花掉的调用数不返还。记录实际行为，不要声称"随时 reset 安全" |

## 8. off / 禁用 / 卸载

| # | 操作 | 预期 |
|---|---|---|
| 8.1 | 控制条选 `off` | 后续工具调用**零** Jev 请求（日志行数不增）；工具与结果不受影响 |
| 8.2 | 回到 `shadow` | 有 Jev 请求与判断记录，但**不产生任何干预**（无 deny/ask/feedback） |
| 8.3 | 插件页**禁用** bundle | 控制条与设置页入口消失；普通任务照常；日志不再增长 |
| 8.4 | 重新启用 + 重启 | 已保存的模式与 key 恢复；连接自动重测 |
| 8.5 | **卸载**插件 | 插件行与入口消失；任务照常；凭据条目**不被自动删除**（回读 `$DSH_HOME/.credentials.yaml` 确认仍在） |
| 8.6 | 卸载后 gc 检查 | 进程内不再有本插件的监听器/定时器；卸载前的旧 key 值不残留（没有调用在飞时） |

## 9. 边界与回归

| # | 检查 | 预期 |
|---|---|---|
| 9.1 | 原审批仍然优先 | 审批通道拒绝/取消的工具，监督**不会**把它变成放行 |
| 9.2 | 工具结果保留 | 监督从不替换真实工具结果的内容或成功/失败事实 |
| 9.3 | 无 DeepSeek 总结调用 | 主模型请求数量不因插件增加；插件只调 TypeSafe |
| 9.4 | 无 Stop 强制续跑 | `ask_user` 之后该 turn 结束为 blocked；不会自动重新规划，需要你 `/jev resume` |
| 9.5 | 并发隔离 | 两个会话各自记账；一个会话预算用尽不影响另一个 |
| 9.6 | 取消与异常回退 | 取消正在进行的监督（切 `off`）后原任务继续；API 故障时原流程不受影响 |
| 9.7 | 敏感信息清理 | 日志、快照、工具结果里搜不到 key；快照含 `authorityRules` 与 `untrusted-tool-data` 标记 |

## 10. 回滚

1. 插件页卸载 `dsh-plugin-jev-supervisor`。
2. 确认 `cordis.patch.yml` / `package.json` 恢复（或与步骤 0 的哈希对比）。
3. 若需要，删除本 profile 的 `<profile 目录>/.jev-supervisor/`（设置与日志）。
4. 凭据条目按需清除：设置页 `清除密钥`，或直接编辑 `$DSH_HOME/.credentials.yaml` 删掉该 profile 的条目名。**不要**删除其他 profile 的条目。

## 记录表（验收者填写）

| 项 | 结果 | 证据（日志行/截图路径） | 备注 |
|---|---|---|---|
| 1 安装 | | | |
| 2 首次引导 | | | |
| 3 key + 真实 API + enforce | | | |
| 4 重启恢复 | | | |
| 5 拒绝未执行 | | | |
| 6 反馈入模 | | | |
| 7 预算受限 | | | |
| 8 off/禁用/卸载 | | | |
| 9 边界回归 | | | |

> 报告口径：**模拟判断**、**真实运行时测试**、**真实 API**、**真实 Desktop 验收**四类证据分开写。安装与槽注册成功不等于功能被使用过；一次真实 API 成功不等于拦截路径被验证过。
