# dsh-guardian-mode

DeepSeek Harness (DSH) 的**第五模式**：preset id `guardian`，把 PTC 的 `code`
呈现、独立审计和用户批准后的 Cordis 修复回路组合在同一个会话里。

该 preset 保留标准模式全部能力（Shell、文件系统、Web、Skills、Goals、
子代理、工作流和 Code Mode 工具呈现）。Cordis 自修改工具平时对模型隐藏，
只在用户接受 `critical` 修复后临时开放。同时每个
会话驱动一个**持久 Codex app-server** 进程：

| Worker | 模型 | Effort | 职责 |
| --- | --- | --- | --- |
| luna | `gpt-5.6-luna` | medium | 每轮增量 trace 总结 |
| sol | `gpt-5.6-sol` | max | 独立审计 → `pass` / `warning` / `critical` |

所有未批准审计反馈和 reviewer 状态写入**独立 sidecar**
（`${DSH_HOME:-~/.dsh}/guardian/sidecars/<sessionId>.json`）。只有用户明确
accept 后，系统才把边界化的 `<guardian-remediation>` prompt 和必要 Skill
追加到上下文尾部；不会重写历史消息或暴露原始 reviewer 输出。

## 安装

```bash
# 在你的 dsh profile（profiles/web 与 profiles/tui 同套路）
cd ~/.dsh/profiles/web
pnpm add dsh-guardian-mode@github:yhfgyyf/dsh-guardian-mode
# 把 "dsh-guardian-mode" 加入 package.json 的 dsh.profile.bundles，然后重启 profile
```

本包 patch 只插入一个双面行：

```yaml
- insert:
    - id: guardian-bundle
      name: dsh-guardian-mode
```

Node 半边挂载宿主 `guardians` 服务、注册 `/guardian` 命令，并在存在
webserver 时提供 Remote API；浏览器半边（`dsh.client`）渲染 composer
dock 里的 guardian 条。

## 使用

- `--preset guardian`（TUI）或 Web preset 选择器 / 空白会话 `/preset guardian`。
- `/guardian status` — 轮次、审计间隔、最近判定、暂停状态。
- `/guardian now` — 立即审计（不受节奏约束）。
- `/guardian history` — 最近审计（来自 sidecar）。
- `/guardian accept [audit-id]` — 接受最新/指定审计并进入独立修复轮。
- `/guardian resume` — 解除非待批准 critical 的失败/手工暂停。

## 行为

- **审计节奏**：第一次审计至少 2 个 step 且运行 60 秒；之后每 3 个
  step 或 3 分钟审计，最小间隔 60 秒；异常在下一个安全边界审计。
- **warning 批准**：warning 出现后主 Agent 默认继续；只有用户 accept，
  才会暂停当前主 Agent，追加已批准修复 prompt，执行并重新审计。
- **critical 批准**：critical 先暂停主 Agent 和活动 Goal。用户 accept 后，
  临时开放专用 Cordis 工具，并在上下文尾部加载
  `editing-cordis-compositions` 与 `cordis-plugin-development`。修复轮完成后
  强制验证审计；非 critical 才收回临时能力并恢复原任务。
- **连续三次失败**（Codex 不可达、超时、回复无法解析）以 `failures`
  原因暂停。
- **每 5 轮**做一次完整目标对齐审计（目标 + 边界规则 + 近期总结）。
- **最终审计**：会话结束时自动执行（Remote API `final: true` 亦可）。
- **固定能力**：`guardian`（`GUARDIAN_CAPABILITY`）。auto 路由仍然只
  路由 standard / code / minimal / cordis。

## Remote API

| 方法 | 路径 | 参数 |
| --- | --- | --- |
| GET | `/api/guardian/snapshot` | `?session=<id>` |
| GET | `/api/guardian/watch` | `?session=<id>`（SSE `event: guardian`） |
| POST | `/api/guardian/request-now` | `{ sessionId, final? }` |
| POST | `/api/guardian/accept` | `{ sessionId, auditId? }` |
| POST | `/api/guardian/resume` | `{ sessionId }` |

Web dock 注册在 `conversation.input.dock` **order 5**：显示在 Todo（order
0）与 Goal（order 10）之间。

## TUI

`dsh-tui-app` 在配置行旁显示独立彩色块（pass 绿，warning、critical 和暂停红）：

- `a` — 接受待处理修复（空输入框时）
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
`presets/guardian/agent.cordis.yml`（生成物已入库，包可独立运行）。测试使用
`test/fixtures/fake-codex.mjs`，无需真实 Codex 登录。Codex 模型是可配置项
而非常量：`{ "models": { "luna": {...}, "sol": {...} } }`。

## 兼容性

- 不调用 `session.delete` 或任何会话删除 API；仅通过宿主
  `session/disposed` 事件观察结束并执行最终审计。
- 不改 auto 路由（仍只路由四模式）。
- 图片、普通 Skills、Goals、子代理、工作流经 preset 原样流过；两项 Guardian
  composition Skill 仅在批准 critical 后渐进加载。
- 已持久化消息保持逐字不变；accept 只追加 remediation、运行时 catalog 快照和
  continuation 尾消息，因此模型可复用此前前缀的 KV cache。动态工具 schema 只影响
  新请求尾部；若实际修复了 plugin/system prompt，后续重启或新 task 才会按 DSH
  正常规则重建对应 system 前缀。
- 不改全局 node_modules；以 profile bundle 方式安装。
