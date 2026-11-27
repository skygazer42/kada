# 已验收图表的本机预览

Rakazo 把图表规格和数据分别验证，面向客户端发布结构化图表，由客户端交互显示，PNG 留在工作区。Kada 将线图与柱状图数据保存为 `.chart.json`，用户从已有交付入口打开已验收版本。 [实际图表执行和消息发布](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/workspace-file-tools.ts#L254) · [交付预览回归](https://github.com/elie222/rakazo/blob/e64d73292179/apps/web/e2e/chat/artifact-preview.spec.ts)

- 使用已完成任务的原产物 ID 和验收哈希。生成链接时再次核对字节，页面按验证时的快照绘制。
- 规格包含标题、图表类型、横轴标签和同长度的具名数值序列。交互图及原数据表共用一次验证的内容。用户可以切换显示的序列，并下载当前绘图的 PNG。
- 本机 Pi 执行回合用 `save_chart` 保存符合规格的产物。任务仍通过原交付和验收工具提交图表。
- 本机预览只运行宿主页面的图表代码。有限期链接不向配对设备或第三方渠道自动分享。

## 验收

硅基流动 DeepSeek 从合成 CSV 读取真实列与数值，调用 `save_chart` 生成 `sales.chart.json`，通过原交付验证。源 CSV 字节不变，图例、类别和对应数值经独立检查。Chromium 在 390 × 844 视口切换系列、显示原表格并下载有效 PNG。下载验收使用浏览器正常点击。 [服务与 Pi 回归](../../../test/chart-preview.test.ts) · [实际模型与浏览器记录](../../experiments/2026-11-26-chart-preview-siliconflow.json)
