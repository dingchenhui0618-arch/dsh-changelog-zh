# CHANGELOG

本文件按版本倒序记录本工程的改动。文案由人写；工具本身生成的是**被分析仓库**的变更日志，不是这一份。

## 0.1.0 — 2026-10-16

首个版本。功能范围：从真实 git 历史生成用户版（短）与开发者版（长）两份中文变更日志，每条带 commit SHA 与「已验证／未验证」标记。

### 新增

- **只读 git 采集**（`src/git.js`）：`git log` 元数据 + `--numstat` 两次调用拿到提交与文件增减；支持范围、`--since`、条数上限、是否含合并提交；reserved 参数白名单（拒绝以 `-` 开头的 rev，挡住 `--output=<file>` 之类的选项注入）；空仓库不崩。
- **默认范围推导**（`defaultRange`）：无标签取最近提交；有标签取 `标签..HEAD`；最新标签已在 HEAD 上时回退到上一个标签，避免重写已发布的提交。
- **提交分类**（`src/classify.js`）：约定式提交前缀优先，其次词边界匹配的关键词表；破坏性变更单独成组；合并提交在关键词表之前单独识别（否则分支名里的 `feature-` 会被误判成「新功能」）。
- **验证证据判定**（`src/evidence.js`）：四类可引用证据（提交信息 trailer、git notes trailer、会话记录里退出码为 0 的验证命令、`failed=0 且 passed>0` 的测试计数）；通过与失败并存时保守记为未验证；只有 `verified: true` 而无证据的记为「声称但无证据」。
- **脱敏**（`src/redact.js`）：GitHub token、`sk-` key、Slack token、AWS key id、JWT、Bearer、私钥块、连接串、`password:`/`token:` 赋值、`C:\Users\…` 与 `C:/Users/…` 两种本机路径写法；渲染前完成，并报出命中数量。
- **会话记录叠加**（`src/sessions.js`）：约定的 JSON / JSONL 摘要格式；按完整 sha、唯一前缀、短 sha 三级匹配，有歧义进歧义清单、匹配不上进未匹配清单，都不静默丢弃。
- **渲染**（`src/render.js`）：用户版不出现文件路径；开发者版给完整 SHA、分类依据、文件增减、证据原文、未验证条目清单与生成说明；注入 `now` 保证同一输入渲染结果稳定。
- **宿主半区**（`src/host.js`）：前缀路由 `GET /dsh-changelog-zh/state`、`POST /generate`、`POST /clear`，以及 `changelog_zh` 工具；两处注册互相独立（任一服务缺失或注册抛错都不影响另一半）；带统计与最近记录；`ctx.effect` 卸载干净。
- **客户端面板**（`src/client.cjs` + `src/client-css.cjs`）：对话视图「变更日志」标签页，用户版／开发者版切换、一键复制、脱敏与会话告警卡片；只使用 `color-mix(in srgb, currentColor …)` 取色，跟随主题。
- **CLI**（`bin/changelog-zh.mjs`）：`--repo/--range/--since/--limit/--merges/--sessions/--titles/--title/--format/--out/--stdout/--json/--no-authors/--no-emails`；退出码 0/2/1。

### 测试

- `test/*.test.mjs` 覆盖脱敏、分类、git 解析与真仓库行为、会话记录、证据判定、渲染、端到端 core、宿主契约、CLI 以及 `lib/` 与 `src/` 的构建一致性；涉及 git 的用例真的建临时仓库。

### 已知边界

- 不联网、不调用模型、不翻译提交信息；未给中文标题的提交原样保留英文主题并计数。
- 只认约定的会话记录格式，不解析 DSH 内部会话库。
- 合并提交默认不进日志。
