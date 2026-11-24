import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private var output = ""
    private var loaded = false
    private var restarting = false
    private var terminating = false
    private var restarts = 0
    private var watchdog: DispatchWorkItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)

        let frame = NSRect(x: 0, y: 0, width: 1280, height: 840)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "MacForge"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = false
        window.backgroundColor = NSColor(red: 0.027, green: 0.024, blue: 0.043, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.minSize = NSSize(width: 880, height: 620)

        let configuration = WKWebViewConfiguration()
        // Hover clips are muted and start without a click.
        configuration.mediaTypesRequiringUserActionForPlayback = []
        // The diagnostics page can ask the shell to try the server again; a page
        // cannot restart anything else through this channel.
        let controller = WKUserContentController()
        controller.add(self, name: "shell")
        configuration.userContentController = controller

        webView = WKWebView(frame: frame, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.contentView = webView
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        terminating = true
        watchdog?.cancel()
        server?.terminate()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], body["action"] as? String == "restart" else { return }
        restarts = 0
        restartServer()
    }

    private func findNode() -> URL? {
        // The download carries its own Node, so a Mac that has never seen
        // Homebrew can still start the server.
        if let resources = Bundle.main.resourceURL {
            let bundled = resources.appendingPathComponent("node/bin/node")
            if FileManager.default.isExecutableFile(atPath: bundled.path) {
                return bundled
            }
        }
        let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        return nil
    }

    private func startServer() {
        watchdog?.cancel()
        output = ""
        loaded = false

        guard let resources = Bundle.main.resourceURL else {
            showDiagnostics(reason: "The app bundle is missing its resources folder.")
            return
        }

        let script = resources.appendingPathComponent("server/server.mjs")
        guard FileManager.default.fileExists(atPath: script.path) else {
            showDiagnostics(reason: "The bundled server is missing. Rebuild the app with app/build.sh.")
            return
        }

        guard let node = findNode() else {
            showDiagnostics(reason: "The bundled Node runtime is missing. Rebuild MacForge with app/build.sh.")
            return
        }

        let process = Process()
        process.executableURL = node
        process.arguments = [script.path]
        process.currentDirectoryURL = resources

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.consume(text) }
        }

        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async { self?.serverExited(finished) }
        }

        do {
            try process.run()
            server = process
        } catch {
            showDiagnostics(reason: "Could not start the local server: \(error.localizedDescription)")
            return
        }

        // A server that starts but never prints its port would otherwise leave a
        // permanently blank window.
        let item = DispatchWorkItem { [weak self] in
            guard let self, !self.loaded else { return }
            self.showDiagnostics(reason: "The local server did not report a port within 20 seconds.")
        }
        watchdog = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: item)
    }

    private func serverExited(_ process: Process) {
        server = nil
        guard !terminating, !restarting else { return }

        restarts += 1
        guard restarts <= 3 else {
            showDiagnostics(reason: "The local server keeps stopping. Its output is below.")
            return
        }
        restartServer()
    }

    private func restartServer() {
        restarting = true
        watchdog?.cancel()
        server?.terminate()
        server = nil

        // A moment for the port to be released before the new process binds it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self else { return }
            self.restarting = false
            self.startServer()
        }
    }

    private func consume(_ text: String) {
        guard !loaded else { return }
        output += text
        guard let marker = output.range(of: "PORT=") else { return }

        let digits = output[marker.upperBound...].prefix { $0.isNumber }
        guard let port = Int(digits) else { return }

        loaded = true
        restarts = 0
        watchdog?.cancel()
        load(port: port)
    }

    private func load(port: Int) {
        guard let url = URL(string: "http://127.0.0.1:\(port)/") else { return }
        webView.load(URLRequest(url: url))
    }

    /// Everything the server said, on a page that can ask for another attempt.
    private func showDiagnostics(reason: String) {
        watchdog?.cancel()
        loaded = false

        let log = output.isEmpty ? "(the server printed nothing)" : String(output.suffix(4000))
        let escaped =
            log
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")

        let html = """
        <!doctype html>
        <html><head><meta charset="utf-8"><title>MacForge</title>
        <style>
          :root { color-scheme: dark; }
          body {
            margin: 0; min-height: 100vh; display: grid; place-items: center;
            background: #07060b; color: #f5f2ff;
            font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
          }
          main { max-width: 44rem; padding: 40px 32px; }
          .kicker {
            margin: 0; font: 500 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
            letter-spacing: .14em; text-transform: uppercase; color: #8d86a8;
          }
          h1 { margin: 12px 0 8px; font-size: 26px; letter-spacing: -.02em; font-weight: 500; }
          .reason { margin: 0 0 22px; color: #b9b2d4; }
          button {
            padding: 11px 20px; border: 0; border-radius: 99px; cursor: pointer;
            background: #f5f2ff; color: #0b0913; font: 500 13px/1 -apple-system, sans-serif;
          }
          button:hover { background: #ffffff; }
          pre {
            margin: 26px 0 0; padding: 16px 18px; max-height: 42vh; overflow: auto;
            border: 1px solid #241f36; border-radius: 12px; background: #0c0a15;
            color: #a9a2c4; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
            white-space: pre-wrap; overflow-wrap: anywhere;
          }
        </style></head>
        <body><main>
          <p class="kicker">MacForge</p>
          <h1>The local server isn't running.</h1>
          <p class="reason">\(reason)</p>
          <button onclick="window.webkit.messageHandlers.shell.postMessage({action:'restart'})">Start it again</button>
          <pre>\(escaped)</pre>
        </main></body></html>
        """

        webView.loadHTMLString(html, baseURL: nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
