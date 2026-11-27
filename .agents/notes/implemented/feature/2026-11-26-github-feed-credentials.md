# Agent Note: GitHub 轮询读取显式配置凭据

Status: implemented

## Problem

GitHub 公开事件流的匿名额度可能在计划轮询前用完，CLI 与后台需共享相同的连接约定和游标。

## Decision

CLI 与后台使用同一个 `githubIssueTokenEnv` 设置。每次同步解析当前环境值，授权头只从固定 API 路径发送并拒绝重定向。持久游标继续绑定原规则和仓库。 [实现和验收](../../../../docs/superpowers/plans/2026-11-25-github-webhook.md)

## Alternatives considered

自动采用宿主已有的任意 GitHub 凭据可以减少配置，但可能选到别的应用授权。显式环境变量名称让同步范围由本机配置指定。

## Consequences

真实公开 feed 使用正常 Node 请求验收。授权头、缺失凭据、轮换和限流使用合成回归。 [真实事件记录](../../../../docs/experiments/2026-11-26-github-public-feed.json)
