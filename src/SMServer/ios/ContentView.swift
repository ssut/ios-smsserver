import Foundation
import SwiftUI
import UIKit
import Combine
import Photos
import CoreImage
import UniformTypeIdentifiers

struct AlertMessage: Identifiable {
	let id = UUID()
	let title: String
	let message: String
}

struct AddressEntry: Identifiable {
	let id: String
	let title: String
	let symbol: String
	let url: String
}

struct TweakStatus {
	enum Level {
		case connected, reachable, unreachable
	}

	let reachable: Bool
	let connected: Bool
	let version: String?
	let latencyMs: Int

	init(summary: [String: Any]) {
		reachable = summary["reachable"] as? Bool ?? false
		connected = summary["connected"] as? Bool ?? false
		version = summary["version"] as? String
		latencyMs = summary["latency_ms"] as? Int ?? 0
	}

	var level: Level {
		if connected { return .connected }
		return reachable ? .reachable : .unreachable
	}

	var text: String {
		switch level {
			case .connected:
				if let version = version, !version.isEmpty {
					return "Messages tweak: Connected (v\(version))"
				}
				return "Messages tweak: Connected"
			case .reachable:
				return "Messages tweak: Reachable, not connected"
			case .unreachable:
				return "Messages tweak: Unreachable — messages can be read but not sent"
		}
	}

	var symbol: String {
		switch level {
			case .connected: return "checkmark.circle.fill"
			case .reachable: return "exclamationmark.circle.fill"
			case .unreachable: return "xmark.octagon.fill"
		}
	}
}

final class ServerController: ObservableObject {
	static let shared = ServerController()
	static let networkChangeNotification = Notification.Name("ianwelker.smserver.system.config.network_change")

	let server = ServerDelegate()
	let settings = Settings.shared()

	@Published private(set) var isRunning: Bool = false
	@Published private(set) var isBusy: Bool = false
	@Published private(set) var ipAddress: String? = nil
	@Published private(set) var hostname: String = ""
	@Published var lastError: String? = nil
	@Published private(set) var socketStatusText: String? = nil
	@Published private(set) var remoteId: String? = nil
	@Published private(set) var startedAt: Date? = nil
	@Published private(set) var clientCount: Int = 0
	@Published private(set) var uptimeText: String = ""
	@Published private(set) var hasRunBefore: Bool = UserDefaults.standard.object(forKey: "has_run") != nil
	@Published private(set) var notice: String? = nil
	@Published private(set) var tweakStatus: TweakStatus? = nil
	@Published private(set) var remoteError: String? = nil

	private var observers: [NSObjectProtocol] = []
	private var uptimeTimer: Timer? = nil
	private var tweakTimer: Timer? = nil
	private var tweakPollInFlight: Bool = false
	private var didPrepare: Bool = false
	private var noticeToken: Int = 0
	private let tweakQueue = DispatchQueue(label: "com.ianwelker.smserver.ui.tweak", qos: .utility)
	private static let tweakPollInterval: TimeInterval = 30

	private static let uptimeFormatter: DateComponentsFormatter = {
		let formatter = DateComponentsFormatter()
		formatter.allowedUnits = [.day, .hour, .minute, .second]
		formatter.unitsStyle = .abbreviated
		formatter.zeroFormattingBehavior = .dropLeading
		return formatter
	}()

	private init() {
		refreshNetwork()
	}

	var canStart: Bool {
		return ipAddress != nil || settings.override_no_wifi
	}

	var primaryURL: String? {
		return addressEntries().first?.url
	}

	func addressEntries() -> [AddressEntry] {
		if ipAddress == nil && !settings.override_no_wifi {
			return []
		}

		let scheme = settings.is_secure ? "https" : "http"
		let port = settings.server_port
		var entries: [AddressEntry] = []

		if let ip = ipAddress, !ip.isEmpty {
			entries.append(AddressEntry(id: "wifi", title: "Wi-Fi address", symbol: "wifi", url: "\(scheme)://\(ip):\(port)"))
		}

		if !hostname.isEmpty {
			entries.append(AddressEntry(id: "bonjour", title: "Local hostname", symbol: "network", url: "\(scheme)://\(hostname).local:\(port)"))
		}

		return entries
	}

	func prepareIfNeeded() {
		guard !didPrepare else {
			refreshNetwork()
			refreshStatus()
			return
		}
		didPrepare = true

		requestPhotoAccess()
		installObservers()
		refreshNetwork()
		refreshStatus()

		if settings.start_on_load {
			if canStart {
				Const.log("event=ui.server.autostart port=\(settings.server_port)")
				start()
			} else {
				Const.log("event=ui.server.autostart_skipped reason=no_wifi", warning: true)
			}
		}
	}

	func startFromUser() {
		if !hasRunBefore {
			UserDefaults.standard.setValue(true, forKey: "has_run")
			hasRunBefore = true
		}
		start()
	}

	func start() {
		guard !isBusy else { return }
		guard !isRunning else {
			refreshStatus()
			return
		}
		guard canStart else {
			Const.log("event=ui.server.start_blocked reason=no_wifi", warning: true)
			lastError = "Connect to Wi-Fi to start the server, or enable \"Allow operation off Wi-Fi\" in Settings."
			return
		}

		isBusy = true
		let port = settings.server_port
		Const.log("event=ui.server.start port=\(port) socket_port=\(settings.socket_port) secure=\(settings.is_secure) remote=\(settings.run_remote)")

		DispatchQueue.global(qos: .userInitiated).async {
			let result = self.server.startServers()

			DispatchQueue.main.async {
				self.isBusy = false

				if result.0 {
					Const.log("event=ui.server.started port=\(port)")
					self.pollTweakStatus(reason: "start")
				} else {
					Const.log("event=ui.server.start_failed port=\(port) reason=\(result.1)", warning: true)
					self.lastError = result.1.isEmpty ? "The server could not be started." : result.1
				}

				self.refreshStatus()
			}
		}
	}

	func stop() {
		guard !isBusy, isRunning else { return }

		isBusy = true
		Const.log("event=ui.server.stop port=\(settings.server_port)")

		DispatchQueue.global(qos: .userInitiated).async {
			self.server.stopServers()

			DispatchQueue.main.async {
				self.isBusy = false
				self.remoteId = nil
				self.tweakStatus = nil
				self.refreshStatus()
				Const.log("event=ui.server.stopped")
			}
		}
	}

	func reloadAssets() {
		Const.log("event=ui.assets.reload")
		server.reloadVars()
		showNotice("Web assets reloaded")
	}

	func enteredBackground() {
		if !settings.background || !server.isRunning() {
			Const.log("event=ui.background.kill_timer_started backgrounding=\(settings.background) running=\(server.isRunning())")
			DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
				if UIApplication.shared.applicationState == .background {
					Const.log("event=ui.background.exit")
					exit(0)
				}
			}
		}
	}

	func refreshNetwork() {
		let ip = Const.getWiFiAddress()
		let host = ServerController.deviceHostname()

		if ip != ipAddress {
			ipAddress = ip
			Const.log("event=ui.network.address ip=\(ip ?? "none")")
		}

		if host != hostname {
			hostname = host
		}
	}

	func refreshStatus() {
		let running = server.isRunning()

		if running != isRunning {
			isRunning = running
			Const.log("event=ui.server.state running=\(running)")
		}

		syncRemoteError()

		if running {
			let started = server.started_at ?? startedAt ?? Date()
			if started != startedAt {
				startedAt = started
			}

			let clients = server.connectedClientCount()
			if clients != clientCount {
				clientCount = clients
			}

			let text = ServerController.uptimeFormatter.string(from: started, to: Date()) ?? "0s"
			if text != uptimeText {
				uptimeText = text
			}

			startTimers()
		} else {
			if startedAt != nil {
				startedAt = nil
			}
			if clientCount != 0 {
				clientCount = 0
			}
			if !uptimeText.isEmpty {
				uptimeText = ""
			}

			stopTimers()
		}
	}

	func pollTweakStatus(reason: String, completion: (() -> Void)? = nil) {
		guard !tweakPollInFlight else {
			completion?()
			return
		}
		tweakPollInFlight = true

		tweakQueue.async {
			let status = TweakStatus(summary: self.server.tweakSummary())

			DispatchQueue.main.async {
				self.tweakPollInFlight = false
				self.tweakStatus = status
				Const.log("event=ui.tweak.status reachable=\(status.reachable) connected=\(status.connected) version=\(status.version ?? "none") latency_ms=\(status.latencyMs) reason=\(reason)", warning: !status.reachable)
				completion?()
			}
		}
	}

	func refreshTweakStatus() async {
		await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
			pollTweakStatus(reason: "refresh") {
				continuation.resume()
			}
		}
	}

	private func syncRemoteError() {
		let current = settings.run_remote ? server.last_remote_error : nil

		if current != remoteError {
			remoteError = current
			if let message = current {
				Const.log("event=ui.remote.error message=\(message)", warning: true)
			} else {
				Const.log("event=ui.remote.error_cleared")
			}
		}
	}

	func hasCustomCSS() -> Bool {
		return FileManager.default.fileExists(atPath: Const.custom_css_path.path)
	}

	func importCustomCSS(from url: URL) -> Bool {
		let destination = Const.custom_css_path

		do {
			if FileManager.default.fileExists(atPath: destination.path) {
				try FileManager.default.removeItem(at: destination)
			}
			try FileManager.default.copyItem(at: url, to: destination)
			try? FileManager.default.removeItem(at: url)

			Const.log("event=ui.css.imported source=\(url.lastPathComponent)")
			server.reloadVars()
			showNotice("Custom CSS imported")
			return true
		} catch {
			Const.log("event=ui.css.import_failed error=\(error.localizedDescription)", warning: true)
			return false
		}
	}

	func removeCustomCSS() -> Bool {
		do {
			try FileManager.default.removeItem(at: Const.custom_css_path)
			Const.log("event=ui.css.removed")
			server.reloadVars()
			showNotice("Custom CSS removed")
			return true
		} catch {
			Const.log("event=ui.css.remove_failed error=\(error.localizedDescription)", warning: true)
			return false
		}
	}

	private func showNotice(_ text: String) {
		noticeToken += 1
		let token = noticeToken
		notice = text

		DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
			guard let self = self, self.noticeToken == token else { return }
			self.notice = nil
		}
	}

	private func requestPhotoAccess() {
		let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)

		switch status {
			case .authorized, .limited:
				break
			case .notDetermined:
				PHPhotoLibrary.requestAuthorization(for: .readWrite) { granted in
					Const.log("event=ui.photos.authorization status=\(granted.rawValue)", warning: granted != .authorized && granted != .limited)
				}
			default:
				Const.log("event=ui.photos.authorization status=\(status.rawValue) reason=not_authorized", warning: true)
		}
	}

	private func installObservers() {
		observers.append(NotificationCenter.default.addObserver(forName: ServerController.networkChangeNotification, object: nil, queue: .main) { [weak self] _ in
			Const.log("event=ui.network.changed")
			self?.refreshNetwork()
			self?.refreshStatus()
		})

		observers.append(NotificationCenter.default.addObserver(forName: Notification.Name(Const.ss_changed_notification), object: nil, queue: .main) { [weak self] notification in
			guard let state = notification.object as? SocketState else { return }
			self?.socketStateChanged(state)
		})

		observers.append(NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
			self?.refreshNetwork()
			self?.refreshStatus()
		})
	}

	private func socketStateChanged(_ state: SocketState) {
		syncRemoteError()

		switch state {
			case .Disconnected(let retry):
				socketStatusText = "Remote socket disconnected"
				remoteId = nil
				Const.log("event=ui.socket.disconnected retry=\(retry)")
				if retry {
					reconnectSocket()
				}
			case .Connecting:
				socketStatusText = "Remote socket connecting…"
			case .Connected:
				remoteId = settings.remote_id
				socketStatusText = settings.remote_id == nil ? "Remote socket connected, but no remote id; restart to retry" : "Remote socket connected"
				Const.log("event=ui.socket.connected has_remote_id=\(settings.remote_id != nil)")
			case .Reconnecting:
				socketStatusText = "Remote socket reconnecting…"
			case .FailedConnect:
				socketStatusText = "Remote socket failed to connect"
				remoteId = nil
				Const.log("event=ui.socket.failed", warning: true)
		}
	}

	private func reconnectSocket() {
		Const.log("event=ui.socket.reconnect")
		let starscream = server.starscream

		DispatchQueue.global(qos: .utility).async {
			starscream.setSocketState(new_state: .Reconnecting)
			let connected = starscream.registerAndConnect()
			starscream.setSocketState(new_state: connected ? .Connected : .FailedConnect)
			Const.log("event=ui.socket.reconnect_result success=\(connected)", warning: !connected)
		}
	}

	private func startTimers() {
		if uptimeTimer == nil {
			let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
				self?.refreshStatus()
			}
			RunLoop.main.add(timer, forMode: .common)
			uptimeTimer = timer
		}

		if tweakTimer == nil {
			let timer = Timer(timeInterval: ServerController.tweakPollInterval, repeats: true) { [weak self] _ in
				self?.pollTweakStatus(reason: "timer")
			}
			RunLoop.main.add(timer, forMode: .common)
			tweakTimer = timer
		}
	}

	private func stopTimers() {
		uptimeTimer?.invalidate()
		uptimeTimer = nil
		tweakTimer?.invalidate()
		tweakTimer = nil
	}

	private static func deviceHostname() -> String {
		var buffer = [CChar](repeating: 0, count: 256)
		guard gethostname(&buffer, buffer.count - 1) == 0 else { return "" }

		let bytes = buffer.prefix(while: { $0 != 0 }).map({ UInt8(bitPattern: $0) })
		let raw = String(decoding: bytes, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
		return raw.hasSuffix(".local") ? String(raw.dropLast(".local".count)) : raw
	}
}

enum QRCodeRenderer {
	private static let context = CIContext(options: [.useSoftwareRenderer: true, .cacheIntermediates: false])

	static func image(for string: String) -> UIImage? {
		guard let data = string.data(using: .utf8), let filter = CIFilter(name: "CIQRCodeGenerator") else {
			Const.log("event=ui.qr.render_failed reason=filter_unavailable", warning: true)
			return nil
		}

		filter.setValue(data, forKey: "inputMessage")
		filter.setValue("M", forKey: "inputCorrectionLevel")

		guard let output = filter.outputImage else {
			Const.log("event=ui.qr.render_failed reason=no_output", warning: true)
			return nil
		}

		let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))

		guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else {
			Const.log("event=ui.qr.render_failed reason=cgimage", warning: true)
			return nil
		}

		return UIImage(cgImage: cgImage)
	}
}

struct QRCodeView: View {
	let content: String

	@State private var image: UIImage? = nil
	@State private var renderedContent: String = ""

	var body: some View {
		Group {
			if let image = image {
				Image(uiImage: image)
					.interpolation(.none)
					.resizable()
					.scaledToFit()
					.accessibilityLabel("QR code for \(content)")
			} else {
				Image(systemName: "qrcode")
					.font(.largeTitle)
					.foregroundColor(.secondary)
			}
		}
		.onAppear(perform: render)
		.onChange(of: content) { _ in render() }
	}

	private func render() {
		guard renderedContent != content || image == nil else { return }
		image = QRCodeRenderer.image(for: content)
		renderedContent = content
	}
}

struct ContentView: View {
	@ObservedObject private var controller = ServerController.shared
	private let settings = Settings.shared()

	@State private var showSettings: Bool = false
	@State private var showPassword: Bool = false
	@State private var showRemoveCSS: Bool = false
	@State private var hasCustomCSS: Bool = false
	@State private var alert: AlertMessage? = nil
	@State private var copiedKey: String? = nil
	@State private var revision: Int = 0
	@State private var portText: String = String(Settings.shared().server_port)
	@State private var socketPortText: String = String(Settings.shared().socket_port)
	@State private var passwordText: String = Settings.shared().password

	private static let portRange = 1...65535
	private static let repoURL = URL(string: "https://github.com/iandwelker/smserver")
	private static let apiDocsURL = URL(string: "https://github.com/iandwelker/smserver/blob/master/docs/API/v1.md")

	func enteredBackground() {
		controller.enteredBackground()
	}

	var body: some View {
		NavigationView {
			List {
				statusSection
				addressesSection
				serverSection
				customCSSSection
				aboutSection
			}
			.listStyle(.insetGrouped)
			.navigationTitle("SMServer")
			.toolbar {
				ToolbarItemGroup(placement: .navigationBarTrailing) {
					Button(action: { controller.reloadAssets() }) {
						Image(systemName: "arrow.clockwise")
					}
					.accessibilityLabel("Reload web assets")

					Button(action: { showSettings = true }) {
						Image(systemName: "gearshape")
					}
					.accessibilityLabel("Settings")
				}

				ToolbarItemGroup(placement: .keyboard) {
					Spacer()
					Button("Done", action: hideKeyboard)
				}
			}
			.refreshable {
				controller.refreshNetwork()
				controller.refreshStatus()
				await controller.refreshTweakStatus()
			}
			.sheet(isPresented: $showSettings, onDismiss: syncFields) {
				SettingsView()
			}
			.alert(item: $alert) { message in
				Alert(title: Text(message.title), message: Text(message.message), dismissButton: .default(Text("OK")))
			}
			.onAppear {
				controller.prepareIfNeeded()
				syncFields()
				hasCustomCSS = controller.hasCustomCSS()
			}
			.onReceive(controller.$lastError) { error in
				guard let error = error else { return }
				alert = AlertMessage(title: "Failed to start", message: error)
				controller.lastError = nil
			}
			.onChange(of: portText) { commitPort($0) }
			.onChange(of: socketPortText) { commitSocketPort($0) }
			.onChange(of: passwordText) { commitPassword($0) }
		}
		.navigationViewStyle(.stack)
	}

	private var statusColor: Color {
		if controller.isBusy { return .orange }
		return controller.isRunning ? .green : Color(.systemGray)
	}

	private var statusTitle: String {
		if controller.isBusy { return controller.isRunning ? "Stopping…" : "Starting…" }
		return controller.isRunning ? "Running" : "Stopped"
	}

	private var statusDetail: String {
		if controller.isBusy { return "Please wait" }
		if controller.isRunning { return "Serving on port \(settings.server_port)\(settings.is_secure ? " over TLS" : "")" }
		if !controller.hasRunBefore { return "Tap Start to run the server for the first time" }
		if !controller.canStart { return "Connect to Wi-Fi, or allow operation off Wi-Fi in Settings" }
		return "Tap Start to run the server"
	}

	private var statusSection: some View {
		Section {
			VStack(alignment: .leading, spacing: 16) {
				HStack(spacing: 14) {
					ZStack {
						Circle()
							.fill(statusColor.opacity(0.18))
							.frame(width: 64, height: 64)
						Circle()
							.fill(statusColor)
							.frame(width: 24, height: 24)
					}
					.accessibilityHidden(true)

					VStack(alignment: .leading, spacing: 4) {
						Text(statusTitle)
							.font(.title2.weight(.semibold))
						Text(statusDetail)
							.font(.subheadline)
							.foregroundColor(.secondary)
					}

					Spacer(minLength: 0)
				}

				if controller.isRunning {
					HStack {
						Label(controller.uptimeText.isEmpty ? "0s" : controller.uptimeText, systemImage: "clock")
						Spacer()
						Label("\(controller.clientCount) connected", systemImage: "person.2")
					}
					.font(.subheadline)
					.foregroundColor(.secondary)
				}

				if let tweak = controller.tweakStatus {
					Label(tweak.text, systemImage: tweak.symbol)
						.font(.subheadline)
						.foregroundColor(tweakColor(tweak))
				}

				if settings.run_remote, let socketText = controller.socketStatusText {
					Label(socketText, systemImage: "antenna.radiowaves.left.and.right")
						.font(.subheadline)
						.foregroundColor(.secondary)
				}

				if settings.run_remote, let remoteError = controller.remoteError {
					Label(remoteError, systemImage: "exclamationmark.triangle.fill")
						.font(.subheadline)
						.foregroundColor(.orange)
				}

				if let remoteId = controller.remoteId {
					HStack(spacing: 8) {
						Text("Remote id")
							.font(.subheadline)
							.foregroundColor(.secondary)
						Text(remoteId)
							.font(.system(.subheadline, design: .monospaced))
							.textSelection(.enabled)
						Spacer()
						Button(action: { copy(remoteId, key: "remote_id") }) {
							Image(systemName: copiedKey == "remote_id" ? "checkmark" : "doc.on.doc")
						}
						.buttonStyle(.borderless)
						.accessibilityLabel("Copy remote id")
					}
				}

				if let notice = controller.notice {
					Label(notice, systemImage: "checkmark.circle.fill")
						.font(.subheadline)
						.foregroundColor(.green)
				}

				Button(action: toggleServer) {
					HStack(spacing: 8) {
						if controller.isBusy {
							ProgressView()
								.progressViewStyle(.circular)
								.tint(.white)
						} else {
							Image(systemName: controller.isRunning ? "stop.fill" : "play.fill")
						}
						Text(controller.isRunning ? "Stop server" : "Start server")
							.fontWeight(.semibold)
					}
					.frame(maxWidth: .infinity)
					.padding(.vertical, 6)
				}
				.buttonStyle(.borderedProminent)
				.controlSize(.large)
				.tint(controller.isRunning ? .red : .green)
				.disabled(controller.isBusy || (!controller.isRunning && !controller.canStart))
			}
			.padding(.vertical, 8)
		}
	}

	private var addressesSection: some View {
		let entries = controller.addressEntries()

		return Section {
			if entries.isEmpty {
				Label("Connect to Wi-Fi to get an address", systemImage: "wifi.slash")
					.foregroundColor(.secondary)
			} else {
				ForEach(entries) { entry in
					addressRow(entry)
				}

				if let primary = entries.first {
					HStack {
						Spacer()
						QRCodeView(content: primary.url)
							.frame(width: 180, height: 180)
							.padding(12)
							.background(Color.white)
							.cornerRadius(12)
						Spacer()
					}
					.padding(.vertical, 8)
				}
			}
		} header: {
			Text("Addresses")
		} footer: {
			if !entries.isEmpty {
				Text("Scan the code or open an address on a device connected to the same network.")
			}
		}
	}

	private func addressRow(_ entry: AddressEntry) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			Label(entry.title, systemImage: entry.symbol)
				.font(.caption)
				.foregroundColor(.secondary)

			Text(entry.url)
				.font(.system(.callout, design: .monospaced))
				.textSelection(.enabled)

			HStack(spacing: 20) {
				Button(action: { copy(entry.url, key: entry.id) }) {
					Label(copiedKey == entry.id ? "Copied" : "Copy", systemImage: copiedKey == entry.id ? "checkmark" : "doc.on.doc")
				}

				Button(action: { open(entry.url) }) {
					Label("Open in Safari", systemImage: "safari")
				}
			}
			.buttonStyle(.borderless)
			.font(.footnote)
		}
		.padding(.vertical, 4)
	}

	private var serverSection: some View {
		Section {
			HStack {
				Label("Port", systemImage: "number")
				Spacer()
				TextField("8741", text: $portText)
					.keyboardType(.numberPad)
					.multilineTextAlignment(.trailing)
					.frame(maxWidth: 120)
			}

			HStack {
				Label("Password", systemImage: "lock")
				Spacer()
				Group {
					if showPassword {
						TextField("Password", text: $passwordText)
					} else {
						SecureField("Password", text: $passwordText)
					}
				}
				.multilineTextAlignment(.trailing)
				.textInputAutocapitalization(.never)
				.disableAutocorrection(true)
				.frame(maxWidth: 160)

				Button(action: { showPassword.toggle() }) {
					Image(systemName: showPassword ? "eye.slash" : "eye")
				}
				.buttonStyle(.borderless)
				.accessibilityLabel(showPassword ? "Hide password" : "Show password")
			}

			HStack {
				Label("WebSocket port", systemImage: "arrow.left.arrow.right")
				Spacer()
				TextField("8740", text: $socketPortText)
					.keyboardType(.numberPad)
					.multilineTextAlignment(.trailing)
					.frame(maxWidth: 120)
			}

			Toggle(isOn: tlsBinding) {
				Label("TLS (HTTPS)", systemImage: "lock.shield")
			}

			apiTokenRow
		} header: {
			Text("Server")
		} footer: {
			Text("Port, password and TLS changes apply the next time the server starts.")
		}
	}

	private var apiTokenRow: some View {
		HStack {
			Label {
				VStack(alignment: .leading, spacing: 2) {
					Text("API token")
					Text(settings.api_token_enabled ? maskedToken : "Token authentication is off")
						.font(.system(.footnote, design: .monospaced))
						.foregroundColor(.secondary)
				}
			} icon: {
				Image(systemName: "key")
			}

			Spacer()

			if settings.api_token_enabled {
				Button(action: { copy(settings.api_token, key: "api_token") }) {
					Image(systemName: copiedKey == "api_token" ? "checkmark" : "doc.on.doc")
				}
				.buttonStyle(.borderless)
				.accessibilityLabel("Copy API token")
			}

			Button(action: { showSettings = true }) {
				Image(systemName: "chevron.right")
					.font(.footnote.weight(.semibold))
					.foregroundColor(Color(.tertiaryLabel))
			}
			.buttonStyle(.borderless)
			.accessibilityLabel("Open API settings")
		}
	}

	private var customCSSSection: some View {
		Section {
			HStack {
				Label("Custom CSS", systemImage: "paintbrush")
				Spacer()
				Text(hasCustomCSS ? "Set" : "Not set")
					.foregroundColor(.secondary)
			}

			Button(action: presentCSSPicker) {
				Label("Import custom CSS…", systemImage: "square.and.arrow.down")
			}

			if hasCustomCSS {
				Button(role: .destructive, action: { showRemoveCSS = true }) {
					Label("Remove custom CSS", systemImage: "trash")
				}
				.confirmationDialog("Remove the custom stylesheet?", isPresented: $showRemoveCSS, titleVisibility: .visible) {
					Button("Remove", role: .destructive) {
						if !controller.removeCustomCSS() {
							alert = AlertMessage(title: "Remove failed", message: "The custom stylesheet could not be removed.")
						}
						hasCustomCSS = controller.hasCustomCSS()
					}
					Button("Cancel", role: .cancel) {}
				}
			}
		} header: {
			Text("Web interface")
		} footer: {
			Text("An imported stylesheet is served to the web interface on top of the selected theme.")
		}
	}

	private var aboutSection: some View {
		Section {
			if let url = ContentView.repoURL {
				Link(destination: url) {
					Label("SMServer on GitHub", systemImage: "link")
				}
			}

			if let url = ContentView.apiDocsURL {
				Link(destination: url) {
					Label("API documentation", systemImage: "doc.text")
				}
			}
		} footer: {
			Text("SMServer \(Const.appVersion())")
		}
	}

	private var maskedToken: String {
		let token = settings.api_token
		return String(repeating: "•", count: 8) + token.suffix(4)
	}

	private func tweakColor(_ status: TweakStatus) -> Color {
		switch status.level {
			case .connected: return .green
			case .reachable: return .orange
			case .unreachable: return .red
		}
	}

	private var tlsBinding: Binding<Bool> {
		Binding(get: {
			settings.is_secure
		}, set: { value in
			settings.is_secure = value
			UserDefaults.standard.setValue(value, forKey: "is_secure")
			Const.log("event=ui.settings.changed key=is_secure value=\(value)")
			revision += 1
			alert = AlertMessage(title: "Restart required", message: "Restart the app for the TLS change to take effect.")
		})
	}

	private func toggleServer() {
		hideKeyboard()
		syncFields()

		if controller.isRunning {
			controller.stop()
		} else {
			controller.startFromUser()
		}
	}

	private func syncFields() {
		portText = String(settings.server_port)
		socketPortText = String(settings.socket_port)
		passwordText = settings.password
		hasCustomCSS = controller.hasCustomCSS()
		revision += 1
	}

	private func commitPort(_ text: String) {
		let digits = ContentView.digits(text)
		if digits != text {
			portText = digits
			return
		}

		guard let value = Int(digits), ContentView.portRange.contains(value) else { return }
		guard value != settings.server_port else { return }

		if value == settings.socket_port {
			Const.log("event=ui.settings.port_conflict port=\(value)", warning: true)
			alert = AlertMessage(title: "Port conflict", message: "The server port must be different from the WebSocket port (\(settings.socket_port)).")
			return
		}

		settings.server_port = value
		UserDefaults.standard.setValue(value, forKey: "port")
		Const.log("event=ui.settings.changed key=port value=\(value)")
	}

	private func commitSocketPort(_ text: String) {
		let digits = ContentView.digits(text)
		if digits != text {
			socketPortText = digits
			return
		}

		guard let value = Int(digits), ContentView.portRange.contains(value) else { return }
		guard value != settings.socket_port else { return }

		if value == settings.server_port {
			Const.log("event=ui.settings.socket_port_conflict port=\(value)", warning: true)
			alert = AlertMessage(title: "Port conflict", message: "The WebSocket port must be different from the server port (\(settings.server_port)).")
			return
		}

		settings.socket_port = value
		UserDefaults.standard.setValue(value, forKey: "socket_port")
		Const.log("event=ui.settings.changed key=socket_port value=\(value)")
	}

	private func commitPassword(_ text: String) {
		guard text != settings.password else { return }

		settings.password = text
		UserDefaults.standard.setValue(text, forKey: "password")
		Const.log("event=ui.settings.changed key=password length=\(text.count)")
	}

	private func copy(_ text: String, key: String) {
		UIPasteboard.general.string = text
		Const.log("event=ui.copy key=\(key)")
		copiedKey = key

		DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
			if copiedKey == key {
				copiedKey = nil
			}
		}
	}

	private func open(_ string: String) {
		guard let url = URL(string: string) else {
			Const.log("event=ui.open_url_failed url=\(string)", warning: true)
			return
		}

		Const.log("event=ui.open_url url=\(string)")
		UIApplication.shared.open(url, options: [:], completionHandler: nil)
	}

	private func presentCSSPicker() {
		var types: [UTType] = [.text]
		if let css = UTType(filenameExtension: "css") {
			types.append(css)
		}

		let picker = DocPicker(contentTypes: types) { url in
			if !controller.importCustomCSS(from: url) {
				alert = AlertMessage(title: "Import failed", message: "The stylesheet could not be copied into the app.")
			}
			hasCustomCSS = controller.hasCustomCSS()
		}

		guard let presenter = ContentView.topViewController() else {
			Const.log("event=ui.css.picker_failed reason=no_presenter", warning: true)
			return
		}

		Const.log("event=ui.css.picker_opened")
		presenter.present(picker, animated: true)
	}

	private func hideKeyboard() {
		UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
	}

	private static func digits(_ text: String) -> String {
		return text.filter({ $0.isASCII && $0.isNumber })
	}

	private static func topViewController() -> UIViewController? {
		let scenes = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
		let windows = scenes.flatMap({ $0.windows })
		let window = windows.first(where: { $0.isKeyWindow }) ?? windows.first

		var top = window?.rootViewController
		while let presented = top?.presentedViewController {
			top = presented
		}
		return top
	}
}

final class DocPicker: UIDocumentPickerViewController, UIDocumentPickerDelegate {
	private let onPick: (URL) -> Void

	init(contentTypes: [UTType], onPick: @escaping (URL) -> Void) {
		self.onPick = onPick
		super.init(forOpeningContentTypes: contentTypes, asCopy: true)
		allowsMultipleSelection = false
		delegate = self
	}

	required init?(coder: NSCoder) {
		fatalError("init(coder:) has not been implemented")
	}

	func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
		guard let url = urls.first else {
			Const.log("event=ui.css.picker_empty", warning: true)
			return
		}
		onPick(url)
	}

	func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
		Const.log("event=ui.css.picker_cancelled")
	}
}
