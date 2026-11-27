# 本机 Skill 导入、修订和导出

Rakazo 通过原工具校验 Skill 名称及完整 SKILL.md，检查重复和来源再保存。OpenMausBot 的管理调用区分创建、更新和导入。Kada 从 owner 明确选择的原工作区目录读取原生 Pi Skill，沿用本机 managed 目录、哈希版本和回退入口。 [Rakazo 创建与查重](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/skill-tools.ts#L272) · [OpenMausBot 管理入口](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/drivers/agents-call.ts#L903)

- 初次导入保存当前原生包。修改已有 Skill 使用可见的当前版本。重发原内容得到原版本，原有回退结果可保留。
- 导入沿现有本机 managed 目录。项目或发现的同名原生 Skill 保留优先级。导入来源和导出目的地都在选择的工作区。
- 用户从当前工作区的可见目录选中一个版本，复制完整原生包到明确选择的新位置。重复导出相同字节复用原位置，文件、UTF-8 BOM 和空目录保留。
- 自动化验证原生 Pi 固定版本、更新冲突、后续版本和原内容重放，及导出原文件。 [测试](../../../test/skill-authoring.test.ts)

硅基流动 DeepSeek 从单独的执行工作区读取明确固定的导入版本，写出并验收原结果。CLI 导入及导出逐字核对，同一 Skill 的原包与导出包留在夹具的来源工作区。 [实际模型记录](../../experiments/2026-11-26-skill-authoring-siliconflow.json)
