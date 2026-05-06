# Game Templates

这里是后续真正用于线上生成链路的本地模板库。

不要直接把 `template-lab/generated/` 里的模型输出复制进来上线。推荐先把候选模板抽象成稳定函数：

```ts
export function renderTapTargetGame(config: GameTemplateConfig): GameFiles
```

正式模板应满足：

- 只通过 config 注入主题、角色、颜色、题目和规则。
- 固定 DOM id，方便平台验收。
- 不依赖外部 CDN、远程字体或第三方脚本。
- JS 可静态解析。
- 支持手机和电脑。
- 有最小验收用例。

