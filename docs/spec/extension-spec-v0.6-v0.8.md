# **dsh-plugin-status-board 功能扩展需求规格说明书 (Spec)**

* **目标基线版本**：v0.5.0（参考上游仓库 [ccclucky/dsh-plugin-status-board](https://github.com/ccclucky/dsh-plugin-status-board)）  
* **规划演进版本**：v0.6.0 – v0.8.0  
* **适用运行时**：DeepSeek Harness (DSH) Web UI 及桌面端（基于 Cordis 双半部插件体系）  
* **文档定位**：面向规格驱动开发（SDD）的功能需求与架构契约规范，作为编码实现、单元测试编写与 Code Review 的唯一事实源。

# **1\. 背景与目标**

## **1.1 现状评估**

`dsh-plugin-status-board` v0.5.0 已成功构建了"侧栏内联目录树 \+ 可拖拽环形分段悬浮窗"双入口，按**待我决策、正在执行、完成未看、近期记录**四个行动优先级对顶层会话进行实时分类重投影。

在多工作区高并发 Agent 协作场景下，现有版本仍存在以下体验断点：

1. **侧栏收起态盲区**：左侧栏收起至 56px 窄轨或隐藏时，内联目录树随之隐藏，若用户收起或遮挡了悬浮按钮，将失去待处理状态的直观感知。  
2. **多项目噪音混杂**：所有工作区的顶层会话扁平混合展示，缺乏按当前活跃工作区或关键字快速收敛视图的能力。  
3. **只读无治理闭环**：「完成未看」与「近期记录」聚集了大量已结束会话，但操作者只能逐一点开处理，缺少批量归档等台面清理手段。  
4. **轻重缓急无时间维度**：刚弹出的提问与已阻塞数小时的关键审批在「待我决策」中视觉权重相同；后台定时/自动化任务与人工交互会话混排。  
5. **就地审批题型受限**：L2 题卡仅支持 `continued` 文本追问就地提交，高频的单选、多选与轻量计划确认仍需频繁切回主工作区。  
6. **上下文预览缺失**：会话行仅展示标题与相对时间，无法在不切页的前提下感知子 Agent 派生规模或最新进展摘要。

## **1.2 核心演进目标**

在不破坏现有极简架构与零轮询响应式模型的前提下，围绕**全天候感知、视图降噪、结构化审批、批量治理**四大方向交付 6 项增量特性（FEAT-01 至 FEAT-06）。

# **2\. 架构不变量与设计红线（Invariants & Non-Goals）**

所有新增需求的实现必须严格遵守以下四条原仓库架构红线，任何违反红线的实现方案均视为不合格：

1. **极薄无状态 Host 半部**：`src/index.ts` 仅负责插件配置 Schema 声明、上下界钳制与单一只读路由 `GET /status-board/config` 暴露。严禁在 Host 侧引入会话日志磁盘扫描、WebSocket 私有通道或持久化数据库。  
2. **单点运行时防腐层（ACL）**：所有针对 DSH 运行时会话快照、`userQuestions` 投影、工作区元数据与子会话关系的字段解析，必须唯一收敛在 `src/client/session-source.ts`。下游 `src/shared/board.ts` 与 React 视图组件只消费标准化内部契约，不直接接触宿主原始对象。  
3. **状态单一事实源（拒绝双口径漂移）**：插件不自建跨页面刷新的本地"已读状态表"。未读提醒严格以宿主 `useSessionStatus` 内存广播为准，确保插件绿点与原生侧栏绿点永远一致。  
4. **可逆挂载与零残留清理**：所有新增槽位注入、DOM 监听、定时器与外部状态订阅必须注册在 Cordis 的 `ctx.effect` 生命周期内；组件卸载或插件停用后，DOM 节点、事件句柄与内存计时器必须 100% 释放；宿主服务缺失时必须渐进降级（渲染静态文本或隐藏按钮，绝不渲染点击无效的假按钮）。

## **明确不做事项（Non-Goals）**

* 不接管或整体替换官方左侧栏外壳 `dsh-client-ui-sidebar` 的 `sidebar` 根槽位（避免破坏其他插件对 7 个官方子槽位的依赖）。  
* 不逆向拼装未公开的复杂 `open` 题型私有提交报文。  
* 不向任何外部域名发送遥测、统计或网络请求。

# **3\. 功能需求规格详述（Functional Specifications）**

## **FEAT-01：侧栏折叠态原生角标（Collapsed Sidebar Toggle Badge）**

### **3.1.1 需求背景与宿主契约**

DSH 官方左侧栏外壳在收起按钮内预留了单例槽位 `sidebar.toggle.badge`（`kind: 'single', scope: 'root'`，仅在侧栏收起态渲染于展开图标旁，属非交互视觉角标）。当前该槽位默认空闲，注入该槽位可填补侧栏收起至 56px 轨道时的状态感知空白。

### **3.1.2 核心逻辑与展现规则**

* **数值与状态口径**（与悬浮环形按钮中心口径对齐）：  
  * **高优数字态**：当 `urgentCount = decisionCount + completionUnreadCount > 0` 时，渲染胶囊数字角标；数值超过 99 时显示 `99+`。若 `decisionCount > 0` 采用琥珀色强调底色，仅 `completionUnreadCount > 0` 采用完成绿底色。  
  * **后台运行指示态**：当 `urgentCount === 0` 且 `executingCount > 0` 时，渲染无数字的 6px 蓝色脉冲圆点（受 `prefers-reduced-motion` 控制退化为静态圆点）。  
  * **空闲静默态**：当上述计数均为 0 时，组件返回 `null`，不渲染任何占位节点。  
* **非交互约束**：角标根节点必须设置 `pointer-events: none` 与 `aria-hidden="true"`，收起按钮的无障碍计数说明通过轻量属性补充或交由悬浮入口承担，绝不阻断宿主原生的侧栏展开点击事件。

### **3.1.3 边界与降级策略**

* **槽位占用冲突容错**：由于 `sidebar.toggle.badge` 为 `single` 单例槽位，若用户安装了其他占用该槽位的侧栏插件，注册时捕获 `SlotOwnershipError` 后静默放弃该槽位注入并输出单次开发环境告警，不影响 `sidebar.panellist` 与 `shell.overlay` 正常工作。  
* **配置开关**：受新增配置项 `showCollapsedBadge`（默认 `true`）控制；运行时关闭配置或卸载插件时立即注销槽位。

### **3.1.4 验收标准（AC）**

- [ ] 左栏展开时角标不显示；收起左栏且存在 2 条待决策、1 条完成未看会话时，展开按钮右上角清晰展示琥珀色 `3` 角标。  
- [ ] 点击角标覆盖区域仍能正常触发左栏展开，无事件吞没。  
- [ ] 当模拟 `sidebar.toggle.badge` 已被第三方插件先行注册时，插件整体初始化不抛未捕获异常，内联树与悬浮窗功能完好。

## **FEAT-02：多维工作区与关键字过滤（Workspace & Keyword Filtering）**

### **3.2.1 需求背景**

操作者同时开启多个代码仓库（Workspace）推进任务时，浮窗内所有会话混合排列。需要提供零延迟的内存级过滤能力，支持一键聚焦"当前所在工作区"或按词检索。

### **3.2.2 数据流与纯函数管道设计**

1. **防腐层扩展（`src/client/session-source.ts`）**：从会话快照提取 `workspaceId?: string`、`workspaceName?: string`，同时从 `ctx.uiWorkspace` 订阅当前主视图激活的 `activeWorkspaceId?: string`。  
2. **纯函数过滤层（`src/shared/board.ts`）**：在顶层有效会话提取之后、四栏分类与 `maxRecent` 截断之前执行过滤函数 `applyBoardFilter(sessions, filterState, activeWorkspaceId)`：  
   * **工作区范围（Scope）**：支持 `'all'`（全部工作区，默认）与 `'current'`（仅匹配 `activeWorkspaceId` 的会话；若当前宿主无激活工作区，自动置灰 `'current'` 选项并回退按 `'all'` 展示）。  
   * **关键字匹配（Keyword）**：大小写不敏感的子串匹配，同时检索 `session.title` 与 `session.workspaceName`。  
3. **重算联动**：浮窗顶部的分栏计数与「另有 N 个较早会话未显示」截断提示基于过滤后的结果集实时计算；当存在激活的过滤条件时，浮窗标题栏右侧显示「已过滤」微标，避免用户误以为其他工作区没有待办（悬浮环形按钮本身始终反映**全局未过滤**的真实待办数，确保全局哨兵职责不被局部过滤器屏蔽）。

### **3.2.3 交互与持久化规范**

* **作用范围**：仅在浮窗面板（`Panel.tsx`）头部渲染紧凑过滤工具条；侧栏内联树（`Tree.tsx`）维持零输入框纯导航形态。  
* **键盘交互**：在浮窗内按 `/` 或 `Mod+F`（焦点在面板内时）快速聚焦搜索框；搜索框非空时按 `Esc` 优先清空搜索词并保留浮窗开启，搜索框为空时按 `Esc` 关闭浮窗并归还焦点。  
* **状态持久化**：工作区范围偏好（`'all' | 'current'`）持久化至 `localStorage` 键 `dsh-plugin-status-board.filter.v1`；搜索关键字仅保存在内存态，关闭浮窗不清空，刷新页面重置为空。

### **3.2.4 验收标准（AC）**

- [ ] 切换至「当前工作区」后，四栏仅展示归属当前激活工作区的会话，且悬浮圆环按钮仍准确指示全局总待办数。  
- [ ] 输入关键字后 0 防抖即时过滤四栏列表；匹配结果为空时展示「无匹配会话，点击清空过滤条件」的明确空状态引导。  
- [ ] 连续两次按下 `Esc` 键依次完成"清空搜索词 → 收起浮窗面板"。

## **FEAT-03：批量会话治理（Batch Session Triage）**

### **3.3.1 需求背景**

多轮并发任务结束后，「完成未看」与「近期记录」会堆积大量历史会话。操作者需要直接在浮窗内完成已完成会话的批量归档或未读消解。

### **3.3.2 核心功能与宿主能力探测**

1. **批量归档（Batch Archive）**：  
   * **开放分栏**：仅在浮窗面板的「完成未看」与「近期记录」分栏标题栏右侧提供「批量归档」动作按钮；**严禁**对「待我决策」与「正在执行」分栏暴露归档操作，防止误杀活跃任务。  
   * **能力探测**：在 `session-source.ts` / 服务适配层检测宿主 `ctx.uiWorkspace` 是否暴露会话归档方法（如 `archiveSession(sessionId)`）。若当前宿主版本或运行环境未暴露该写接口，直接隐藏归档按钮，遵循渐进降级原则。  
2. **一键清除完成未看提醒（Clear Completion Unread）**：  
   * **严格遵循单一事实源约束**：优先探测宿主 `useSessionStatus` 上下文是否提供清除未读方法（如 `markRead` / `clearUnread`）。若宿主提供官方写接口，则调用该接口同步消除看板与原生侧栏绿点；若宿主仅维持只读广播而未开放清除接口，则隐藏「一键标为已读」按钮，绝不在插件本地伪造独立已读表导致与原生侧栏绿点不一致。

### **3.3.3 防误触与批处理执行机制**

* **内联二次确认条（Inline Confirmation）**：当单次待归档会话数大于或等于 3 条时，点击「批量归档」在当前分栏头部展开内联确认条（显示「确认归档当前栏 N 个已完成会话？\[确认\] \[取消\]」），禁止使用阻塞式的浏览器原生 `window.confirm`。  
* **并发限流与部分失败容错**：执行批量调用时以最大并发度 5 分批调用宿主接口，执行期间按钮进入 `busy` 禁用态并显示进度；若部分会话归档失败，保留失败行并在分栏顶部展示非阻塞错误摘要，已成功项随宿主快照更新自动移出看板。

### **3.3.4 验收标准（AC）**

- [ ] 「待我决策」与「正在执行」栏在任何状态下均不出现归档入口。  
- [ ] 存在 5 条「近期记录」会话且宿主支持归档接口时，点击批量归档弹出内联确认条，确认后按并发上限完成调用，遇到单条异常不中断其余 4 条处理。  
- [ ] 宿主未提供归档 API 时，界面不渲染禁用态废按钮或报错提示。

## **FEAT-04：决策阻塞时长分级告警与自动化会话分流（SLA Escalation & Automated Routing）**

### **3.4.1 阻塞时长计算与三级视觉升级**

1. **时间基准采集**：  
   * 防腐层优先读取 `userQuestions.active` 载荷中的问题发起时间戳（如 `createdAt` / `timestamp`）。  
   * **无时间戳回退机制**：若运行时快照未携带提问时间戳，由 `src/client/store.ts` 维护内存映射 `decisionEnteredAtMap: Map<sessionId, number>`——首次观测到会话落入 `decision` 态时记录当前时间戳，会话离开 `decision` 态时立即清除该键。  
2. **分级阈值与计算**：  
   * **常规态（Normal）**：阻塞时长小于 `decisionWarnMinutes`（默认 15 分钟），保持现有琥珀色呼吸环。  
   * **预警态（Warning）**：阻塞时长介于 `decisionWarnMinutes` 与 `decisionCriticalMinutes`（默认 60 分钟）之间，会话行右侧显示琥珀色底时长徽章（如 `等待 25m`）。  
   * **严重超时态（Critical）**：阻塞时长大于或等于 `decisionCriticalMinutes`，状态记号切换为高对比告警色（取自宿主语义错误/危险主题令牌，如 `--dsw-semantic-danger` 系列），时长徽章高亮显示（如 `阻塞 2h`），且在「待我决策」栏内按阻塞时长降序优先置顶。  
3. **低功耗定时刷新**：仅当 `decisionCount > 0` 且页面处于可见状态（监听 `document.visibilitychange`）时，启动每 30 秒一次的轻量节拍器更新相对等待时长；当 `decisionCount === 0` 或页面隐藏时立即暂停定时器，实现零空转开销。

### **3.4.2 自动化/后台触发会话分流（可选第 5 栏）**

* **识别规则**：防腐层检查顶层会话的 `origin` 字段或触发器元数据（例如 `origin: 'cron' | 'schedule' | 'webhook' | 'automation'`，依然严格过滤 `origin: 'subagent'`）。  
  \|---\|---\|**分栏逻辑**：新增布尔配置项 `separateAutomatedSessions`（默认 `false`，保证升级后默认仍为经典四栏）：  
  * 当设为 `true` 时，新增常驻可折叠栏\*\*「自动任务（Automated）」\*\*（排在「完成未看」之后、「近期记录」之前）。  
  * **最高优先级豁免不变**：若一个自动化会话在执行中途调用了 `ask_user_question` 请求人工介入，它依然无条件升入 P0「待我决策」栏；仅当其处于后台静默执行或近期完结态时，才归入「自动任务」栏，避免高频定时任务刷屏冲掉人工对话记录。

### **3.4.3 验收标准（AC）**

- [ ] 待决策会话超过超时阈值后自动置顶并展示告警级等待时长徽章；切换标签页至后台时 30 秒节拍器停止触发重绘，切回前台立即刷新一次。  
- [ ] 开启 `separateAutomatedSessions: true` 后，定时巡检会话被隔离至「自动任务」栏；一旦该定时会话发起人工提问，立即跳入「待我决策」栏。

## **FEAT-05：L2 结构化就地审批题卡（Structured Inline Question Card）**

### **3.5.1 需求背景**

当前 `QuestionCard.tsx` 仅支持 `continued` 自由文本追问的就地提交。实际 Agent 工作流（尤其是架构评审、方案二选一、危险命令确认）大量使用单选、多选与计划审阅题型，扩展结构化渲染可大幅减少跨会话切页损耗。

### **3.5.2 题型解析与渲染矩阵**

| 题型分类（标准化枚举） | 防腐层识别特征 | 浮窗 L2 题卡渲染与交互行为 | 提交方式 |
| :---- | :---- | :---- | :---- |
| `continued` | 文本追问且无选项列表 | 保留现有紧凑文本框与快捷回车提交 | 调用宿主回答回调就地提交 |
| `single_select` | 含 `options` 数组且 `multiple !== true` | 渲染无障碍单选组（Radio Group）；若支持自定义补充则附带「其他」展开输入框 | 选中后点击提交按钮就地完成 |
| `multi_select` | 含 `options` 数组且 `multiple === true` | 渲染复选框组（Checkbox Group），校验至少选中 1 项（或遵循 `minSelect`） | 勾选后点击提交按钮就地完成 |
| `confirm` | 二元确认或轻量计划审批（正文不超阈值） | 渲染折叠式摘要预览（最多展示 6 行，可展开至 500 字符裁剪上限），底部提供「批准」「驳回并说明」双按钮 | 就地提交布尔/审批结论与附言 |
| `complex_open` | 多题组合表单、超长计划书或未知 Schema | 安全回退：仅展示题目首段只读摘要，渲染醒目的「打开会话处理完整题卡」跳转按钮 | 走 `uiWorkspace.openSession` 跳转 |

### **3.5.3 幂等提交与并发竞态防护**

* **提交态锁定**：点击提交后，当前题卡立即进入 `submitting` 只读禁用态，防止快速连点触发双发。  
* **快照竞态消解**：若用户在浮窗展开某题卡期间，已在主聊天窗口回答了该问题（宿主快照中该 `questionId` 已消失或变更为新的 `questionId`），组件检测到 `questionId` 变更后立即重置本地表单草稿并刷新题卡视图，绝不把旧题草稿误提交给新问题。  
* **失败保留草稿**：若宿主提交回调抛错，解除禁用态、保留用户已选/已填内容，并在题卡底部以内联红色提示展示失败原因及「跳转原会话重试」备选链接。

### **3.5.4 验收标准（AC）**

- [ ] 单选、多选与二元确认题可在浮窗内全程通过纯键盘（Tab / Space / Arrow / Enter）完成选择与提交，提交成功后会话自动从「待我决策」流转至「正在执行」。  
- [ ] 遇到未知字段结构或超大负载的多步表单题时，防腐层安全归类为 `complex_open`，不崩溃、不丢字段，准确引导跳转原会话。  
- [ ] 模拟主窗口抢先回答同一问题时，浮窗题卡自动同步收起或切换新题，不会发生错位提交。

## **FEAT-06：会话行上下文摘要与资源指标透出（Inline Context & Telemetry Preview）**

### **3.6.1 需求背景**

在浮窗查看「正在执行」或「完成未看」会话时，仅凭会话标题难以判断 Agent 当前推进到了哪一步、是否派发了多个子 Agent 协同工作。

### **3.6.2 防腐层聚合与裁剪规则（`src/client/session-source.ts`）**

1. **子 Agent 活跃聚合（Subagent Aggregation）**：  
   * 原有逻辑直接丢弃了 `origin: 'subagent'` 或携带 `parentSessionId` 的子会话行。  
   * **升级逻辑**：主列表依然不单独展示子会话行（避免幽灵行），但在单遍扫描快照时，按 `parentSessionId` 统计归属各顶层会话的**总子会话数**与**运行中子会话数**（`runningSubagentCount`）。当 `runningSubagentCount > 0` 时，在父会话行展示紧凑微标（如 `2 子代理运行中`）。  
2. **最新消息单行摘要（Last Message Snippet）**：  
   * 若运行时快照包含最新消息摘要或状态描述（如 `lastMessageText` / `activeToolName`），在防腐层执行纯文本清洗（移除换行符、代码块围栏与常见 Markdown 标记符号）并硬裁剪至最多 **80 个字符**（避免在内存中持有长文本引用）。  
3. **可选轻量遥测指标**：若快照暴露当前会话累计耗时或 Token 用量字段，格式化为简短标签（如 `14.2k tok`）；若宿主快照未暴露相关字段，静默忽略，绝不发起额外详情查询请求。

### **3.6.3 视觉密度控制**

* **双轨密度策略**：侧栏内联树（`Tree.tsx`）始终锁定**单行紧凑态**（仅标题 \+ 状态记号 \+ 子代理数字微标），保持与原生工作区树一致的行高节奏；浮窗面板（`Panel.tsx`）受配置项 `panelDensity`（`'comfortable' | 'compact'`，默认 `'comfortable'`）控制，`'comfortable'` 模式下渲染第二行浅色副标题展示清洗后的最新摘要与运行工具提示。

### **3.6.4 验收标准（AC）**

- [ ] 当某顶层会话派生了 3 个子 Agent（其中 2 个运行中、1 个已完成）时，主列表不出现任何子会话独立行，父会话行准确显示 `2 子代理` 动态徽章。  
- [ ] 包含多行代码块或 HTML 标签的摘要文本被安全清洗为单行纯文本并截断在 80 字符以内，无 XSS 风险与布局撑破现象。  
- [ ] 侧栏内联树行高保持单行不变；将 `panelDensity` 设为 `'compact'` 后浮窗同步收起副标题行。

# **4\. 配置 Schema 与本地存储契约演进**

## **4.1 `cordis.patch.yml` 新增配置项规范**

在 `src/shared/config.ts` 与 `src/index.ts` 中扩展以下配置项，严格延续"越界钳制、非法类型回退默认值、绝不抛错阻断加载"的防御准则：

| 配置键名 | 类型 | 默认值 | 合法范围 / 枚举 | 钳制与容错规则说明 |
| :---- | :---- | :---- | :---- | :---- |
| `showCollapsedBadge` | boolean | `true` | `true` / `false` | 非布尔值回退为 `true`；控制 FEAT-01 侧栏收起态角标注入 |
| `decisionWarnMinutes` | number | `15` | `1 – 1440` | 越界钳制；非有限数值回退 `15`；控制 FEAT-04 预警态阈值 |
| `decisionCriticalMinutes` | number | `60` | `5 – 4320` | 越界钳制，且强制兜底 `Math.max(val, decisionWarnMinutes)` |
| `separateAutomatedSessions` | boolean | `false` | `true` / `false` | 非布尔值回退为 `false`；开启后启用「自动任务」独立分栏 |
| `panelDensity` | string | `'comfortable'` | `'comfortable'` / `'compact'` | 非法枚举值回退为 `'comfortable'`；仅作用于浮窗面板行密度 |

*(注：既有配置项 `recentWindowHours`、`maxRecent`、`defaultCollapsed`、`showEmptyBuckets` 的签名与默认行为保持 100% 向后兼容；其中 `defaultCollapsed` 枚举新增可选值 `'automated'`。)*

## **4.2 浏览器 `localStorage` 存储键清单**

所有本地存储读写统一封装在带 `try/catch` 的安全访问器内（无痕/沙箱禁用存储时自动退化为内存态）：

| 键名 | 版本状态 | 存储结构摘要 | 清理与迁移策略 |
| :---- | :---- | :---- | :---- |
| `dsh-plugin-status-board.collapse.v1` | 既有扩展 | `{ decision, executing, automated?, recent }` 布尔字典 | 缺省键按配置默认值补齐，向后兼容旧版存档 |
| `dsh-plugin-status-board.fab.v1` | 保持不变 | `{ x: number, y: number }` 悬浮窗锚点坐标 | 重置位置时直接 `removeItem` 删键 |
| `dsh-plugin-status-board.filter.v1` | **本次新增** | `{ workspaceScope: 'all' | 'current' }` | 非法 JSON 或未知枚举静默回退为 `{ workspaceScope: 'all' }` |

# **5\. 共享类型契约演进草案（`src/shared/types.ts`）**

以下为支撑上述 6 项扩展的核心同构类型契约定义草案：

```
export type BucketId = 'decision' | 'executing' | 'unread' | 'automated' | 'recent';

export type DecisionSeverity = 'normal' | 'warning' | 'critical';

export type QuestionKind =
  | 'continued'
  | 'single_select'
  | 'multi_select'
  | 'confirm'
  | 'complex_open';

export interface QuestionOptionItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface NormalizedQuestionPayload {
  readonly questionId: string;
  readonly kind: QuestionKind;
  readonly promptText: string;
  readonly summaryPreview?: string; // 经 500 字符安全裁剪的审阅摘要
  readonly options?: readonly QuestionOptionItem[];
  readonly allowCustomInput?: boolean;
  readonly askedAtMs?: number;      // 快照原生时间戳或 store 首次观测时间
}

export interface NormalizedSessionItem {
  readonly id: string;
  readonly title: string;
  readonly updatedAtMs: number;
  readonly workspaceId?: string;
  readonly workspaceName?: string;
  readonly isExecuting: boolean;
  readonly isAutomatedOrigin: boolean;
  readonly completionUnread: boolean;
  readonly activeQuestion?: NormalizedQuestionPayload;
  readonly subagentStats?: {
    readonly total: number;
    readonly running: number;
  };
  readonly contextPreview?: {
    readonly snippet?: string;      // 经单行清洗且 <= 80 字符
    readonly activeTool?: string;
    readonly tokenCount?: number;
  };
}

export interface BoardFilterState {
  readonly workspaceScope: 'all' | 'current';
  readonly keyword: string;
}
```

# **6\. 测试矩阵与分阶段交付路线图**

## **6.1 增量单元测试覆盖要求（Vitest）**

每次迭代合入前必须通过 pnpm typecheck（strict \+ exactOptionalPropertyTypes）、全量单元测试与 pnpm verify 构建产物自检：

| 测试模块 | 对应测试文件 | 必测场景与边界用例 |
| :---- | :---- | :---- |
| 过滤与分流算法 | `tests/board.test.ts` | 工作区过滤与关键字组合匹配；自动化会话在常规态入 `automated` 栏、遇提问强制升入 `decision` 栏；阻塞时长分级计算与置顶稳定性 |
| 配置钳制扩展 | `tests/config.test.ts` | 新增 5 项配置的默认值、非法类型回退，特别是 `decisionCriticalMinutes < decisionWarnMinutes` 时的自动抬升钳制 |
| 防腐层聚合与裁剪 | `tests/session-source.test.ts` | 子 Agent 按 `parentSessionId` 聚合计数且不混入顶层行；5 类题型载荷识别与未知结构安全回退 `complex_open`；80/500 字符超长裁剪与换行符剥离 |
| 收起态角标注入 | `tests/collapsed-badge.test.tsx` | 槽位注册、计数规则、`99+` 封顶、`SlotOwnershipError` 冲突优雅降级、`ctx.effect` 卸载清理 |
| 结构化题卡与批量操作 | `tests/panel.test.tsx` | 单选/多选/确认题键盘可访问性与 `aria-*` 关联、`submitting` 锁与 `questionId` 切换防串台；批量归档内联确认条、并发限流与宿主缺服务隐藏按钮 |
| 双英字典对齐 | `tests/i18n.test.ts` | `locale/zh.json` 与 `locale/en.json` 新增文案键 100% 对齐校验、单遍插值安全性 |

## **6.2 分阶段实施路线图（Rollout Plan）**

1. **Milestone 1（v0.6.0 — 感知增强与视图降噪）**：  
   * 交付 **FEAT-01（侧栏收起态原生角标）**、**FEAT-02（多维工作区与关键字过滤）** 与 **FEAT-06（子 Agent 聚合计数与上下文摘要）**。  
   * 特点：纯只读感知增强，不涉及新增宿主写操作调用，风险最低、日常体感收益最直接。  
2. **Milestone 2（v0.7.0 — 结构化审批收件箱）**：  
   * 交付 **FEAT-05（L2 结构化就地审批题卡）** 与 **FEAT-04（决策阻塞时长分级告警及自动化会话分流）**。  
   * 特点：重点打磨 `QuestionCard.tsx` 状态机与幂等保护，将悬浮窗升级为完整的多 Agent 决策调度中心。  
3. **Milestone 3（v0.8.0 — 批量会话治理闭环）**：  
   * 交付 **FEAT-03（批量归档与未读消解探测）**。  
   * 特点：充分验证不同 DSH 版本下 `uiWorkspace` 归档接口与状态广播的兼容性，完成从"监控调度"到"台面清理"的全链路闭环。

