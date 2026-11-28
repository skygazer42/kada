# 普通聊天管理项目 Skill

Rakazo 的 `skill_create`、`skill_update`、`skill_delete` 和 `skill_read` 直接服务于可复用的项目方法。Kada 已有 Pi Skill 目录、版本快照、启用状态和固定版本，本次把这些能力接到普通本地聊天。 [Rakazo Skill 工具定义](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/tools/builtin-fleet.tool-definition.ts#L45) · [Kada SkillStore](../../../src/skills.ts)

- 普通本地聊天可读取项目目录、读取完整 `SKILL.md`、创建、更新、停用和删除项目创建的 Skill。工具带项目边界和版本检查，修改不会创建 Goal、任务或执行。
- 创建的 Skill 放在项目的 `.kada/skills/<name>/SKILL.md`，复用原生 Pi 解析和现有 SkillStore 目录。更新和删除要求当前目录版本，冲突时保留用户原文件。
- 已经固定到任务的 Skill 继续使用原快照。停用影响后续任务，恢复可重新启用。旧聊天元数据没有 Skill 管理工具。
- 回归验证普通聊天全流程、版本冲突、重启后目录和现有 Skill 固定流程。
