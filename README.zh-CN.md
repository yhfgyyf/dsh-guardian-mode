# dsh-guardian-mode

DeepSeek Harness (DSH) 的**第五模式**：preset id `guardian`，把 PTC 的 `code`
呈现与 `cordis` 工具集组合在同一个会话里，并由**独立审计器**逐轮守护。

该 preset 保留标准模式全部能力（Shell、文件系统、Web、Skills、Goals、
子代理、工作流、Code Mode 工具呈现以及 Cordis 运行时工具集）。同时每个
会话驱动一个**持久 Codex app-server** 进程：

| Worker | 模型 | Effort | 职责 |
| --- | --- | --- | --- |
| luna | `gpt-5.6-luna` | medium | 每轮增量 trace 总结 |
| sol | `gpt-5.6-sol` | max | 独立审计 → `pass` / `warning` / `critical` |

所有审计反馈写入**独立 sidecar**
（`${DSH_HOME:-~/.dsh}/guardian/sidecars/<sessionId>.json`），**绝不写入**
会话日志——不污染模型上下文，审计内容也无法反向提示注入被审计会话。

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
- `/guardian resume` — 解除安全/失败暂停。

## 行为

- **自适应节奏**：`pass` 后审计间隔翻倍（1→2→4→8 封顶）；`warning`
  立即回到 1；`critical` 触发安全边界暂停（取消当前轮次，暂停期间不再
  审计直到 `resume`）。
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
| POST | `/api/guardian/resume` | `{ sessionId }` |

Web dock 注册在 `conversation.input.dock` **order 5**：显示在 Todo（order
0）与 Goal（order 10）之间。

## TUI

`dsh-tui-app` 在配置行旁显示独立彩色块（pass 绿、warning 黄、
critical/暂停 红）：

- `c` — 立即审计（空输入框时）
- `r` — 解除暂停（空输入框时）
- `Esc` — 折叠/展开该块

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
- 图片、Skills、Goals、子代理、工作流经 preset 原样流过。
- 不改全局 node_modules；以 profile bundle 方式安装。
