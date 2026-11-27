# Agent Note: 原生 Skill 导入与版本导出

Status: implemented

## Problem

已验收的任务可以捕获 Skill。用户自写或从同事得到的原生包也需要保存、修订及再分享，同时留住已经开始的任务所用的字节。

## Decision

本机管理沿用 SkillStore 的版本内容、头记录和回退机制。显式导入校验当前版本并记录原工作区来源，后续任务仍由原生 Pi 固定选中版本。导出沿当前目录的实际版本复制并核对完整目录哈希，保留 UTF-8 BOM 与空目录。 [参考实现和验收](../../../../docs/superpowers/plans/2026-11-26-skill-authoring.md)

## Alternatives considered

直接把编辑后的文件指向活动 Skill 可以保持一份副本，但旧任务会读到新内容，命令重放也无法说明使用了哪一版。保存不可变版本可继续沿用任务的原 pin。

## Consequences

测试覆盖过时更新、相同内容重放、导出到已有不同内容的冲突及原始包。DeepSeek 通过终端导入和导出的版本，完成原任务验证。跨设备共享仓库和线上发布另行验证。 [供应商记录](../../../../docs/experiments/2026-11-26-skill-authoring-siliconflow.json)
