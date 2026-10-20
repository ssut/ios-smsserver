import SwiftUI
import UIKit

struct SettingsView: View {
	@Environment(\.dismiss) private var dismiss
	private let settings = Settings.shared()

	@State private var revision: Int = 0
	@State private var alert: AlertMessage? = nil
	@State private var showToken: Bool = false
	@State private var copiedToken: Bool = false
	@State private var showRegenerateConfirm: Bool = false
	@State private var showResetConfirm: Bool = false
	@State private var showShareSheet: Bool = false
	@State private var chatsText: String = String(Settings.shared().default_num_chats)
	@State private var messagesText: String = String(Settings.shared().default_num_messages)
	@State private var photosText: String = String(Settings.shared().default_num_photos)

	private static let apiDocsURL = URL(string: "https://github.com/iandwelker/smserver/blob/master/docs/API/v1.md")
	private static let donateURL = URL(string: "https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=K3A6WVKT54PH4&item_name=Tweak%2FApplication+Development&currency_code=USD")
	private static let maxCount: UInt = 100000

	var body: some View {
		NavigationView {
			Form {
				loadingSection
				themeSection
				webInterfaceSection
				apiSection
				remoteSection
				advancedSection
				aboutSection
			}
			.navigationTitle("Settings")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .navigationBarTrailing) {
					Button("Done") {
						dismiss()
					}
				}

				ToolbarItemGroup(placement: .keyboard) {
					Spacer()
					Button("Done", action: hideKeyboard)
				}
			}
			.alert(item: $alert) { message in
				Alert(title: Text(message.title), message: Text(message.message), dismissButton: .default(Text("OK")))
			}
			.sheet(isPresented: $showShareSheet) {
				ShareSheet(activityItems: [Bundle.main.url(forResource: "cert", withExtension: "der")].compactMap({ $0 }))
			}
			.onChange(of: chatsText) { commitCount($0, key: "num_chats", field: $chatsText) { settings.default_num_chats = $0 } }
			.onChange(of: messagesText) { commitCount($0, key: "num_messages", field: $messagesText) { settings.default_num_messages = $0 } }
			.onChange(of: photosText) { commitCount($0, key: "num_photos", field: $photosText) { settings.default_num_photos = $0 } }
		}
		.navigationViewStyle(.stack)
	}

	private var loadingSection: some View {
		Section {
			countRow("Chats", symbol: "bubble.left.and.bubble.right", text: $chatsText)
			countRow("Messages", symbol: "text.bubble", text: $messagesText)
			countRow("Photos", symbol: "photo.on.rectangle", text: $photosText)
		} header: {
			Text("Loading")
		} footer: {
			Text("How many items the web interface loads at first when a request does not say otherwise.")
		}
	}

	private func countRow(_ title: String, symbol: String, text: Binding<String>) -> some View {
		HStack {
			Label(title, systemImage: symbol)
			Spacer()
			TextField("0", text: text)
				.keyboardType(.numberPad)
				.multilineTextAlignment(.trailing)
				.frame(maxWidth: 100)
		}
	}

	private var themeSection: some View {
		Section {
			Picker("Theme", selection: themeBinding) {
				Text("Dark").tag("dark")
				Text("Light").tag("light")
				Text("Nord").tag("nord")
			}
			.pickerStyle(.segmented)
		} header: {
			Text("Theme")
		}
	}

	private var webInterfaceSection: some View {
		Section {
			Toggle(isOn: boolSetting(\.subjects_enabled, key: "subjects_enabled")) {
				Label("Subject line", systemImage: "text.alignleft")
			}

			Toggle(isOn: boolSetting(\.send_typing, key: "send_typing")) {
				Label("Send typing indicators", systemImage: "ellipsis.bubble")
			}

			Toggle(isOn: boolSetting(\.mark_when_read, key: "mark_when_read")) {
				Label("Automatically mark as read", systemImage: "envelope.open")
			}

			Toggle(isOn: boolSetting(\.require_authentication, key: "require_auth")) {
				Label("Require authentication", systemImage: "lock")
			}

			Toggle(isOn: boolSetting(\.combine_contacts, key: "combine_contacts")) {
				Label("Merge contact addresses", systemImage: "person.2")
			}

			Toggle(isOn: socketProxyBinding) {
				Label("WebSocket proxy compatibility", systemImage: "arrow.triangle.branch")
			}

			if settings.socket_subdirectory != nil {
				HStack {
					Label("Subdirectory", systemImage: "folder")
					Spacer()
					TextField("/sms/socket", text: socketSubdirectoryBinding)
						.keyboardType(.URL)
						.textInputAutocapitalization(.never)
						.disableAutocorrection(true)
						.multilineTextAlignment(.trailing)
				}
			}
		} header: {
			Text("Web interface")
		} footer: {
			Text("Merging contact addresses is experimental. Enable proxy compatibility only when SMServer runs behind a reverse proxy, and enter the path the WebSocket is reachable at.")
		}
	}

	private var apiSection: some View {
		Section {
			Toggle(isOn: boolSetting(\.api_token_enabled, key: "api_token_enabled")) {
				Label("Bearer token authentication", systemImage: "key")
			}

			VStack(alignment: .leading, spacing: 8) {
				HStack {
					Text("API token")
					Spacer()
					Button(action: { showToken.toggle() }) {
						Image(systemName: showToken ? "eye.slash" : "eye")
					}
					.buttonStyle(.borderless)
					.accessibilityLabel(showToken ? "Hide token" : "Show token")
				}

				if showToken {
					Text(settings.api_token)
						.font(.system(.footnote, design: .monospaced))
						.textSelection(.enabled)
				} else {
					Text(maskedToken)
						.font(.system(.footnote, design: .monospaced))
						.foregroundColor(.secondary)
				}
			}
			.padding(.vertical, 2)

			Button(action: copyToken) {
				Label(copiedToken ? "Copied" : "Copy token", systemImage: copiedToken ? "checkmark" : "doc.on.doc")
			}

			Button(role: .destructive, action: { showRegenerateConfirm = true }) {
				Label("Regenerate token", systemImage: "arrow.triangle.2.circlepath")
			}
			.confirmationDialog("Regenerate the API token?", isPresented: $showRegenerateConfirm, titleVisibility: .visible) {
				Button("Regenerate", role: .destructive, action: regenerateToken)
				Button("Cancel", role: .cancel) {}
			} message: {
				Text("Clients that use the current token will stop working until they are updated.")
			}

			Toggle(isOn: boolSetting(\.cors_enabled, key: "cors_enabled")) {
				Label("Allow cross-origin requests", systemImage: "globe")
			}

			if settings.cors_enabled {
				VStack(alignment: .leading, spacing: 6) {
					Text("Allowed origins")
						.font(.subheadline)
						.foregroundColor(.secondary)
					TextField("* or https://app.example.com, https://other", text: stringSetting(\.cors_origins, key: "cors_origins"))
						.keyboardType(.URL)
						.textInputAutocapitalization(.never)
						.disableAutocorrection(true)
						.font(.system(.body, design: .monospaced))
				}
				.padding(.vertical, 2)
			}
		} header: {
			Text("API")
		} footer: {
			Text("Send the token as an Authorization: Bearer header or a token query parameter on /api/v1 requests. Separate several CORS origins with commas.")
		}
	}

	private var remoteSection: some View {
		Section {
			Toggle(isOn: boolSetting(\.run_remote, key: "run_remote")) {
				Label("Enable remote connection", systemImage: "antenna.radiowaves.left.and.right")
			}

			if settings.run_remote {
				VStack(alignment: .leading, spacing: 6) {
					Text("Remote address")
						.font(.subheadline)
						.foregroundColor(.secondary)
					TextField("example.com:8741/subdir", text: stringSetting(\.remote_addr, key: "remote_addr"))
						.keyboardType(.URL)
						.textInputAutocapitalization(.never)
						.disableAutocorrection(true)
				}
				.padding(.vertical, 2)

				Toggle(isOn: boolSetting(\.remote_secure, key: "remote_secure")) {
					Label("Connect securely", systemImage: "lock.shield")
				}

				if settings.remote_secure {
					Toggle(isOn: boolSetting(\.remote_bypass_cert, key: "remote_bypass_cert")) {
						Label("Bypass certificate checks", systemImage: "exclamationmark.shield")
					}
				}
			}
		} header: {
			Text("Remote connection")
		} footer: {
			Text("Enter the address without a protocol. Changes apply the next time the server starts.")
		}
	}

	private var advancedSection: some View {
		Section {
			Toggle(isOn: boolSetting(\.debug, key: "debug")) {
				Label("Debug logging", systemImage: "ladybug")
			}

			Toggle(isOn: boolSetting(\.background, key: "enable_backgrounding")) {
				Label("Keep running in background", systemImage: "moon")
			}

			Toggle(isOn: tlsBinding) {
				Label("TLS (HTTPS)", systemImage: "lock.shield")
			}

			Toggle(isOn: boolSetting(\.override_no_wifi, key: "override_no_wifi")) {
				Label("Allow operation off Wi-Fi", systemImage: "wifi.slash")
			}

			Toggle(isOn: boolSetting(\.start_on_load, key: "start_on_load")) {
				Label("Start server on launch", systemImage: "play.circle")
			}

			Toggle(isOn: boolSetting(\.reload_on_network_change, key: "reload_on_network_change")) {
				Label("Restart server on network change", systemImage: "arrow.triangle.2.circlepath")
			}
		} header: {
			Text("Advanced")
		} footer: {
			Text("Without backgrounding the app exits about a minute after it leaves the foreground.")
		}
	}

	private var aboutSection: some View {
		Section {
			if let url = SettingsView.apiDocsURL {
				Link(destination: url) {
					Label("View API documentation", systemImage: "doc.text")
				}
			}

			if let url = SettingsView.donateURL {
				Link(destination: url) {
					Label("Donate to support SMServer", systemImage: "heart")
				}
			}

			Button(action: exportCertificate) {
				Label("Export TLS certificate", systemImage: "scroll")
			}

			Button(role: .destructive, action: { showResetConfirm = true }) {
				Label("Reset settings to default", systemImage: "arrow.counterclockwise")
			}
			.confirmationDialog("Reset every setting to its default?", isPresented: $showResetConfirm, titleVisibility: .visible) {
				Button("Reset", role: .destructive, action: resetDefaults)
				Button("Cancel", role: .cancel) {}
			} message: {
				Text("This also clears the saved password, API token and authenticated devices.")
			}

			HStack {
				Label("Version", systemImage: "info.circle")
				Spacer()
				Text(Const.appVersion())
					.foregroundColor(.secondary)
			}
		} header: {
			Text("About")
		}
	}

	private var maskedToken: String {
		return String(repeating: "•", count: 8) + settings.api_token.suffix(4)
	}

	private var themeBinding: Binding<String> {
		Binding(get: {
			settings.themeName()
		}, set: { name in
			settings.setTheme(name)
			Const.log("event=ui.settings.changed key=theme value=\(name)")
			revision += 1
		})
	}

	private var socketProxyBinding: Binding<Bool> {
		Binding(get: {
			settings.socket_subdirectory != nil
		}, set: { enabled in
			settings.socket_subdirectory = enabled ? "" : nil
			UserDefaults.standard.setValue(enabled ? "" : nil, forKey: "socket_subdirectory")
			Const.log("event=ui.settings.changed key=socket_subdirectory enabled=\(enabled)")
			revision += 1
		})
	}

	private var socketSubdirectoryBinding: Binding<String> {
		Binding(get: {
			settings.socket_subdirectory ?? ""
		}, set: { value in
			settings.socket_subdirectory = value
			UserDefaults.standard.setValue(value, forKey: "socket_subdirectory")
			Const.log("event=ui.settings.changed key=socket_subdirectory value=\(value)")
			revision += 1
		})
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

	private func boolSetting(_ keyPath: ReferenceWritableKeyPath<Settings, Bool>, key: String) -> Binding<Bool> {
		Binding(get: {
			settings[keyPath: keyPath]
		}, set: { value in
			settings[keyPath: keyPath] = value
			UserDefaults.standard.setValue(value, forKey: key)
			Const.log("event=ui.settings.changed key=\(key) value=\(value)")
			revision += 1
		})
	}

	private func stringSetting(_ keyPath: ReferenceWritableKeyPath<Settings, String>, key: String) -> Binding<String> {
		Binding(get: {
			settings[keyPath: keyPath]
		}, set: { value in
			settings[keyPath: keyPath] = value
			UserDefaults.standard.setValue(value, forKey: key)
			Const.log("event=ui.settings.changed key=\(key) length=\(value.count)")
			revision += 1
		})
	}

	private func commitCount(_ text: String, key: String, field: Binding<String>, apply: (UInt) -> Void) {
		let digits = text.filter({ $0.isASCII && $0.isNumber })
		if digits != text {
			field.wrappedValue = digits
			return
		}

		guard let value = UInt(digits), value > 0, value <= SettingsView.maxCount else { return }

		apply(value)
		UserDefaults.standard.setValue(Int(value), forKey: key)
		Const.log("event=ui.settings.changed key=\(key) value=\(value)")
	}

	private func copyToken() {
		UIPasteboard.general.string = settings.api_token
		Const.log("event=ui.settings.api_token.copied")
		copiedToken = true

		DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
			copiedToken = false
		}
	}

	private func regenerateToken() {
		settings.regenerateApiToken()
		Const.log("event=ui.settings.api_token.regenerated")
		revision += 1
	}

	private func exportCertificate() {
		guard Bundle.main.url(forResource: "cert", withExtension: "der") != nil else {
			Const.log("event=ui.settings.cert_export_failed reason=missing_bundle_resource", warning: true)
			alert = AlertMessage(title: "Certificate not found", message: "cert.der is not bundled with this build.")
			return
		}

		Const.log("event=ui.settings.cert_export")
		showShareSheet = true
	}

	private func resetDefaults() {
		guard let domain = Bundle.main.bundleIdentifier else {
			Const.log("event=ui.settings.reset_failed reason=no_bundle_identifier", warning: true)
			alert = AlertMessage(title: "Reset failed", message: "The app bundle identifier is unavailable.")
			return
		}

		UserDefaults.standard.removePersistentDomain(forName: domain)

		let fresh = Settings()
		settings.server_port = fresh.server_port
		settings.socket_port = fresh.socket_port
		settings.password = fresh.password
		settings.socket_subdirectory = fresh.socket_subdirectory
		settings.default_num_chats = fresh.default_num_chats
		settings.default_num_messages = fresh.default_num_messages
		settings.default_num_photos = fresh.default_num_photos
		settings.debug = fresh.debug
		settings.require_authentication = fresh.require_authentication
		settings.background = fresh.background
		settings.light_theme = fresh.light_theme
		settings.nord_theme = fresh.nord_theme
		settings.is_secure = fresh.is_secure
		settings.authenticated_addresses = fresh.authenticated_addresses
		settings.mark_when_read = fresh.mark_when_read
		settings.override_no_wifi = fresh.override_no_wifi
		settings.subjects_enabled = fresh.subjects_enabled
		settings.send_typing = fresh.send_typing
		settings.combine_contacts = fresh.combine_contacts
		settings.start_on_load = fresh.start_on_load
		settings.reload_on_network_change = fresh.reload_on_network_change
		settings.run_web_interface = fresh.run_web_interface
		settings.run_remote = fresh.run_remote
		settings.remote_addr = fresh.remote_addr
		settings.remote_secure = fresh.remote_secure
		settings.remote_bypass_cert = fresh.remote_bypass_cert
		settings.api_token = fresh.api_token
		settings.api_token_enabled = fresh.api_token_enabled
		settings.cors_enabled = fresh.cors_enabled
		settings.cors_origins = fresh.cors_origins
		settings.session_ttl_seconds = fresh.session_ttl_seconds

		chatsText = String(settings.default_num_chats)
		messagesText = String(settings.default_num_messages)
		photosText = String(settings.default_num_photos)
		showToken = false
		revision += 1

		Const.log("event=ui.settings.reset")
		alert = AlertMessage(title: "Settings reset", message: "Defaults were restored. Restart the app so the server picks up every change.")
	}

	private func hideKeyboard() {
		UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
	}
}

struct ShareSheet: UIViewControllerRepresentable {
	let activityItems: [Any]

	func makeUIViewController(context: Context) -> UIActivityViewController {
		return UIActivityViewController(activityItems: activityItems, applicationActivities: nil)
	}

	func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
