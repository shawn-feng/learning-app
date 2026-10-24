学习伙伴 服务端 0.5.41（macOS x64 / Intel）

【安装】
1. 把「学习伙伴服务端.app」拖到 Applications 文件夹。
2. 第一次打开时，如果 macOS 提示“无法验证开发者”：
   - 在 Applications 里右键 App → 打开；或
   - 终端执行：
     xattr -dr com.apple.quarantine "/Applications/学习伙伴服务端.app"
3. 双击打开后，右上角菜单栏会出现一本书 + 状态圆点。
   首次启动会自动安装运行时（Node 22 / ffmpeg / server.cjs），需要几秒钟。
4. 状态变绿表示服务端正常；菜单里可以打开管理页、查看日志、重启/停止服务。
5. 首次启动 macOS 可能询问是否允许 Node 接受传入网络连接：局域网其他设备要访问时选“允许”。

【访问】
- 本机管理页：http://127.0.0.1:8788/
- 同一局域网的其他设备：http://<这台 Mac 的 IP>:8788/
- 账号/数据都在本机：~/Library/Application Support/LearningServer/data

【从 201 迁移数据】
1. 菜单里停止服务，退出菜单栏 App。
2. 把 201 上 /opt/learning-server/data 整个目录复制到：
   ~/Library/Application Support/LearningServer/data
   注意必须保留 .secret 文件，否则加密的评测/权益配置无法解密。
3. 重新打开 App，服务会自动启动。

【开机自启 / 自动重启】
- 服务端由用户级 LaunchAgent 托管：登录后自动启动，崩溃自动拉起。
- 菜单栏 App 也注册了登录项；即使关掉 App，服务端仍在跑。
- “保持唤醒”默认开启，防止系统闲置睡眠；但 MacBook 合盖仍会睡眠，请保持开盖使用。

【卸载】
1. 菜单里停止服务，退出菜单栏。
2. 删除 /Applications/学习伙伴服务端.app
3. 删除 ~/Library/Application Support/LearningServer
4. 删除 ~/Library/LaunchAgents/com.xuexihub.learning-server*.plist

【说明】
- 本包未签名/未公证，仅供内部安装测试。
- 需要 macOS 12+（Intel x64）。
