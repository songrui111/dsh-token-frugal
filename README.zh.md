# dsh-token-diet（Token 节食）

让长会话不再为「整份文件」和「已经读过的内容」反复付费。

为 DeepSeek Harness 提供两个**延迟加载**工具：

| 工具 | 作用 |
|---|---|
| `read_range` | **只读你需要的几行**：按行号窗口读、按符号找出所有出现位置并带上下文、或只列结构大纲。输出有硬上限。 |
| `tool_catalog` | 列出本会话真正能调用的工具（一行一个）。因为工具一旦延迟，模型必须能自己重新发现它们。 |

## 为什么

每次工具往返都会把整段对话重新发一遍。为回答「`saveSelection` 定义在哪」而整份读一个 600 行文件，会把约 3,000 token **永久**写进上下文，之后每一轮都要再付一次。

`read_range` 的 `symbol` 模式只用命中行来回答同一个问题。

## 实测（离线，对本仓库源码）

| 文件 | 整份读 | `symbol` 模式 | 节省 |
|---|---:|---:|---:|
| `dsh-token-diet/index.js`（约 330 行） | 2,938 tok | 237 tok | **91.9%** |
| `probe/price-tool-inventory.mjs` | 734 tok | 349 tok | 52.5% |
| `probe/deferred-loading-experiment.mjs` | 773 tok | 471 tok | 39.1% |

token 数为对 Harness 计费规则的确定性近似（中文约 1.7 字/token，代码约 3.8 字符/token），用于横向比较，不等于账单数字。

**节省比例随文件变大而上升。** 小脚本省得少，因为每次调用的头部与上下文窗口有固定下限。

## 安装

```bash
dsh plugin install /path/to/dsh-token-diet
```

行 id 为 `token-diet`；在你自己的 `cordis.patch.yml` 里覆盖 `config` 即可在升级后保留配置。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `guide` | `true` | 注入「优先用 `read_range`、不要整份读」的系统提示词段落。**这才是让节省真正发生的关键**：没有它，工具虽然存在，模型仍会整份读文件。 |
| `exposeCatalog` | `true` | 是否注册 `tool_catalog`。设为 `false` 则保持工具清单原样不变。 |

### 关于引导段落

- 每轮固定开销约 **162 token**（612 字符）。这就是「建议」的代价，所以 `guide` 做成开关：请在你的真实工作量上两种都量一次。
- **仅当 `read_range` 对当前渲染作用域可见时**才渲染。预设、权限限制或注册失败都不会留下「让模型去调一个已经不存在的工具」的指引。
- 段落排序值为 `210`，落在插件引导带（`150` ssh、`152` docker、`200` task board）内，且不与它们冲突。

## 诚实的边界

- **它不会压缩其他插件的工具 schema。** 目前没有服务或事件能把别的插件的 `ToolSchema` 标记为 `deferLoading`，只有本插件自己注册的工具会被延迟。因此在插件很多的 profile 上，每轮固定的 schema 开销依然存在（在一个实测 profile 中，169 个工具共约 5.6 万 token）。
- **`symbol` 模式是文本匹配，不是语义匹配。** 搜 `save` 也会命中 `savesSelection`；不确定标识符时先用 `mode: outline` 看结构。
- **原版 `read` 未被改动。** 上游文件工具照常可用，所以模型总能回退——这也意味着**只有模型真的选用 `read_range` 时才有节省**。

## 许可

MIT。图标为本插件原创。
