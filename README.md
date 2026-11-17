# Prompt Guard

社区维护的 **Antigravity / Cloud Code 违禁词库**，以及把它自动应用到网关请求上的 **magpie 插件**。两者在同一个仓库里：词库是一份 JSON，插件从它生成规则。

English: Google Cloud Code answers a system prompt that reads like a third-party agent with a quota-shaped 429. This repository keeps the fingerprints, the rewordings that pass, and a magpie plugin that applies them at the gateway.

> Google Cloud Code 会对「读起来像第三方 agent 的 system 提示」返回一个**配额形状的 429**（`RESOURCE_EXHAUSTED` + 没有意义的 `retry-after`）。它匹配的是字面指纹，不是语义——同一句话改一个标点就能通过。本仓库收集这些指纹以及不改变含义的改写方式。

| 文件 | 作用 |
|---|---|
| [`phrases.json`](phrases.json) | **唯一的真相**：社区维护的指纹与改写 |
| `prompt-guard.middleware.js` | magpie 中间件，按 provider 改写系统提示 |
| `page/` | 插件页面：选 provider、编辑规则、试运行、同步词库 |
| `scripts/sync-rules.mjs` | 从 `phrases.json` 生成上面两处规则列表 |

## 为什么需要它

- 现象：agent 正常发请求，却立刻收到 `429 RESOURCE_EXHAUSTED`，`retry-after` 几十秒到两分钟，换 agent、换模型都一样。
- 机制：上游检查 **system 提示**（不检查用户消息）。命中时返回配额错误而不是 400，用来掩盖过滤本身。
- 证据：omp 的系统提示第一行 `You are omp's trusted coding assistant.` 单独发送会被拒；**去掉句号**就通过。Claude Code 的 `<pasted_content>` 那段两句话，拆成两半各自通过，合起来被拒。
- Antigravity 官方客户端不受影响——它发的是自己的 system 提示，不含这些指纹。

## 词库 `phrases.json`

```json
{
  "version": 1,
  "updated": "2026-11-17",
  "phrases": [
    {
      "find": "上游会拒绝的原文",
      "replace": "同义但不含指纹的改写",
      "mode": "text",
      "note": "为什么是这句、证据是什么"
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `find` | 必填。按**忽略大小写 + 空白等价**匹配（原文换行、多个空格也能命中）；`mode: "regex"` 时按正则解释 |
| `replace` | 必填。纯文本，`$1` / `$&` 不会被展开 |
| `mode` | `text`（默认）或 `regex` |
| `note` | 可选。写清楚是哪句话、怎么验证的 |

**排序有意义**：长的写在前面，否则短规则会先吃掉长规则的文本。`scripts/sync-rules.mjs` 会拒绝重复的 `find` 和空的 `replace`。

### 贡献规则

1. 在 `phrases.json` 里加一条，`note` 里写最小复现：模型、system 片段、以及"原文 429 / 改写后 200"的对照。
2. 跑 `bun scripts/sync-rules.mjs && bun test`。
3. 提 PR。

两条底线：

- **改写，不要删除**。模型仍然需要读到那句话的含义，只是不要留下指纹。
- **不要泛化**。`find` 写成 `You are .* assistant` 这类宽泛匹配会误伤正常提示，PR 不会合并。

## 安装插件

```bash
magpie plugin add github:ygq-future/magpie-prompt-guard
```

装好后打开 **Plugins › Prompt Guard**：

1. 点 `Provider` 勾选要生效的 provider（例如 `CLIProxyAPI`）；不选则原样放行。
2. 规则默认来自本仓库发布时的 `phrases.json` 快照。
3. 想换成别的词库版本，点工具栏的 **导入词库**，选择从本仓库下载的 `phrases.json`。

只改**系统提示**：用户消息、助手消息、工具结果永远原样发送。

## 词库怎么更新

magpie 给插件页面的 CSP 是

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'
```

`connect-src 'self'` 意味着**页面没有任何联网能力**——它既不直连 GitHub，也不走 magpie 的全局代理；网关中间件（moejs）同样没有网络、文件和定时器。所以不存在"打开页面就自动拉取"这种机制，更新走两条路：

| 方式 | 怎么触发 | 生效范围 |
|---|---|---|
| 导入文件 | 页面 **导入词库** → 选择 `phrases.json` | 只影响这台机器的插件配置 |
| 插件更新 | `magpie plugin update` | 换成仓库最新快照（随发版） |

## 开发

```bash
bun scripts/sync-rules.mjs        # phrases.json → page/rules.js + middleware 的 BUILTIN_RULES
bun scripts/sync-rules.mjs --check # CI 用：不同步就退出 1
bun test                          # 25 个测试：匹配、协议、内置列表一致性
bunx tsc -p jsconfig.json         # 页面脚本的类型检查
```

改了 `phrases.json` 一定要跑 `sync-rules.mjs`，否则测试会失败（它比对生成结果）。

## 风险

- 这类改写**可能违反上游服务条款**，有封号风险，只用在能承受损失的账号上。
- 指纹是**逐字节**匹配的，上游一改提示词、或新增指纹，规则就需要重新定位。这个仓库的价值就在于把这件事分摊给所有人。
- 规则只作用于你勾选的 provider，其他 provider 的请求不会被改动。

## 许可

MIT
