# dsh-audit-mode

DeepSeek Harness (DSH) 的**第五模式**：preset id `audit`，把 PTC 的 `code`
呈现、独立审计和用户批准后的 Cordis 修复回路组合在同一个会话里。

该 preset 保留标准模式全部能力（Shell、文件系统、Web、Skills、Goals、
子代理、工作流和 Code Mode 工具呈现）。Cordis 自修改工具平时对模型隐藏，
只在用户接受 `critical` 修复后临时开放。同时每个会话使用两个隔离 reviewer
角色；审核后端可配置为 **Codex**、**Claude Code** 或宿主 **DSH LLM
runtime**。默认仍是一个持久 Codex app-server：

| 角色 | 默认模型 | Effort | 职责 |
| --- | --- | --- | --- |
| summarizer | `gpt-5.6-luna` | medium | 每轮增量 trace 总结 |
| auditor | `gpt-5.6-sol` | max | 独立审计 → `pass` / `warning` / `critical` |

Codex 与 Claude Code 为两个角色维护独立持久会话。DSH 后端直接执行无工具的
`llm.stream()`，不会再创建 DSH Agent，因此不会递归进入 Audit；该调用本身
无状态，所以 Audit 会在每次 DSH 审核时带上当前任务目标和 sidecar 中有界的
近期 reviewer memory。

所有未批准审计反馈和 reviewer 状态写入**独立 sidecar**
（`${DSH_HOME:-~/.dsh}/audit/sidecars/<sessionId>.json`）。只有用户明确
accept 后，系统才把边界化的 `<audit-remediation>` prompt 和临时能力租约
追加到上下文尾部；模型再通过稳定的 `skill` 工具按需加载其中点名的 Skill。
系统不会重写历史消息或暴露原始 reviewer 输出。

## 安装

```bash
# 在你的 dsh profile（profiles/web 与 profiles/tui 同套路）
cd ~/.dsh/profiles/web
pnpm add dsh-audit-mode@github:yhfgyyf/dsh-audit-mode
# Audit 与 Auto 目标 preset 推荐同时安装稳定工具发现插件：
pnpm add dsh-progressive-tools@github:yhfgyyf/dsh-progressive-tools
# 把两个 bundle 都加入 package.json 的 dsh.profile.bundles，然后重启 profile
```

本包 patch 只插入一个双面行：

```yaml
- insert:
    - id: audit-bundle
      name: dsh-audit-mode
```

Node 半边挂载宿主 `audits` 服务、注册 `/audit` 命令，并在存在
webserver 时提供 Remote API；浏览器半边（`dsh.client`）渲染 composer
dock 里的 audit 条。

## 使用

- `--preset audit`（TUI）或 Web preset 选择器 / 空白会话 `/preset audit`。
- `/audit status` — 轮次、审计间隔、最近判定、暂停状态。
- `/audit now` — 立即审计（不受节奏约束）。
- `/audit history` — 最近审计（来自 sidecar）。
- `/audit accept [audit-id]` — 接受最新/指定审计并进入独立修复轮。
- `/audit resume` — 解除非待批准 critical 的失败/手工暂停。

## Reviewer 配置

在 profile 的 `cordis.patch.yml` 里配置 `audit-bundle`。不写配置时保留
现有 Codex 默认值：

```yaml
- id: audit-bundle
  config:
    reviewer: codex
    binary: codex
    args: [app-server, --stdio]
    models:
      summarizer: { model: gpt-5.6-luna, effort: medium }
      auditor: { model: gpt-5.6-sol, effort: max }
```

`summarizer` 和 `auditor` 是按职责命名的稳定字段，模型名称可以任意配置。旧版
`luna` / `sol` 字段仍可读取，并会在运行时迁移为新名称。

Claude Code 使用 print + JSON schema、`plan` 权限模式、safe mode，并清空
model-facing tools；模型名需明确填写为 Claude Code 支持的名称：

```yaml
- id: audit-bundle
  config:
    reviewer: claude-code
    claudeBinary: claude
    claudeArgs: []
    models:
      summarizer: { model: haiku, effort: medium }
      auditor: { model: opus, effort: max }
```

DSH 后端直接使用已注册 provider。若总结和审计模型位于不同路由，可在角色内用
`provider` 覆盖 `dshProvider`：

```yaml
- id: audit-bundle
  config:
    reviewer: dsh
    dshProvider: deepseek-official
    dshMaxTokens: 4096
    models:
      summarizer: { model: deepseek-v4-flash, effort: off }
      auditor: { model: deepseek-v4-flash, effort: high }
```

切换 `reviewer` 不会自动翻译模型名。若目标后端不支持所配模型，Audit 会明确
失败，不会静默替换审核模型。

## 行为

- **审计节奏**：第一次审计至少 2 个 step 且运行 60 秒；之后每 3 个
  step 或 3 分钟审计，最小间隔 60 秒；异常在下一个安全边界审计。
- **warning 批准**：warning 出现后主 Agent 默认继续；用户可以直接执行审计
  意见，也可以先编辑。批准后使用 DSH 原生 `next-step` steering，与 Codex
  临时输入一致：当前 tool call 完成后执行编辑后的意见；Agent 空闲时立即执行。
- **critical 批准**：critical 先暂停主 Agent 和活动 Goal。用户 accept 后，
  可直接执行或先编辑审计意见，随后立即启动修复，临时开放专用 Cordis 工具并
  追加能力租约。修复 Agent 必须通过稳定的 `skill`
  loader 加载 `editing-cordis-compositions`；只有修改 plugin 或模型工具时才加载
  `cordis-plugin-development`。修复轮完成后强制验证审计；非 critical 才收回
  临时能力并恢复原任务。
- **连续三次失败**（reviewer 不可达、超时、回复无法解析）以 `failures`
  原因暂停。
- **每 5 轮**做一次完整目标对齐审计（目标 + 边界规则 + 近期总结）。
- **最终审计**：会话结束时自动执行（Remote API `final: true` 亦可）。
- **固定能力**：`audit`（`AUDIT_CAPABILITY`）。auto 路由仍然只
  路由 standard / code / minimal / cordis。

## Remote API

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/audit/snapshot` | `?session=<id>` |
| GET | `/api/audit/watch` | `?session=<id>`（SSE `event: audit`） |
| POST | `/api/audit/request-now` | `{ sessionId, final? }` |
| POST | `/api/audit/accept` | `{ sessionId, auditId?, editedText? }` |
| POST | `/api/audit/resume` | `{ sessionId }` |

Web dock 注册在 `conversation.input.dock` **order 5**：显示在 Todo（order
0）与 Goal（order 10）之间。

## TUI

`dsh-tui-app` 在配置行旁显示独立彩色块（pass 绿，warning、critical 和暂停红）：

- `a` — 原样执行待处理修复
- `e` — 把意见载入输入框；编辑后 Enter 执行，Esc 取消
- `c` — 暂停时复制审计意见
- `r` — 恢复非 critical-review 暂停
- `Esc` / `Ctrl+C` — 停止当前任务

## 开发

```bash
npm test            # 单元 + 集成
npm run check       # 语法、包清单、测试
npm run pack:check  # npm pack --dry-run
```

`scripts/build-preset.mjs` 从官方 `code` + `cordis` 合成
`presets/audit/agent.cordis.yml`（生成物已入库，包可独立运行）。测试使用
`test/fixtures/fake-codex.mjs` 与 `fake-claude.mjs`，无需真实 reviewer 登录。
审核后端、模型、effort、二进制、CLI 参数、DSH provider、超时与 DSH 输出上限
均为配置项，而非常量。

## 兼容性

- 不调用 `session.delete` 或任何会话删除 API；仅通过宿主
  `session/disposed` 事件观察结束并执行最终审计。
- Auto 仍只路由原来的四模式；若配套 auto router 支持 capability hints，提示只在
  路由完成后追加，不改原始用户 prompt。
- 图片、普通 Skills、Goals、子代理、工作流经 preset 原样流过；两项 Audit
  composition Skill 仅在批准 critical 后渐进加载。
- 已持久化消息保持逐字不变；accept 只追加 remediation、运行时 catalog 快照和
  continuation 尾消息，因此模型可复用此前消息前缀。配合
  `dsh-progressive-tools` 时，Cordis restriction 变化只改变发现结果，不改变模型可见
  的 system/tool 前缀；未安装配套插件时，DSH 仍会按正常规则重建 Code Mode SDK。
  若实际修复了 plugin/system prompt，后续重启或新 task 才重建对应 system 前缀。
- 不改全局 node_modules；以 profile bundle 方式安装。
