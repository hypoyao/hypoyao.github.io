# Game Template Lab

这里存放由模型生成的“模板候选原型”。

推荐流程：

1. 用 `pnpm template:generate tapTarget` 生成一个候选模板。
2. 查看 `template-lab/generated/<templateId>/<timestamp>/manifest.json` 的校验结果。
3. 本地人工试玩和检查代码结构。
4. 只有稳定模板才迁移到 `lib/gameTemplates/`，改成参数化 TypeScript 渲染函数。

目录约定：

- `template-lab/generated/`：模型原始产物和校验报告，不直接用于线上生成链路。
- `lib/gameTemplates/`：后续正式模板库，供游戏生成流程调用。

默认脚本调用阿里云百炼 OpenAI 兼容接口，需要配置：

- `DASHSCOPE_API_KEY` 或 `BAILIAN_API_KEY`
- 可选：`DASHSCOPE_BASE_URL` 或 `BAILIAN_BASE_URL`
- 可选：`BAILIAN_MODEL`

