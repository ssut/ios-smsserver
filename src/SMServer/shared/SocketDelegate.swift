import Foundation
import Telegraph

class SocketDelegate : ServerWebSocketDelegate {
	let settings = Settings.shared()
	var server: Server? = nil
	var watcher: IPCTextWatcher? = nil
	var verify_auth: (String, String?) -> Bool = { _, _ in return false }

	func startServer(port: Int) {
		let cert_url = Bundle.main.url(forResource: "cert", withExtension: "der")
		let identity_url = Bundle.main.url(forResource: "identity", withExtension: "pfx")

		if settings.is_secure,
		   let cert_url = cert_url,
		   let identity_url = identity_url,
		   let cert = Certificate(derURL: cert_url),
		   let identity = CertificateIdentity(p12URL: identity_url, passphrase: settings.cert_pass) {
			self.server = Server(identity: identity, caCertificates: [cert])
		} else {
			if settings.is_secure {
				Const.log("event=socket.tls.unavailable fallback=plain", warning: true)
			}
			self.server = Server()
		}

		server?.webSocketDelegate = self

		do {
			try server?.start(port: port)
			Const.log("event=socket.started port=\(port) secure=\(settings.is_secure)")
		} catch {
			Const.log("event=socket.start.failed port=\(port) error=\(error)", warning: true)
		}
	}

	func stopServer() {
		if let sock = server {
			for s in sock.webSockets {
				s.close(immediately: false)
			}
		}

		server?.stop()
		Const.log("event=socket.stopped")
	}

	func broadcast(_ message: SocketMessage) {
		let json = Const.encodeToJson(object: message.json())
		guard !json.isEmpty, let sock = server else { return }

		for client in sock.webSockets {
			client.send(text: json)
		}
	}

	func send(_ message: SocketMessage, to client: WebSocket) {
		let json = Const.encodeToJson(object: message.json())
		guard !json.isEmpty else { return }
		client.send(text: json)
	}

	func sendTyping(_ chat: String, typing: Bool = true) {
		broadcast(SocketMessage.typing(chat, active: typing))
	}

	@objc func sendNewBatteryFromNotification(notification: NSNotification) {
		sendNewBattery()
	}

	func batteryMessage() -> SocketMessage {
		let percent = Const.getBatteryLevel()
		let charging_state = Const.getBatteryState()
		return SocketMessage.battery(percent, charging: charging_state == .charging || charging_state == .full)
	}

	func sendNewBattery() {
		broadcast(batteryMessage())
	}

	func sendNewText(info: [String:Any]) {
		broadcast(SocketMessage.newMessage(info))
	}

	func sendTextRead(_ guid: String, date: String, dateRead: Int) {
		let json: [String: Any] = [
			"guid": guid,
			"date": date,
			"date_read": dateRead,
			"date_read_unix": dateRead > 0 ? Const.appleToUnix(Double(dateRead)) : 0,
		]

		broadcast(SocketMessage(nil, command: .ReadMessage, data: json, incoming: false))
	}

	func helloMessage() -> SocketMessage {
		let data: [String: Any] = [
			"name": Const.api_product_name,
			"version": Const.appVersion(),
			"api_version": Const.api_v1_version,
			"server_time": Const.unixNow(),
		]
		return SocketMessage(nil, command: .Hello, data: data, incoming: false)
	}

	static func handshakeToken(_ handshake: HTTPRequest) -> String? {
		if let items = handshake.uri.queryItems {
			for item in items where item.name == Const.api_token_query_key {
				if let value = item.value, !value.isEmpty {
					return value
				}
			}
		}

		if let header = handshake.headers[Const.api_auth_header] {
			let trimmed = header.trimmingCharacters(in: .whitespaces)
			if trimmed.lowercased().hasPrefix(Const.api_bearer_prefix.lowercased()) {
				let token = String(trimmed.dropFirst(Const.api_bearer_prefix.count)).trimmingCharacters(in: .whitespaces)
				if !token.isEmpty {
					return token
				}
			}
		}

		return nil
	}

	func server(_ server: Server, webSocketDidConnect webSocket: WebSocket, handshake: HTTPRequest) {
		let ip = webSocket.remoteEndpoint?.host ?? ""
		let token = SocketDelegate.handshakeToken(handshake)

		if !verify_auth(ip, token) {
			Const.log("event=socket.connect.rejected ip=\(ip) has_token=\(token != nil)")
			webSocket.close(immediately: true)
			return
		}

		Const.log("event=socket.connect.accepted ip=\(ip) has_token=\(token != nil) clients=\(server.webSocketCount)")

		send(helloMessage(), to: webSocket)
		send(batteryMessage(), to: webSocket)
	}

	func server(_ server: Server, webSocketDidDisconnect webSocket: WebSocket, error: Error?) {
		Const.log("event=socket.disconnected ip=\(webSocket.remoteEndpoint?.host ?? "") error=\(error.map({ "\($0)" }) ?? "none") clients=\(server.webSocketCount)")
	}

	func server(_ server: Server, webSocket: WebSocket, didReceiveMessage message: WebSocketMessage) {
		switch message.payload {
			case .text(let text):
				handleText(text, from: webSocket)
			default:
				if message.opcode == WebSocketOpcode.binaryFrame {
					Const.log("event=socket.message.unsupported opcode=binary")
				}
		}
	}

	func handleText(_ text: String, from client: WebSocket) {
		let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

		if trimmed.hasPrefix("{") {
			guard let object = Const.jsonToDict(string: trimmed) else {
				Const.log("event=socket.message.invalid_json length=\(trimmed.count)")
				return
			}
			handleCommand(SocketMessage(object, incoming: true), from: client)
			return
		}

		let parts = trimmed.split(separator: ":", maxSplits: 1).map({ String($0) })
		guard parts.count == 2 else {
			Const.log("event=socket.message.unknown length=\(trimmed.count)")
			return
		}

		if (parts[0] == "typing" || parts[0] == "idle") && settings.send_typing {
			Const.log("event=socket.typing.legacy chat=\(parts[1]) active=\(parts[0] == "typing")")
			ServerDelegate.sender.sendTyping(parts[0] == "typing", forChat: parts[1])
		}
	}

	func handleCommand(_ message: SocketMessage, from client: WebSocket) {
		let params = message.data as? [String: Any] ?? [String: Any]()

		switch message.command {
			case .SendTyping:
				let chat = params["chat"] as? String ?? ""
				let active = (params["active"] as? Bool) ?? ((params["active"] as? NSNumber)?.boolValue ?? true)
				guard !chat.isEmpty else { return }
				guard settings.send_typing else {
					Const.log("event=socket.typing.disabled chat=\(chat)")
					return
				}
				Const.log("event=socket.typing.send chat=\(chat) active=\(active)")
				ServerDelegate.sender.sendTyping(active, forChat: chat)

			case .Ping:
				let pong = SocketMessage(message.id, command: .Pong, data: ["server_time": Const.unixNow()], incoming: false)
				send(pong, to: client)

			default:
				Const.log("event=socket.command.unhandled command=\(message.command)")
		}
	}
}
