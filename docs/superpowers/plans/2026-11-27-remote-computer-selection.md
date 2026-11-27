# 在手机 Web 选择执行电脑

手机在已经配对的 Kada 入口列出本机配置的电脑。用户选中电脑后进入该电脑的 HTTPS 门户，并用该电脑自己的配对凭据访问。再次选回原电脑时，打开原会话、任务及浏览器中保存的草稿。电脑清单以本机配置为准，由当前配对会话读取。

OpenMausBot 在选执行位置时保留用户指定的位置。Codync 的设备列表在用户点击后才请求连接。Kada 复用各电脑已有的配对、任务收据和凭据存储。安装的 Pi durable 1.4.0 按原 conversation 保存会话与任务，切换入口仅改变后续请求到达的主机。 [OpenMausBot 执行位置选择](https://github.com/milind-soni/OpenMausBot/blob/3aec210054cd/server/computer-selection.ts#L23) · [Codync 设备选择](https://github.com/leepokai/Codync/blob/9dae3e2bec9b/apps/ios/Views/ChooseComputerView.swift#L7)

- 每台主机用 `remoteOrigin` 绑定自己的代理地址。可选的 `remoteComputers` 列出名称和 HTTPS origin。同一清单可放在多台主机上。门户用当前 origin 匹配本机名称。
- 服务器允许其他站点顶层打开公开门户文档。API、脚本和 Service Worker 仍沿用原访问边界。电脑链接只有目标门户 URL，浏览器按 origin 保存配对凭据和草稿。
- 切换前等待当前聊天草稿写入。发送期间或还有待发送文件时，页面显示具体状态并留在原电脑，以保留该次提交和文件选择。
- 自动化验收用两个独立数据目录和端口，检查跨站导航、配对隔离、原任务和草稿恢复。真实局域网的两台电脑需要各自部署代理并配对后验收。

Chromium 的 390 × 844 视口连接本机的两个独立 HTTPS 代理和 daemon 进程。Office 首次进入时要求独立配对。强制终止并重启 Office 进程后，保留原会话、任务及待答。浏览器切回 Studio 时保留未发送草稿，再切回 Office 答复原问题并下载报告，下载内容与该任务的原产物逐字节一致。HTTP 回归验证配置校验和跨站请求边界。页面回归覆盖保存失败、未发送文件和切换期间追加的草稿。 [HTTP 回归](../../../test/remote.test.ts) · [页面回归](../../../test/remote-pending-page.test.ts)
