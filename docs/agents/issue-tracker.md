# Issue tracker：GitHub（`gardenZzz/cindy`）

本仓的 issue 与 PRD 都记在 **本仓库自己的 GitHub Issues** 里，用 `gh` CLI 操作。

本 clone 同时有 `origin`（fork）和 `upstream` 两个 remote，`gh` **不会**自己选中 fork——
未设默认仓库时它会解析到 `makecindy/cindy`，写操作会打到上游。每个新 clone / worktree
先跑一次：

```sh
gh repo set-default gardenZzz/cindy
```

设过之后命令不需要显式带 `--repo`；没把握时用 `gh repo set-default --view` 确认。

## 与上游的关系

本仓是 `makecindy/cindy` 的 fork。上游的 issue 区是**只读参考**，不在这里管理：需要查
上游 issue 时显式指定 `--repo makecindy/cindy`，不要往上游建 issue，除非用户明确要求。

## 约定

- **建 issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读 issue**：`gh issue view <number> --comments`，需要 label 时一并取。
- **列 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需加 `--label` / `--state` 过滤。
- **评论**：`gh issue comment <number> --body "..."`
- **加／去 label**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

## Issue 标题前缀

沿用全局约定，不叠加前缀（不要写 `[bug][spec] …`）：

| 前缀 | 用途 |
| ---- | ---- |
| `[spec]` | `/to-spec` 发布的父 spec / PRD |
| `T1` / `T2` / … | `/to-tickets` 拆出的子票，按依赖顺序编号 |
| `[bug]` | 缺陷报告：行为损坏、回归、flaky 测试 |

## Pull request 作为需求入口

**PRs as a request surface: no.** _（若本仓要把外部 PR 也纳入 triage 队列，改成 `yes`；`/triage` 读这个开关。）_

设为 `yes` 时，PR 走与 issue 相同的 label 和状态，命令换成 `gh pr` 等价物：

- **读 PR**：`gh pr view <number> --comments`，diff 用 `gh pr diff <number>`。
- **列待 triage 的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR`、`NONE` 的（丢掉 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论／打标／关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一套编号，裸 `#42` 可能是任一种——先 `gh pr view 42`，失败再
回落 `gh issue view 42`。

## skill 说「发布到 issue tracker」时

建一个 GitHub issue。

## skill 说「取相关 ticket」时

跑 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一个 issue，**子票**是它的子 issue。

- **Map**：一个打了 `wayfinder:map` 标签的 issue，正文放 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **子票**：作为 GitHub sub-issue 挂在 map 下（`gh api` 打 sub-issues 端点）。未开启 sub-issues 时，把子票加进 map 正文的 task list，并在子票正文开头写 `Part of #<map>`。标签用 `wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。认领后 assign 给推进者。
- **阻塞**：用 GitHub **原生 issue dependencies**（UI 可见的正式表示）。加边：`gh api --method POST repos/gardenZzz/cindy/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是 blocker 的数字 **database id**（`gh api repos/gardenZzz/cindy/issues/<n> --jq .id`，**不是** `#number` 也不是 `node_id`）。GitHub 会给出 `issue_dependencies_summary.blocked_by`（只算未关闭的 blocker，即实时门）。不可用时回落到子票正文开头的 `Blocked by: #<n>, #<n>` 一行。所有 blocker 关闭即解除阻塞。
- **Frontier 查询**：列出 map 的未关闭子票（`gh issue list --state open`，范围限定在 map 的 sub-issues / task list），剔除有未关闭 blocker（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行里还有 open issue）的和已 assign 的；按 map 里的顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me` —— 本会话的第一个写操作。
- **收尾**：`gh issue comment <n> --body "<answer>"`，再 `gh issue close <n>`，然后把 context 指针（gist + 链接）追加到 map 的 Decisions-so-far。
