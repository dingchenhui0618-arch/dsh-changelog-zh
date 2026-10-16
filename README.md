# dsh-changelog-zh

从真实 git 历史生成**两份中文变更日志**：

- **用户版（短）**——一段可以直接贴进群公告或 Release 正文的中文说明；
- **开发者版（长）**——每条提交带完整 SHA、分类依据、文件增减、验证证据原文。

两份里的**每一条都带 commit SHA 和「已验证／未验证」标记**。

这个工具的三个承诺，也是它唯一值得存在的理由：

1. **只说历史里有的事。** 分类靠约定式提交前缀和一张小关键词表，识别不出就写「未分类」，绝不猜。
2. **「已验证」必须有可引用的证据。** 四类证据之外，一律标「未验证」，并写清缺的是哪一类。只有一句 `verified: true` 而没有证据的，同样算未验证。
3. **不翻译提交信息。** 你没写中文标题的提交，就原样保留英文主题，并明确告诉你「有 N 条没有中文标题」——不会给你一段看起来很像中文、实际是模型编的文案。

当前版本 **0.1.0**。

---

## 它长什么样

下面是这个工具在本文档末尾描述的演示仓库上的**真实输出**（原文粘贴，未手工润色）：

```console
$ node bin/changelog-zh.mjs --repo tmp/demo-repo \
    --sessions tmp/demo-sessions.jsonl --title v1.1.0 \
    --out tmp/demo-out --no-emails --stdout --format user
```

```markdown
# v1.1.0

2026-10-16 · 共 6 条变更：3 条已验证、3 条未验证。

## 破坏性变更

- ⚠ 换掉返回结构（`1993535`，未验证）

## 新功能

- 支持把结果导出成 Markdown（`182d11c`，已验证）

## 修复

- 修掉导出时的编码问题（`46378b4`，已验证）

## 性能

- 导出时少做一次全量拷贝（`83fb0b5`，未验证）

## 重构

- 拆出渲染层（`4939351`，未验证）

## 未分类

- update the deployment notes（`af2971a`，已验证）

> 范围：v1.0.0..HEAD · 共 6 条变更
> 「未验证」只表示提交历史里没有可引用的验证证据，不代表这条改动有问题。
> 判定依据：提交信息或 git notes 里的验证 trailer（`已验证:` / `Verified:` / `测试:` …），或会话记录里退出码为 0 的验证命令。完整规则见开发者版。
> 其中 1 条没有中文标题，原样保留了提交主题（本工具不翻译提交信息）。
> 生成于 2026-10-16T04:06:07.769Z · dsh-changelog-zh@0.1.0 · 数据来源：git log
```

开发者版里同一条「性能」改动是这么写的（节选）——注意它没有把「匹配到会话记录」当成验证通过：

```markdown
### 4. 导出时少做一次全量拷贝（`83fb0b5`，未验证）

- 提交：`83fb0b584d05a391cd8f8deba0e0c5a6c7665bc4`
- 类型：性能（分类依据：提交前缀 perf）
- 破坏性：否
- 作者：林可
- 提交时间：2026-10-10 10:00
- 文件（1 个，+1 −0）：
  - `src/fast.js` +1 −0
- 提交主题（原文）：perf: 导出时少做一次全量拷贝
- 验证：未验证 —— 匹配到 1 条会话记录，但里面没有退出码为 0 的验证命令，也没有 failed=0 且 passed>0 的测试计数
```

以及「提交信息 + git notes 两处都有证据，就把两句原文都抄下来」：

```markdown
- 验证：已验证 —— 提交信息 trailer「测试：node --test，退出码 0」
- 验证：已验证 —— git notes「已验证：node --test 46 passed」
```

---

## 安装与用法

### 作为 DSH 插件（宿主路由 + 会话面板 + 工具）

本插件是零依赖的纯 JS 包，把仓库挂进 DSH 的插件目录即可（`dsh.bundle.patch` + `dsh.client` 已声明）：

```yaml
# cordis.patch.yml（本仓库自带）
- insert:
    - id: dsh-changelog-zh
      name: dsh-changelog-zh
```

装上以后有三个入口：

- **会话面板**：对话视图里的「变更日志」标签页，填仓库/范围/会话记录即可生成，可一键复制；
- **HTTP 路由**：`GET /dsh-changelog-zh/state`、`POST /dsh-changelog-zh/generate`、`POST /dsh-changelog-zh/clear`；
- **工具**：`changelog_zh`，参数 `{ repo, range, since, limit, includeMerges, sessions, format }`，`format` 取 `user` / `dev` / `both`。

插件配置（都可选）：

```jsonc
{
  "roots": [],            // 路径白名单；非空时只允许生成这些目录下的仓库
  "defaultRepo": "",      // 请求没给仓库时用哪个
  "defaultRange": "",     // 默认范围，如 "v1.0.0..HEAD"
  "sessionsPath": "",     // 会话记录文件
  "titlesPath": "",       // 中文标题映射文件
  "maxCommits": 300       // 单次最多读多少条提交
}
```

### 作为命令行工具

```console
$ node bin/changelog-zh.mjs --repo D:\Projects\某项目 --title v1.1.0
已写入 D:\Projects\某项目\CHANGELOG-user.md  —— 用户版（短）
已写入 D:\Projects\某项目\CHANGELOG-dev.md  —— 开发者版（长）
范围 v1.0.0..HEAD · 6 条提交 · 已验证 3 · 未验证 3 · 已隐去 0 处 · 会话记录匹配 2 条
```

全部参数：

| 参数 | 说明 |
| --- | --- |
| `--repo <路径>` | 仓库路径，默认当前目录 |
| `--range <范围>` | 如 `v1.0.0..HEAD`、`HEAD~5..HEAD`；不写则自动（见下） |
| `--since <日期>` | 只取该日期之后的提交，如 `2026-10-01`、`"2026-10-01 09:00"` |
| `--limit <条数>` | 最多读多少条提交（默认 300，上限 5000） |
| `--merges` | 把合并提交也算进来（默认不含） |
| `--sessions <文件>` | 叠加会话记录（格式见下） |
| `--titles <文件>` | 中文标题映射 JSON，形如 `{"<完整或短 sha>": "中文标题"}` |
| `--title <标题>` | 覆盖两份文案的标题 |
| `--format user\|dev\|both` | 只产出其中一版（默认 `both`） |
| `--out <目录>` | 输出目录，默认仓库根目录 |
| `--stdout` | 同时打印到标准输出 |
| `--json` | 把完整报告打成 JSON 到标准输出（不写文件） |
| `--no-authors` / `--no-emails` | 开发者版里隐去作者／邮箱 |
| `-h` / `-v` | 用法 / 版本 |

退出码：`0` 成功、`2` 参数错误、`1` 生成失败（错误码写在 stderr，如 `[ENOTREPO]`）。

**自动范围**：没有标签时取最近提交；有标签时取 `最近标签..HEAD`；如果最新标签已经在 HEAD 上（刚打完标签就要写 Release notes 的典型场景），自动回退到**上一个**标签，避免把这次已发布的提交再写一遍。范围是怎么定的，开发者版会写在「范围」那一行里。

---

## 「已验证／未验证」到底怎么判

只有下面四类**可引用证据**存在时，才会标「已验证」：

| # | 证据 | 例子 | 抄进文案的内容 |
| --- | --- | --- | --- |
| 1 | 提交信息里的验证 trailer | `Verified: node --test → 46 passed` | 原句 |
| 2 | git notes 里的验证 trailer | `git notes add -m "测试：node --test，退出码 0"` | 原句 |
| 3 | 会话记录里退出码为 0 的验证命令 | `{"command":"node --test","exitCode":0}` | 命令 + 退出码 |
| 4 | 会话记录里 `failed=0` 且 `passed>0` 的测试计数 | `{"tests":{"passed":46,"failed":0}}` | 计数 |

trailer 的键名认这些（大小写不敏感、中英都行）：`verified` / `verified-by` / `verify` / `verification` / `tested` / `tested-by` / `test` / `tests` / `evidence` / `check` / `checked` / `已验证` / `验证` / `自测` / `测试` / `测试结果` / `测试通过` / `证据`。写成 `**已验证**：…` 这种加粗形式也认得。

两条**从严**的例外，请特别注意：

- **通过与失败并存 ⇒ 未验证。** 如果同一提交既有一句 `Verified:`，又有一条退出码非 0 的测试记录，本工具按「未验证」处理，并在文案里写明「存在失败的验证证据」。宁可保守。
- **声称 ≠ 证据。** 会话记录里只有 `"verified": true`、却没给命令/退出码/计数的，依旧标「未验证」，理由写成「声称已验证但没有证据」。

反过来，「未验证」**不代表改动有问题**——它只表示提交历史里没留下能引用的证据。这条也会印在每一份用户版文案的页脚里，免得被读者误读。

本工具**不会**从「改了测试文件」「diff 很大」「提交信息写得很详细」这类形状去推断验证结论。

---

## 脱敏

渲染之前先脱敏，命中即替换为 `<已隐去:类型>`，并在文案里报出命中数量：

GitHub token（`ghp_` / `gho_` / `ghs_` / `ghu_` / `ghr_` / `github_pat_`）、`sk-` 类 API key、Slack token、AWS access key id、JWT、`Bearer …`、私钥块（`-----BEGIN … PRIVATE KEY-----`）、带密码的连接串、`password: xxx` / `token: xxx` 这类赋值、以及本机用户路径（`C:\Users\…` 与 `C:/Users/…` 两种写法）。仓库根目录与 origin 地址在进入报告前也会过一遍脱敏。

一个真实例子：一条提交信息里写了 `token ghp_***`，用户版和开发者版里都只会出现 `<已隐去:github-token>`，页脚写「已在生成时隐去 1 处疑似凭据或本机用户路径」。

---

## 会话记录格式

这是一个**约定的摘要文件**，不是 DSH 内部会话库的格式。支持 JSON 数组、单个 JSON 对象，或 JSONL（`#` 开头是注释，空行忽略）：

```jsonl
{"commit":"182d11c","title":"支持把结果导出成 Markdown","commands":[{"command":"node --test","exitCode":0},{"command":"npm run lint"}],"tests":{"passed":46,"failed":0}}
{"commit":"af2971a","verification":{"command":"node --test","exitCode":0,"evidence":"46 passed"}}
```

- `commit`：完整 sha、唯一前缀（≥4 位）或短 sha 都能匹配；**有歧义就进「歧义清单」，不猜**；
- 匹配不上的记录进「未匹配清单」，开发者版会列出记录与原因；
- `title` / `titleZh`（也认 `summary`）用作中文标题来源，优先级低于 `--titles` 映射、高于提交 trailer；

匹配上**不等于**已验证：记录里必须有上面第 3、4 类证据。

---

## 它不做什么

- **不联网**，不调用任何模型 API；除 `git` 只读命令外不执行别的进程；**不写任何文件**（CLI 的 `--out` 除外）。
- **不改仓库**：不发提交、不打标签、不写 notes。
- **不翻译、不推断**（见上文三个承诺）。
- **不解析 DSH 内部会话库**：会话记录只认上面这个约定格式。
- 合并提交默认不进日志（要就加 `--merges`）；空提交与合并提交在开发者版里会写「文件：无（可能是空提交或合并提交）」，不会假装它有改动。

---

## 参考了什么、有什么不同

本工程是**独立实现**，没有 fork、没有克隆任何人的仓库、没有拷贝任何第三方代码。

**骨架**照的是本机另一个自己写的 DSH 插件工程 `dsh-warden`（同一作者）：零依赖 `scripts/build.mjs`（`src/*.js` → `lib/`）、`cordis.patch.yml` 描述片段、宿主半区 + 客户端半区 + `test/*.test.mjs` 的布局、`scripts/wrap-client.mjs` 的 `window.__ModuleLoader__` 包装方式、`.gitattributes` 的 LF 约定。差异在于职责完全相反：warden 是在工具调用**之前**拦一层，本插件是读 git 历史**之后**产出一段文案；因此本插件没有 `rules.js`/`classify.js` 那套判定流水线，而是 `git → classify → evidence → redact → render` 这条只读链路，并且附带一个可独立运行的 CLI。

**生态定位**（下面两条事实来自 GitHub API 返回的仓库公开描述，我没有读它们的源码，本工程不含它们任何代码）：

- [`7dgroup-ai/dsh-skill-7d-git-commit`](https://github.com/7dgroup-ai/dsh-skill-7d-git-commit)：公开描述是「在生成任何 `git commit` 提交信息前，自动按 7DGroup 项目提交规范进行校验」。它管的是**提交信息的规范**（写之前）。
- [`andyfan1094/dsh-github`](https://github.com/andyfan1094/dsh-github)：公开描述是「GitHub authentication and local Git workflow plugin for the dsh web GUI」，是账号认证与本地 Git 工作流面板。

两者都不产出「从真实变更生成一份敢公开的中文文案」。本插件补的就是这一环。需要说明的是，这个「生态里没人做」的判断来自上面两条公开描述，不是穷尽调研——如果你知道已经有同类插件，欢迎在 issue 里告诉我。

同样地，本工程**故意没有** `screenshots.json`、没有伪造的面板截图：作者没有把插件装进自己的 DSH 配置里跑过面板渲染，所以不给不存在的截图。面板行为由 `test/host.test.mjs` 里的宿主契约测试覆盖（路由前缀、状态码、工具 schema、卸载），而不是靠图片证明。

---

## 开发

```console
$ node scripts/build.mjs          # src/*.js -> lib/（host.js -> index.js），并内联客户端 CSS
$ node --test test/*.test.mjs     # 全部测试
```

- 零运行时依赖，`devDependencies` 为空；只需要 Node ≥ 22 与 `git`。
- `lib/` 是入库的构建产物，`test/build.test.mjs` 会逐字节比对 `lib/` 与 `src/`，改了源码忘了构建会直接红。
- 测试里凡是涉及 git 的都**真的建临时仓库**（`test/helpers/repo.mjs`），不 mock git；本机没有 `git` 时这些用例自动 skip 并说明原因。
- CI（`.github/workflows/ci.yml`）在 Node 22 / 24 上跑构建一致性 + 全部测试 + CLI 冒烟。

## License

MIT，见 [LICENSE](./LICENSE)。变更历史见 [CHANGELOG.md](./CHANGELOG.md)。
