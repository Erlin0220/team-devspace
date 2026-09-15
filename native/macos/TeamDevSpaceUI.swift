// UI adapter only. Node owns state, credentials, operations and launchd.
// Build with the system SDK; no package dependencies or Xcode project.
import AppKit
import Foundation
import Darwin

struct MenuEntry: Decodable {
    let id: String
    let text: String
    let enabled: Bool
    let action: String?
    let separator: Bool?
    let children: [MenuEntry]?
}
struct TrayState: Decodable {
    let status: String
    let iconStatus: String
    let tooltip: String
    let menu: [MenuEntry]
    var entries: [MenuEntry] { menu.flatMap { [$0] + ($0.children ?? []) } }
}

func emit(_ event: String, _ fields: [String: Any] = [:]) {
    var value = fields
    value["event"] = event
    if let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(bytes + Data([10]))
    }
}

func validInstanceID(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}

func markUIVisible() {
    guard let path = ProcessInfo.processInfo.environment["TEAM_DEVSPACE_UI_READY_MARKER"], !path.isEmpty else { return }
    if FileManager.default.fileExists(atPath: path) { return }
    let data = Data("\(Date().timeIntervalSince1970)\n".utf8)
    do {
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    } catch {
        fputs("Team DevSpace could not update its UI visibility marker.\n", stderr)
    }
}

final class InstanceGuard {
    private let descriptor: Int32
    private init(descriptor: Int32) { self.descriptor = descriptor }
    static func acquire(identity: String, form: Bool) throws -> InstanceGuard? {
        // The dialog lock is separate from the tray lock: the existing tray
        // stays alive during setup/replacement, but duplicate forms cannot run.
        let suffix = form ? "-form" : ""
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(
            "team-devspace-tray-\(geteuid())-\(identity)\(suffix).lock").path
        let descriptor = open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        if flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
            let code = errno
            close(descriptor)
            if code == EWOULDBLOCK || code == EAGAIN { return nil }
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
        }
        return InstanceGuard(descriptor: descriptor)
    }
    deinit { close(descriptor) }
}

@MainActor
final class Application: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let formMode: Bool
    private let smoke: Bool
    private var statusItem: NSStatusItem?
    private var statusIcon: NSImage?
    private var items: [String: NSMenuItem] = [:]
    private var window: NSWindow?
    private var keyField = NSSecureTextField()
    private var projectRootLabel = NSTextField(labelWithString: "")
    private var feedback = NSTextField(wrappingLabelWithString: "")
    private var progress = NSProgressIndicator()
    private var chooseButton = NSButton()
    private var submitButton = NSButton()
    private var cancelButton = NSButton()
    private var formProjectRoot = ""
    private var menuLayout: [String] = []
    private var setup = true
    private var busy = false
    private var complete = false
    private var cancellationSent = false
    private var stopping = false

    init(form: Bool, smoke: Bool) { self.formMode = form; self.smoke = smoke }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installApplicationMenu()
        if !formMode { buildTray() }
        emit("ready")
        // Blocking pipe reads never run on the AppKit thread. UI changes and
        // stdout writes are serialized on the main queue, including EOF.
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var buffer = Data()
            var chunk = [UInt8](repeating: 0, count: 4096)
            while true {
                // FileHandle.read(upToCount:) can wait for the requested count or EOF.
                // JSON-lines is interactive: process a short read without closing stdin.
                let count = chunk.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count) }
                if count < 0 {
                    if errno == EINTR { continue }
                    fputs("Team DevSpace UI input read failed (errno=\(errno)).\n", stderr)
                    DispatchQueue.main.async { emit("protocol-error"); self?.stop() }
                    return
                }
                if count == 0 { break }
                buffer.append(contentsOf: chunk.prefix(count))
                while let newline = buffer.firstIndex(of: 10) {
                    guard buffer.distance(from: buffer.startIndex, to: newline) <= 65536 else {
                        DispatchQueue.main.async { emit("protocol-error"); self?.stop() }
                        return
                    }
                    let line = Data(buffer[..<newline])
                    buffer.removeSubrange(...newline)
                    DispatchQueue.main.async { self?.receive(line) }
                }
                if buffer.count > 65536 {
                    DispatchQueue.main.async { emit("protocol-error"); self?.stop() }
                    return
                }
            }
            DispatchQueue.main.async { self?.stop() }
        }
    }

    private func installApplicationMenu() {
        let menu = NSMenu()
        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu()
        let quit = NSMenuItem(title: "退出 Team DevSpace", action: #selector(requestClose), keyEquivalent: "q")
        quit.target = self
        applicationMenu.addItem(quit)
        applicationItem.submenu = applicationMenu
        menu.addItem(applicationItem)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "编辑")
        for (title, selector, key) in [("剪切", "cut:", "x"), ("复制", "copy:", "c"),
                                       ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(NSMenuItem(title: title, action: Selector(selector), keyEquivalent: key))
        }
        editItem.submenu = edit
        menu.addItem(editItem)
        NSApp.mainMenu = menu
    }

    @discardableResult private func add(_ menu: NSMenu, _ action: String, _ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = action
        menu.addItem(item)
        items[action] = item
        return item
    }

    private func buildTray() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem = item
        let menu = NSMenu()
        menu.autoenablesItems = false
        add(menu, "status", "正在启动…").isEnabled = false
        item.menu = menu
        if let url = Bundle.main.url(forResource: "TeamDevSpaceTemplate", withExtension: "png"),
           let image = NSImage(contentsOf: url) {
            image.isTemplate = true
            image.size = NSSize(width: 18, height: 18)
            statusIcon = image
        }
        setIcon("stopped", summary: "正在启动…")
        DispatchQueue.main.async { [weak self] in
            guard let self, let item = self.statusItem, item.isVisible, item.button != nil else {
                emit("protocol-error", ["reason": "tray-not-visible"])
                self?.stop()
                return
            }
            markUIVisible()
            emit("tray-visible")
        }
    }

    private func setIcon(_ status: String, summary: String) {
        guard let item = statusItem, let button = item.button else { return }
        button.image = statusIcon
        button.imagePosition = .imageLeading
        // Compact feedback remains visible after the menu closes; full progress
        // belongs in the shared Control Center, not a growing menu-bar label.
        let marker = ["busy": " …", "partial": " !", "suspended": " Ⅱ", "stopped": " –"][status] ?? ""
        button.title = marker
        item.length = marker.isEmpty ? NSStatusItem.squareLength : NSStatusItem.variableLength
        button.toolTip = summary
        button.setAccessibilityLabel(summary)
        if item.isVisible { markUIVisible() }
    }

    private func receive(_ data: Data) {
        guard !stopping else { return }
        do {
            if formMode {
                guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let type = object["type"] as? String else { throw ProtocolError.invalid }
                if type == "form", window == nil,
                   let mode = object["mode"] as? String, ["setup", "replace-key"].contains(mode),
                   let initialProjectRoot = object["projectRoot"] as? String, initialProjectRoot.utf8.count <= 4096 {
                    setup = mode == "setup"
                    formProjectRoot = initialProjectRoot
                    buildForm()
                    if smoke { emit("form-presented", ["mode": mode]) }
                } else if smoke, type == "exercise-form", window != nil {
                    if object["action"] as? String == "cancel" { requestClose() }
                    else if let key = object["accessKey"] as? String {
                        keyField.stringValue = key
                        submitForm()
                    } else { throw ProtocolError.invalid }
                } else if type == "form-result", window != nil,
                          let phase = object["phase"] as? String, ["busy", "success", "error"].contains(phase),
                          let message = object["message"] as? String {
                    showResult(phase, message: String(message.prefix(360)))
                    if smoke { emit("form-updated", ["phase": phase, "inputEnabled": keyField.isEnabled]) }
                } else { throw ProtocolError.invalid }
            } else if smoke,
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let action = object["exerciseMenu"] as? String, let item = items[action], item.isEnabled {
                menuAction(item)
            } else {
                let state = try JSONDecoder().decode(TrayState.self, from: data)
                guard ["ready", "partial", "suspended", "busy", "stopped"].contains(state.status),
                      ["ready", "partial", "suspended", "busy", "stopped"].contains(state.iconStatus),
                      (1...20).contains(state.menu.count),
                      state.entries.count <= 32,
                      Set(state.entries.map { $0.id }).count == state.entries.count,
                      state.entries.allSatisfy({ !$0.id.isEmpty && $0.id.utf8.count <= 64 }),
                      state.menu.allSatisfy({ entry in
                          (entry.children ?? []).isEmpty || (entry.separator != true && (entry.action ?? "").isEmpty
                            && (entry.children ?? []).allSatisfy { ($0.children ?? []).isEmpty })
                      }) else { throw ProtocolError.invalid }
                apply(state)
                if smoke { emit("state-applied", ["status": state.status]) }
            }
        } catch { emit("protocol-error") }
    }

    private func apply(_ state: TrayState) {
        let layout = state.entries.map { "\($0.id):\($0.separator == true):\($0.children?.count ?? 0)" }
        if layout != menuLayout {
            let menu = NSMenu()
            menu.autoenablesItems = false
            items.removeAll()
            for entry in state.menu {
                if entry.separator == true { menu.addItem(.separator()) }
                else {
                    let item = add(menu, entry.id, String(entry.text.prefix(64)))
                    if let children = entry.children, !children.isEmpty {
                        let submenu = NSMenu(title: entry.text)
                        submenu.autoenablesItems = false
                        for child in children {
                            if child.separator == true { submenu.addItem(.separator()) }
                            else { add(submenu, child.id, String(child.text.prefix(64))) }
                        }
                        item.submenu = submenu
                    }
                }
            }
            statusItem?.menu = menu
            menuLayout = layout
        }
        for entry in state.entries {
            items[entry.id]?.title = String(entry.text.prefix(64))
            items[entry.id]?.isEnabled = entry.enabled
            items[entry.id]?.representedObject = entry.action ?? ""
        }
        setIcon(state.iconStatus, summary: String(state.tooltip.prefix(360)))
    }

    @objc private func menuAction(_ sender: NSMenuItem) {
        guard sender.isEnabled, let action = sender.representedObject as? String, !action.isEmpty else { return }
        emit("menu", ["action": action])
    }

    private func buildForm() {
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: setup ? 440 : 350),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "Team DevSpace"
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        window = panel
        let heading = NSTextField(labelWithString: setup ? "完成设置" : "更换 Access Key")
        heading.font = .boldSystemFont(ofSize: 20)
        let hint = NSTextField(wrappingLabelWithString: setup
            ? "输入管理员发放的 Access Key，并选择项目目录。远程操作使用你的 macOS 用户权限；项目目录限制文件工具，不是 Shell 沙箱。"
            : "更换后，当前远程连接会断开，并重新绑定这台电脑。项目目录设置保持不变。")
        hint.textColor = .secondaryLabelColor
        keyField.placeholderString = "Access Key"
        keyField.setAccessibilityLabel("Access Key")
        let keyLabel = NSTextField(labelWithString: setup ? "Access Key" : "新的 Access Key")
        var views: [NSView] = [heading, hint, keyLabel, keyField]
        if setup {
            projectRootLabel.lineBreakMode = .byTruncatingMiddle
            projectRootLabel.maximumNumberOfLines = 2
            refreshProjectRoot()
            chooseButton = NSButton(title: "选择…", target: self, action: #selector(chooseFolder))
            let row = NSStackView(views: [projectRootLabel, chooseButton])
            row.orientation = .horizontal
            row.spacing = 12
            projectRootLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
            views += [NSTextField(labelWithString: "项目目录"), row]
        }
        progress.style = .spinning
        progress.controlSize = .small
        progress.isDisplayedWhenStopped = false
        feedback.textColor = .secondaryLabelColor
        feedback.maximumNumberOfLines = 4
        let progressRow = NSStackView(views: [progress, feedback])
        progressRow.orientation = .horizontal
        progressRow.spacing = 8
        feedback.setContentHuggingPriority(.defaultLow, for: .horizontal)
        submitButton = NSButton(title: setup ? "连接" : "更换", target: self, action: #selector(submitForm))
        submitButton.keyEquivalent = "\r"
        cancelButton = NSButton(title: "取消", target: self, action: #selector(requestClose))
        cancelButton.keyEquivalent = "\u{1b}"
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let buttons = NSStackView(views: [spacer, cancelButton, submitButton])
        buttons.orientation = .horizontal
        buttons.spacing = 12
        views += [progressRow, buttons]
        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = panel.contentView!
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: content.bottomAnchor, constant: -24),
            keyField.widthAnchor.constraint(equalTo: stack.widthAnchor),
            hint.widthAnchor.constraint(equalTo: stack.widthAnchor),
            progressRow.widthAnchor.constraint(equalTo: stack.widthAnchor),
            buttons.widthAnchor.constraint(equalTo: stack.widthAnchor),
            progress.widthAnchor.constraint(equalToConstant: 16),
            progress.heightAnchor.constraint(equalToConstant: 16),
        ])
        if setup, let row = projectRootLabel.superview {
            row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        panel.center()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(keyField)
        DispatchQueue.main.async { [weak self, weak panel] in
            guard let panel, panel.isVisible else {
                emit("protocol-error", ["reason": "form-not-visible"])
                self?.stop()
                return
            }
            markUIVisible()
            emit("form-visible")
        }
    }

    private func refreshProjectRoot() {
        projectRootLabel.stringValue = formProjectRoot.isEmpty ? "尚未选择项目目录" : formProjectRoot
        projectRootLabel.toolTip = formProjectRoot
    }

    @objc private func chooseFolder() {
        guard !busy, !complete, let window = window else { return }
        let picker = NSOpenPanel()
        picker.canChooseFiles = false
        picker.canChooseDirectories = true
        picker.allowsMultipleSelection = false
        picker.canCreateDirectories = true
        picker.prompt = "选择"
        picker.message = "选择 Team DevSpace 当前项目目录"
        if !formProjectRoot.isEmpty, FileManager.default.fileExists(atPath: formProjectRoot) {
            picker.directoryURL = URL(fileURLWithPath: formProjectRoot)
        }
        picker.beginSheetModal(for: window) { [weak self] response in
            DispatchQueue.main.async {
                if response == .OK, let path = picker.url?.path { self?.formProjectRoot = path; self?.refreshProjectRoot() }
            }
        }
    }

    @objc private func submitForm() {
        if complete { requestClose(); return }
        guard !busy, !cancellationSent else { return }
        let key = keyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, key.utf8.count <= 256, !setup || !formProjectRoot.isEmpty else {
            feedback.stringValue = setup ? "请输入 Access Key，并选择项目目录。" : "请输入完整的 Access Key。"
            return
        }
        showResult("busy", message: "正在验证 Access Key…")
        var fields: [String: Any] = ["accessKey": key]
        if setup { fields["projectRoot"] = formProjectRoot }
        emit("submit", fields)
    }

    private func showResult(_ phase: String, message: String) {
        busy = phase == "busy"
        complete = phase == "success"
        keyField.isEnabled = !busy && !complete && !cancellationSent
        chooseButton.isEnabled = keyField.isEnabled
        submitButton.isEnabled = !busy && !cancellationSent
        submitButton.title = complete ? "完成" : setup ? "连接" : "更换"
        cancelButton.isHidden = complete
        feedback.stringValue = message
        feedback.textColor = phase == "error" ? .systemRed : .secondaryLabelColor
        if busy { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
        if complete { keyField.stringValue = "" }
        if phase == "error" { window?.makeFirstResponder(keyField) }
    }

    @objc private func requestClose() {
        if formMode {
            guard !cancellationSent else { return }
            cancellationSent = true
            cancelButton.isEnabled = false
            submitButton.isEnabled = false
            keyField.isEnabled = false
            chooseButton.isEnabled = false
            emit("cancel")
        } else { emit("menu", ["action": "exit"]) }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if stopping { return true }
        requestClose()
        return false // Node acknowledges only after an in-flight transaction settles.
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if stopping { return .terminateNow }
        requestClose()
        return .terminateCancel
    }

    private func stop() {
        stopping = true
        keyField.stringValue = ""
        NSApp.abortModal()
        NSApp.terminate(nil)
    }
}

enum ProtocolError: Error { case invalid }

@main
struct Main {
    @MainActor static func main() {
        if CommandLine.arguments.contains("--self-test") {
            precondition(validInstanceID(String(repeating: "a0", count: 32)))
            for value in ["", "../other", String(repeating: "g", count: 64), String(repeating: "a", count: 63)] {
                precondition(!validInstanceID(value))
            }
            precondition((try? JSONDecoder().decode(TrayState.self, from: Data("{}".utf8))) == nil)
            emit("self-test", ["passed": true])
            return
        }
        let form = CommandLine.arguments.contains("form")
        let folder = CommandLine.arguments.contains("choose-folder")
        guard let identity = ProcessInfo.processInfo.environment["TEAM_DEVSPACE_TRAY_INSTANCE_ID"], validInstanceID(identity) else {
            fputs("Start Team DevSpace through its controller; a valid local instance identity is required.\n", stderr)
            exit(1)
        }
        let instance: InstanceGuard
        do {
            guard let acquired = try InstanceGuard.acquire(identity: identity, form: form || folder) else { emit("duplicate"); return }
            instance = acquired
        } catch { fputs("Team DevSpace could not acquire its UI instance lock.\n", stderr); exit(1) }
        let app = NSApplication.shared
        // LSUIElement already supplies accessory policy for the packaged app.
        // A redundant policy switch may return false; the current policy is authoritative.
        if app.activationPolicy() != .accessory && !app.setActivationPolicy(.accessory) {
            // A setup form may use a regular window, but the tray must stay menu-bar-only.
            if (!form && !folder) || (app.activationPolicy() != .regular && !app.setActivationPolicy(.regular)) {
                fputs("Team DevSpace could not enter a visible macOS application session (policy=\(app.activationPolicy().rawValue)).\n", stderr)
                exit(1)
            }
        }
        if folder {
            // Reuse the packaged AppKit helper for the Control Center's one-shot
            // directory picker. No AppleScript, settings state or service logic.
            app.finishLaunching()
            let picker = NSOpenPanel()
            picker.canChooseFiles = false
            picker.canChooseDirectories = true
            picker.allowsMultipleSelection = false
            picker.canCreateDirectories = true
            picker.prompt = "选择"
            picker.message = "选择 Team DevSpace 当前项目目录"
            if let root = ProcessInfo.processInfo.environment["TEAM_DEVSPACE_CURRENT_PROJECT_ROOT"],
               !root.isEmpty, FileManager.default.fileExists(atPath: root) {
                picker.directoryURL = URL(fileURLWithPath: root)
            }
            app.activate(ignoringOtherApps: true)
            var visiblyPresented = false
            if CommandLine.arguments.contains("--smoke") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    visiblyPresented = picker.isVisible
                    picker.cancel(nil)
                }
            }
            withExtendedLifetime(instance) {
                let result = picker.runModal()
                var fields: [String: Any] = ["projectRoot": NSNull(), "visible": visiblyPresented,
                                           "canCreateDirectories": picker.canCreateDirectories]
                if result == .OK, let path = picker.url?.path { fields["projectRoot"] = path }
                emit("folder-result", fields)
            }
            return
        }
        let delegate = Application(form: form, smoke: CommandLine.arguments.contains("--smoke"))
        app.delegate = delegate
        withExtendedLifetime((instance, delegate)) { app.run() }
    }
}
