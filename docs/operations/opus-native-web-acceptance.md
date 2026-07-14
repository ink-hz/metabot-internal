# Claude Code 原生 Web 工具验收

## 原则

- `WebSearch` 和 `WebFetch` 使用 Claude Code 原生实现。
- 不安装 Tavily，不申请额外搜索 API Key，不用搜索 MCP 替代原生工具。
- Skill 可以补充业务方法；MCP 可以连接 Claude Code 原本没有的外部系统，但二者不能冒充原生 Web 工具。
- 能力探针只记录状态，不自动禁用或替换工具。

## 当前基线（2026-07-14）

- Claude Code：`2.1.207`
- 模型：`claude-opus-4-8`
- 普通文本请求：通过
- 原生 WebSearch：`upstream_unsupported`
- 直接证据：当前网关将请求路由到 AWS Bedrock，Bedrock 以 HTTP 400
  拒绝 `web_search_20250305`
- Claude Code 能完成该失败轮并诚实说明联网不可用；MetaBot 必须发送
  这段说明，不能显示 `claude process exited before the turn completed`

## 修复前验收

在 `neo` 开发环境执行：

```bash
cd /Users/neo/Developer/work/metabot-dev
CLAUDE_EXECUTABLE_PATH=/Users/neo/.local/bin/claude npm run probe:opus-native-web
```

探针会实际调用一次 WebSearch 和一次 WebFetch，可能产生模型费用。输出
只包含证据文件路径、状态、HTTP 状态、工具完成次数和耗时。原始提示、
回答、网页、request ID、thinking 和凭据不会写入证据。

当前允许的结果：

```json
{
  "nativeWebSearch": {
    "status": "upstream_unsupported",
    "completedRequests": 0
  }
}
```

随后向 Marketing Bot 发送一个必须联网的问题。验收要求：

1. Bot 返回“当前实时搜索不可用”的正常解释。
2. 飞书不出现红色进程错误。
3. 普通文本、Read、本地知识库、图片和 PDF 能力不受影响。

## 网关修复后验收

网关负责人宣布支持原生 server tool 后，不改 MetaBot 代码、Bot 配置或
工具配置，原样再次执行：

```bash
CLAUDE_EXECUTABLE_PATH=/Users/neo/.local/bin/claude npm run probe:opus-native-web
```

WebSearch 必须变为：

```json
{
  "nativeWebSearch": {
    "status": "available",
    "completedRequests": 1
  }
}
```

再向 Marketing Bot 询问一个当天新闻，要求回答包含实时标题和来源链接。
如果仍是 `upstream_unsupported`，继续由网关负责人处理；不得通过安装
替代搜索服务关闭该问题。

## WebFetch 独立验收

WebFetch 的域名安全校验和 WebSearch 的 Bedrock server-tool 支持不是同一
问题，必须分别判断：

```bash
claude -p '必须调用 WebFetch 读取 https://example.com/，只返回网页标题。' \
  --model claude-opus-4-8 \
  --tools WebFetch \
  --allowedTools WebFetch \
  --output-format json \
  --max-turns 3
```

先用 `https://example.com/`，成功后再测试原来失败的真实网址：

- 安全网址也失败：检查 WebFetch/Claude Code/网关链路。
- 安全网址成功、特定网址失败：记录为 `domain_verification_failed`，按域名安全问题处理。
- 不要把 WebFetch 失败误报为 `web_search_20250305` 不兼容。

## 隐私边界

原生 Web 工具会把搜索词或公开 URL 发送给 Claude Code 当前配置的
网关/提供商。HR Bot 不得把候选人简历、员工记录、凭据或完整私密对话
拼进公开搜索词；该约束写入 HR Skill 和业务指令，不通过替换原生工具实现。
