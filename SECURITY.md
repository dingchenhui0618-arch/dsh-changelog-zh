# 安全模型 / Security model

这份文档说明 **dsh-changelog-zh** 信任什么、读哪些文件、跑哪些命令、会把什么内容写进公开文案。
内容从实现（`src/core.js`、`src/git.js`、`src/sessions.js`、`src/redact.js`、`src/host.js`）读出来；
**文档与代码不一致时以代码为准。**

> 一句话：它是一只**只读的 git 眼睛**。它把 commit 元数据、git notes 和一份显式的会话记录
> 变成中文变更日志；它不写文件、不联网、不跑用户命令，唯一的子进程是只读的 `git`。
> 真正的风险在**输出**：变更日志是拿去公开发布的文字，而提交信息里可能混着不该公开的东西。

## 信任边界

插件跑在 DSH 宿主进程里。`apply(ctx)` 里注册两处，都**软读**服务，互不依赖：

| 表面 | 怎么注册 | 鉴权 |
| --- | --- | --- |
| `/dsh-changelog-zh` 前缀路由（`GET /state`、`POST /generate`、`POST /clear`） | `ctx.get('webServer')`，没有就跳过 | **无**。没有 token、没有 CSRF 校验，边界依赖 DSH web server 的监听范围 |
| `changelog_zh` agent 工具 | `ctx.get('tools')`，没有就跳过 | 由 DSH 的工具权限模型决定；插件自己不额外校验 |

**视为不可信输入**：

- `POST /generate` 的请求体：`repo`、`range`、`since`、`limit`、`sessions`、`includeMerges`；
- `changelog_zh` 工具的参数（模型给的，形状与上面相同）；
- 被分析仓库的提交主题、正文、git notes、作者名与邮箱；
- 会话记录文件 / 文本（JSON 或 JSONL）里的任意字符串。

## 读什么

| 读取项 | 路径来源 | 约束 |
| --- | --- | --- |
| git 元数据与文件增减 | `repo`（请求体 / 插件配置 `defaultRepo` / `process.cwd()`） | 配置了 `roots` 时必须落在白名单内（`EOUTSIDE` → HTTP 403），否则 `resolve()` 后直接读 |
| 会话记录 | 请求体 `sessions` 或配置 `sessionsPath` | **没有目录白名单**；只要进程读得到就解析，坏行只产生 warning |
| 中文标题映射 | 仅插件配置 `titlesPath` | 请求体无法指定；JSON 解析失败报 `ETITLES` |

它**不读** `node_modules`、DSH 的私有会话库（`sessions.js` 顶部写明了这是刻意不做的依赖），
也不读任何凭据文件。

## 跑什么命令

`src/git.js` 统一用 `execFileSync('git', argv)`，**从不过 shell**：仓库路径、范围、notes ref
都是 argv 里的独立元素。具体命令只有只读查询：
`rev-parse`、`log`、`numstat`、`for-each-ref`、`describe`、`remote get-url`、`status --porcelain`。

- 超时 **30s**，`maxBuffer` 64 MiB，`stdio: ['ignore','pipe','pipe']`；
- rev / 范围先过 `sanitizeRev()`：拒绝空值、以 `-` 开头（挡住 `--output=<file>` 这类
  会被 git 当成写文件选项的注入）、空白、NUL，以及白名单字符以外的内容；随后 `validateRange()`
  用 `rev-parse --verify` 确认每个 rev 真实存在；
- `--since` 的值以 `--since=<value>` 附加，只拦控制字符；
- `git` 可执行文件来自 `PATH`，插件不指定绝对路径，也不改环境变量。

## 写什么

**宿主半区（路由与工具）不写任何文件。** `core.js` 只 import 了 `readFileSync`，没有
`writeFile` / `mkdir` / 子进程写操作。

**CLI 半区**（`bin/changelog-zh.mjs`）在给了 `--out` 时写 Markdown 文件：`mkdirSync` +
`writeFileSync`，覆盖同名文件，不备份；这是命令行用户显式指定的目录，不是 HTTP 请求能触发的路径。

## 输出前的脱敏（不是保证）

`src/redact.js` 在渲染前对提交主题/正文/notes/证据文本做模式化替换，命中的位置替换成
`<已隐去:类型>` 并计数，覆盖：私钥块、GitHub token / PAT、Slack token、AWS key id、
`sk-` API key、JWT、Bearer、带口令的连接串、`password=` 这类赋值、以及
`C:\Users\<name>` / `/home/<name>` 两种家目录写法。

它是**可枚举的黑名单**，不是秘密检测器：

- 只认这些形状；自造格式的凭据、短口令、图片里的密钥都可能漏过；
- 作者邮箱**不脱敏**，会原样进入开发者版（CLI 的 `--no-emails` 可关掉，HTTP/工具路径没有这个开关）；
- 命中后只给出数量与类型，不给出原文——这一点由 `test/redact.test.mjs` 钉住。

## 已知限制

1. **能读任意 git 仓库**（未配置 `roots` 时）：模型可以指定 `repo`，读到宿主机上任何
   进程有权限读的仓库的提交历史。这是「工具」的正常能力，但也意味着提交信息里的
   内部链接、客户名、未公开路线图会被送进模型上下文。
2. **`sessions` 路径没有白名单**：请求体可以让它读任意可读文件并尝试按 JSON/JSONL 解析，
   解析失败只返回 warning。内容不会原样回显，但报错文本里可能带文件路径。
3. **无鉴权、无 CSRF 校验**：任何能访问 DSH web server 的页面都能触发一次生成（耗 CPU、
   读 git）。边界依赖宿主只监听回环地址。
4. **大仓库的读取成本**：默认上限 300 条提交、硬上限 5000；仍可能让 `git log` 跑满 30s
   超时并返回错误。
5. **脱敏漏网是已知风险**，见上一节；把结果直接贴到公开 Release 前应自己再过一眼。
6. **`/state` 会回显配置**：`roots`、`defaultRepo`、`sessionsPath`、`titlesPath`、
   `cwd` 以及最近 40 条生成记录（仓库根路径、条数、耗时），不含提交正文。

## 明确不算漏洞

- 读到仓库的作者名 / 邮箱 / 提交正文（这就是它的输入）；
- 生成结果里出现 commit SHA、文件名、提交主题（这是「每条都能指回历史」的设计）；
- 模型通过 `changelog_zh` 工具指定一个仓库路径（配置 `roots` 就是为了收紧它）；
- 提交信息里本来就写了密钥、而它没被自定义格式规则命中（见「已知限制 5」，脱敏是尽力而为）；
- CLI 用 `--out` 覆盖同名 Markdown 文件（显式指定的输出目录）。

## 报告漏洞

用 GitHub 的私密渠道：<https://github.com/dingchenhui0618-arch/dsh-changelog-zh/security/advisories/new>

个人项目，**不承诺响应时限**；修完会写进 `CHANGELOG.md`。请不要把仍在生效的问题先发到公开 issue。

## 支持范围

只维护最新发布版（当前 `0.1.0`，见 `package.json`）。旧版本不回补。
