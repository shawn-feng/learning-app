//
// 学习伙伴服务端 · macOS 菜单栏 App（PoC）
// 目标：macOS 12+ / Intel x64；用 LaunchAgent 托管 Node 服务端，App 只做状态与控制。
//
import AppKit
import Darwin
import Foundation
import IOKit.pwr_mgt

let kServerLabel = "com.xuexihub.learning-server"
let kMenuBarLabel = "com.xuexihub.learning-server-menubar"
let kServerVersion = "0.5.41"
let kPort = 8788

final class ServerAppDelegate: NSObject, NSApplicationDelegate {
    private let fm = FileManager.default
    private var statusItem: NSStatusItem!
    private var menu: NSMenu!
    private var versionLine: NSMenuItem!
    private var statusLine: NSMenuItem!
    private var detailLine: NSMenuItem!
    private var dbLine: NSMenuItem!
    private var startStopItem: NSMenuItem!
    private var keepAwakeItem: NSMenuItem!
    private var checkTimer: Timer?
    private var healthOK = false
    private var dbOK = false
    private var serviceLoaded = false
    private var uptimeSeconds = 0
    private var serverVersion = kServerVersion
    private var keepAwakeEnabled = false
    private var powerAssertion: IOPMAssertionID = 0
    private var installing = false
    private var lastRefresh = Date()
    private var lastVersionFetch = Date.distantPast

    private var appSupportDir: URL {
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("LearningServer", isDirectory: true)
    }
    private var runtimeDir: URL { appSupportDir.appendingPathComponent("runtime", isDirectory: true) }
    private var dataDir: URL { appSupportDir.appendingPathComponent("data", isDirectory: true) }
    private var logsDir: URL { appSupportDir.appendingPathComponent("logs", isDirectory: true) }
    private var serverPlistURL: URL {
        fm.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(kServerLabel).plist")
    }
    private var menuBarPlistURL: URL {
        fm.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(kMenuBarLabel).plist")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let path = Bundle.main.bundlePath
        guard path.hasPrefix("/Applications/") else {
            alert("请先安装到 Applications",
                  "请把「学习伙伴服务端.app」拖到 Applications 文件夹后再打开。\n当前路径：\(path)")
            NSApp.terminate(nil)
            return
        }

        setupStatusItem()
        setKeepAwake(true)
        installRuntime()
        startPolling()
    }

    // MARK: - 菜单栏 UI

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "book.closed.fill",
                                   accessibilityDescription: "学习伙伴服务端")
            button.image?.isTemplate = true
            button.imagePosition = .imageLeading
            button.attributedTitle = dotTitle("检查中", color: .systemGray)
            button.toolTip = "学习伙伴服务端"
        }

        menu = NSMenu()
        menu.autoenablesItems = false

        versionLine = NSMenuItem(title: "学习伙伴 服务端  v\(kServerVersion)", action: nil, keyEquivalent: "")
        versionLine.isEnabled = false
        menu.addItem(versionLine)

        statusLine = NSMenuItem(title: "● 检查中", action: nil, keyEquivalent: "")
        statusLine.isEnabled = true
        menu.addItem(statusLine)

        detailLine = NSMenuItem(title: "端口 \(kPort) · 未运行", action: nil, keyEquivalent: "")
        detailLine.isEnabled = false
        menu.addItem(detailLine)

        dbLine = NSMenuItem(title: "数据库 -- · -- 秒前检查", action: nil, keyEquivalent: "")
        dbLine.isEnabled = false
        menu.addItem(dbLine)

        menu.addItem(NSMenuItem.separator())

        let openItem = NSMenuItem(title: "打开管理页…", action: #selector(openWeb), keyEquivalent: "o")
        openItem.target = self
        menu.addItem(openItem)

        let logItem = NSMenuItem(title: "查看日志…", action: #selector(openLogs), keyEquivalent: "l")
        logItem.target = self
        menu.addItem(logItem)

        let restartItem = NSMenuItem(title: "重启服务", action: #selector(restartService), keyEquivalent: "r")
        restartItem.target = self
        menu.addItem(restartItem)

        startStopItem = NSMenuItem(title: "停止服务", action: #selector(toggleService), keyEquivalent: "")
        startStopItem.target = self
        menu.addItem(startStopItem)

        menu.addItem(NSMenuItem.separator())

        keepAwakeItem = NSMenuItem(title: "保持唤醒（防系统睡眠）",
                                   action: #selector(toggleKeepAwake), keyEquivalent: "")
        keepAwakeItem.target = self
        keepAwakeItem.state = .on
        menu.addItem(keepAwakeItem)

        let quitItem = NSMenuItem(title: "退出菜单栏", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    private func dotTitle(_ text: String, color: NSColor) -> NSAttributedString {
        NSAttributedString(string: " ●", attributes: [
            .foregroundColor: color,
            .font: NSFont.systemFont(ofSize: 10, weight: .bold),
        ])
    }

    private func statusText(_ text: String, color: NSColor) -> NSAttributedString {
        NSAttributedString(string: "● \(text)", attributes: [
            .foregroundColor: color,
            .font: NSFont.menuFont(ofSize: 13),
        ])
    }

    private func updateUI() {
        guard statusItem != nil else { return }
        let color: NSColor
        let text: String
        if installing {
            color = .systemGray
            text = "正在安装运行时…"
        } else if healthOK && dbOK {
            color = .systemGreen
            text = "运行正常"
        } else if healthOK && !dbOK {
            color = .systemYellow
            text = "数据库异常"
        } else if serviceLoaded {
            color = .systemYellow
            text = "启动中 / 无响应"
        } else {
            color = .systemRed
            text = "已停止"
        }

        statusLine.attributedTitle = statusText(text, color: color)
        versionLine.title = "学习伙伴 服务端  v\(serverVersion)"
        detailLine.title = "端口 \(kPort) · \(formatUptime(uptimeSeconds))"
        let seconds = max(0, Int(Date().timeIntervalSince(lastRefresh)))
        dbLine.title = "数据库 \(dbOK ? "ok" : "未连接") · \(seconds) 秒前检查"
        startStopItem.title = serviceLoaded ? "停止服务" : "启动服务"
        keepAwakeItem.state = keepAwakeEnabled ? .on : .off

        if let button = statusItem.button {
            button.attributedTitle = dotTitle(text, color: color)
            button.toolTip = "学习伙伴服务端：\(text)"
        }
    }

    private func formatUptime(_ seconds: Int) -> String {
        if seconds <= 0 { return "未运行" }
        let d = seconds / 86400
        let h = (seconds % 86400) / 3600
        let m = (seconds % 3600) / 60
        if d > 0 { return "已运行 \(d) 天 \(h) 小时" }
        if h > 0 { return "已运行 \(h) 小时 \(m) 分" }
        return "已运行 \(m) 分"
    }

    // MARK: - 运行时安装

    private func installRuntime() {
        do {
            try fm.createDirectory(at: appSupportDir, withIntermediateDirectories: true)
            try fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
            try fm.createDirectory(at: logsDir, withIntermediateDirectories: true)
        } catch {
            alert("无法创建数据目录", error.localizedDescription)
            return
        }

        guard let bundledRuntime = Bundle.main.resourceURL?
            .appendingPathComponent("runtime", isDirectory: true) else {
            alert("安装包不完整", "找不到内置的 runtime 目录。")
            return
        }

        let versionFile = runtimeDir.appendingPathComponent("VERSION")
        let installedVersion = (try? String(contentsOf: versionFile, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let needCopy = installedVersion != kServerVersion
            || !fm.fileExists(atPath: runtimeDir.appendingPathComponent("node").path)
            || !fm.fileExists(atPath: runtimeDir.appendingPathComponent("server.cjs").path)

        if needCopy {
            installing = true
            updateUI()
            if serviceIsLoaded() {
                _ = runLaunchctl(["bootout", "gui/\(getuid())/\(kServerLabel)"])
            }
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self else { return }
                do {
                    if self.fm.fileExists(atPath: self.runtimeDir.path) {
                        try self.fm.removeItem(at: self.runtimeDir)
                    }
                    try self.fm.copyItem(at: bundledRuntime, to: self.runtimeDir)
                    DispatchQueue.main.async {
                        self.installing = false
                        self.writeServerPlist()
                        self.writeMenuBarPlist()
                        self.startService()
                        self.refresh()
                    }
                } catch {
                    DispatchQueue.main.async {
                        self.installing = false
                        self.alert("安装运行时失败", error.localizedDescription)
                    }
                }
            }
        } else {
            writeServerPlist()
            writeMenuBarPlist()
            if !serviceIsLoaded() {
                startService()
            }
        }
    }

    private func writePlist(_ plist: [String: Any], to url: URL) throws {
        try fm.createDirectory(at: url.deletingLastPathComponent(),
                               withIntermediateDirectories: true)
        let data = try PropertyListSerialization.data(fromPropertyList: plist,
                                                      format: .xml,
                                                      options: 0)
        try data.write(to: url, options: .atomic)
    }

    private func writeServerPlist() {
        let plist: [String: Any] = [
            "Label": kServerLabel,
            "ProgramArguments": [
                runtimeDir.appendingPathComponent("node").path,
                runtimeDir.appendingPathComponent("server.cjs").path,
            ],
            "WorkingDirectory": runtimeDir.path,
            "EnvironmentVariables": [
                "SERVER_DATA_DIR": dataDir.path,
                "FFMPEG_BIN": runtimeDir.appendingPathComponent("ffmpeg").path,
                "SERVER_PORT": String(kPort),
            ],
            "RunAtLoad": true,
            "KeepAlive": true,
            "ThrottleInterval": 10,
            "ProcessType": "Background",
            "StandardOutPath": logsDir.appendingPathComponent("server.log").path,
            "StandardErrorPath": logsDir.appendingPathComponent("server.err.log").path,
        ]
        do {
            try writePlist(plist, to: serverPlistURL)
        } catch {
            alert("写入服务配置失败", error.localizedDescription)
        }
    }

    private func writeMenuBarPlist() {
        let plist: [String: Any] = [
            "Label": kMenuBarLabel,
            "ProgramArguments": ["/usr/bin/open", "-a", Bundle.main.bundlePath],
            "RunAtLoad": true,
            "LimitLoadToSessionType": "Aqua",
        ]
        do {
            try writePlist(plist, to: menuBarPlistURL)
            _ = runLaunchctl(["bootstrap", "gui/\(getuid())", menuBarPlistURL.path])
        } catch {
            // 登录项失败不影响服务端本身；下次打开 App 仍会写。
            NSLog("write menubar plist failed: \(error.localizedDescription)")
        }
    }

    // MARK: - launchctl

    @discardableResult
    private func runLaunchctl(_ args: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus
        } catch {
            return -1
        }
    }

    private func serviceIsLoaded() -> Bool {
        runLaunchctl(["print", "gui/\(getuid())/\(kServerLabel)"]) == 0
    }

    private func startService() {
        if serviceIsLoaded() {
            _ = runLaunchctl(["kickstart", "-k", "gui/\(getuid())/\(kServerLabel)"])
        } else {
            let rc = runLaunchctl(["bootstrap", "gui/\(getuid())", serverPlistURL.path])
            if rc != 0 {
                _ = runLaunchctl(["load", "-w", serverPlistURL.path])
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.refresh()
        }
    }

    private func stopService() {
        _ = runLaunchctl(["bootout", "gui/\(getuid())/\(kServerLabel)"])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.refresh()
        }
    }

    // MARK: - 健康检查

    private func startPolling() {
        checkTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        refresh()
    }

    private func refresh() {
        serviceLoaded = serviceIsLoaded()
        let url = URL(string: "http://127.0.0.1:\(kPort)/api/v1/health")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            var ok = false
            var db = false
            var uptime = 0
            if let data,
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                ok = (object["ok"] as? Bool) ?? false
                db = ((object["db"] as? String) ?? "") == "ok"
                uptime = (object["uptime"] as? Int) ?? 0
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.healthOK = ok
                self.dbOK = db
                self.uptimeSeconds = uptime
                self.lastRefresh = Date()
                self.updateUI()
            }
        }.resume()

        if Date().timeIntervalSince(lastVersionFetch) > 30 {
            fetchVersion()
        }
        updateUI()
    }

    private func fetchVersion() {
        lastVersionFetch = Date()
        let url = URL(string: "http://127.0.0.1:\(kPort)/api/v1/version")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let data,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let version = object["version"] as? String else { return }
            DispatchQueue.main.async {
                self?.serverVersion = version
                self?.updateUI()
            }
        }.resume()
    }

    // MARK: - 防睡眠

    private func setKeepAwake(_ on: Bool) {
        if on {
            if powerAssertion == 0 {
                var assertion: IOPMAssertionID = 0
                let reason = "学习伙伴服务端需要持续运行" as CFString
                let result = IOPMAssertionCreateWithName(
                    kIOPMAssertionTypeNoIdleSleep,
                    IOPMAssertionLevel(kIOPMAssertionLevelOn),
                    reason,
                    &assertion
                )
                if result == kIOReturnSuccess {
                    powerAssertion = assertion
                }
            }
        } else if powerAssertion != 0 {
            IOPMAssertionRelease(powerAssertion)
            powerAssertion = 0
        }
        keepAwakeEnabled = on
        updateUI()
    }

    // MARK: - 菜单动作

    @objc private func openWeb() {
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:\(kPort)/")!)
    }

    @objc private func openLogs() {
        NSWorkspace.shared.open(logsDir)
    }

    @objc private func restartService() {
        if serviceIsLoaded() {
            _ = runLaunchctl(["kickstart", "-k", "gui/\(getuid())/\(kServerLabel)"])
        } else {
            startService()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.refresh()
        }
    }

    @objc private func toggleService() {
        if serviceIsLoaded() {
            stopService()
        } else {
            startService()
        }
    }

    @objc private func toggleKeepAwake() {
        setKeepAwake(!keepAwakeEnabled)
    }

    @objc private func quitApp() {
        setKeepAwake(false)
        NSApp.terminate(nil)
    }

    private func alert(_ title: String, _ message: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = message
        a.alertStyle = .warning
        a.addButton(withTitle: "好")
        a.runModal()
    }

    func applicationWillTerminate(_ notification: Notification) {
        if powerAssertion != 0 {
            IOPMAssertionRelease(powerAssertion)
            powerAssertion = 0
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        statusItem.button?.performClick(nil)
        return true
    }
}

let app = NSApplication.shared
let delegate = ServerAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
