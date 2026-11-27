# Windows 本机凭据存储

Windows 新写入的应用凭据使用认证加密。数据密钥由 Windows DPAPI 当前用户保护，凭据值和写入回执沿原文件一次原子保存。打开旧明文文件仍可查看元数据和使用原凭据。首次成功修改时写入加密格式。损坏的文件保留原字节并返回错误。

Rakazo 的凭据存储在相同业务入口读取旧格式，并按当前加密密钥写入。Kada 使用 Windows 自带的用户保护和 Node.js 加密原语，不增加外部服务。加密记录的恢复需要可解开密钥的 Windows 用户配置。其他系统采用原有本机文件保护。 [Rakazo 值读取和加密分支](https://github.com/elie222/rakazo/blob/e64d73292179/packages/adapters/src/secrets/vault/vault-values.ts#L52) · [Windows DPAPI](https://learn.microsoft.com/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)

24 项回归覆盖旧文件读取、写入迁移、同一 Windows 用户重开、原请求回执、密文校验和原文件保留，也覆盖 SIGKILL 后的原凭据回执。 [回归](../../../test/application-credentials.test.ts) · [强杀恢复](../../../test/credential-recovery.test.ts)

硅基流动的 DeepSeek-V3.2 使用合成凭据完成受保护输入、加密保存、重启和一次授权 API 调用。验证记录确认凭据值未进入模型请求或 Pi 会话。共 5 次模型请求、42,523 token。 [真实模型记录](../../experiments/2026-11-26-windows-credentials-siliconflow.json)
