# Agent Note: Windows 绑定本机应用凭据的数据密钥

Status: implemented

## Problem

本机应用凭据早先使用限权的文件，Windows 侧仍能从复制出的文件看到值和记录。用户还需要在更新后继续读取旧数据和原回执。

## Decision

Windows 用 AES-256-GCM 密封整份凭据记录，以 DPAPI 当前用户保护数据密钥。新的随机 nonce 随每次原子写入保存。启动读取和变更沿现有文件锁，旧格式由同一读取路径处理。DPAPI 帮助进程经标准输入输出接收密钥。 [旧服务决定](2026-11-23-personal-assistant-services.md) · [实现与验收](../../../../docs/superpowers/plans/2026-11-26-windows-application-credential-protection.md)

## Alternatives considered

直接用 DPAPI 密封整份文件可少一层加密格式，每次变更都需要从帮助进程传输整份文件。只封装数据密钥让原进程缓存解封结果，并用同一套 Node.js 原语读写记录。

## Consequences

旧格式在首次成功写入时迁移。解封或认证校验失败时原文件保留。备份恢复取决于 Windows 用户配置，类 Unix 平台仍需自己的密钥库接入。
