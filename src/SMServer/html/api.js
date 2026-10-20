const SMServerLog = {
	debug: false,
	log(event, fields) {
		if (!this.debug) {
			return;
		}
		console.log("[smserver] event=" + event, fields === undefined ? {} : fields);
	},
	logError(event, error, fields) {
		console.error("[smserver] event=" + event, error === undefined ? null : error, fields === undefined ? {} : fields);
	}
};

function log(event, fields) {
	SMServerLog.log(event, fields);
}

function logError(event, error, fields) {
	SMServerLog.logError(event, error, fields);
}

const APPLE_EPOCH_OFFSET_SECONDS = 978307200;
const BIG_INTEGER_FIELD_PATTERN = /("(?:date|date_read|date_delivered|time_marker|next_before|newest_date|before|after)"\s*:\s*)(-?\d{15,})/g;

function parseJsonPreservingDates(text) {
	return JSON.parse(text.replace(BIG_INTEGER_FIELD_PATTERN, '$1"$2"'));
}

class SMServerAPIError extends Error {
	constructor(status, code, message, details) {
		super(message);
		this.name = "SMServerAPIError";
		this.status = status;
		this.code = code;
		this.details = details === undefined ? null : details;
	}
}

class SMServerAPI {
	constructor(config) {
		const source = config && typeof config === "object" ? config : {};
		this.base = typeof source.api_base === "string" && source.api_base ? source.api_base.replace(/\/+$/, "") : "/api/v1";
		this.token = typeof source.token === "string" ? source.token : "";
		this.onUnauthorized = null;
	}

	encodeSegment(value) {
		return encodeURIComponent(String(value));
	}

	encodeFilePath(path) {
		return String(path).split("/").map((segment) => encodeURIComponent(segment)).join("/");
	}

	buildQuery(query) {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query || {})) {
			if (value === undefined || value === null || value === "") {
				continue;
			}
			if (Array.isArray(value)) {
				value.forEach((item) => params.append(key, String(item)));
			} else {
				params.append(key, String(value));
			}
		}
		const serialized = params.toString();
		return serialized ? "?" + serialized : "";
	}

	buildUrl(path, query) {
		return this.base + path + this.buildQuery(query);
	}

	withToken(url) {
		if (!this.token || typeof url !== "string" || !url) {
			return url;
		}
		const separator = url.includes("?") ? "&" : "?";
		return url + separator + "token=" + encodeURIComponent(this.token);
	}

	mediaUrl(path, query) {
		return this.buildUrl(path, { ...(query || {}), token: this.token || undefined });
	}

	headers(extra) {
		const result = { Accept: "application/json", ...(extra || {}) };
		if (this.token) {
			result.Authorization = "Bearer " + this.token;
		}
		return result;
	}

	resolvePayload({ status, statusText, text, method, url }) {
		let payload = null;
		if (text) {
			try {
				payload = parseJsonPreservingDates(text);
			} catch (error) {
				payload = null;
			}
		}
		if (status === 401) {
			logError("api.unauthorized", null, { method, url });
			if (typeof this.onUnauthorized === "function") {
				this.onUnauthorized();
			}
			throw new SMServerAPIError(401, "unauthorized", "Authentication required", null);
		}
		if (status < 200 || status >= 300) {
			const errorBody = payload && typeof payload === "object" && payload.error ? payload.error : {};
			const message = errorBody.message || statusText || "Request failed (" + status + ")";
			logError("api.error", null, { method, url, status, code: errorBody.code || null, message });
			throw new SMServerAPIError(status, errorBody.code || "http_" + status, message, errorBody.details);
		}
		return payload;
	}

	async request(method, path, options) {
		const settings = options || {};
		const url = this.buildUrl(path, settings.query);
		const hasJson = settings.json !== undefined;
		const init = {
			method,
			headers: this.headers(hasJson ? { "Content-Type": "application/json" } : {}),
			credentials: "same-origin",
			cache: "no-store"
		};
		if (hasJson) {
			init.body = JSON.stringify(settings.json);
		}
		log("api.request", { method, url });
		let response;
		try {
			response = await fetch(url, init);
		} catch (error) {
			logError("api.network", error, { method, url });
			throw new SMServerAPIError(0, "network_error", "Could not reach the server", null);
		}
		const text = await response.text();
		return this.resolvePayload({ status: response.status, statusText: response.statusText, text, method, url });
	}

	upload(path, { body, contentType, onProgress }) {
		const url = this.buildUrl(path);
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open("POST", url);
			xhr.responseType = "text";
			xhr.setRequestHeader("Accept", "application/json");
			if (this.token) {
				xhr.setRequestHeader("Authorization", "Bearer " + this.token);
			}
			if (contentType) {
				xhr.setRequestHeader("Content-Type", contentType);
			}
			if (typeof onProgress === "function" && xhr.upload) {
				xhr.upload.addEventListener("progress", (event) => {
					if (event.lengthComputable && event.total > 0) {
						onProgress(event.loaded / event.total);
					}
				});
			}
			xhr.addEventListener("load", () => {
				try {
					resolve(this.resolvePayload({ status: xhr.status, statusText: xhr.statusText, text: xhr.responseText, method: "POST", url }));
				} catch (error) {
					reject(error);
				}
			});
			xhr.addEventListener("error", () => {
				logError("api.network", null, { method: "POST", url });
				reject(new SMServerAPIError(0, "network_error", "Could not reach the server", null));
			});
			xhr.addEventListener("abort", () => {
				reject(new SMServerAPIError(0, "aborted", "Upload cancelled", null));
			});
			xhr.send(body);
		});
	}

	getHealth() {
		return this.request("GET", "/health");
	}

	getServer() {
		return this.request("GET", "/server");
	}

	login(password) {
		return this.request("POST", "/auth/login", { json: { password } });
	}

	logout(all) {
		return this.request("POST", "/auth/logout", { query: { all: all ? "true" : undefined }, json: { all: Boolean(all) } });
	}

	getSession() {
		return this.request("GET", "/auth/session");
	}

	getChats({ limit, offset } = {}) {
		return this.request("GET", "/chats", { query: { limit, offset } });
	}

	getPinnedChats() {
		return this.request("GET", "/chats/pinned");
	}

	getChat(chatId) {
		return this.request("GET", "/chats/" + this.encodeSegment(chatId));
	}

	deleteChat(chatId) {
		return this.request("DELETE", "/chats/" + this.encodeSegment(chatId));
	}

	getMessages(chatId, { limit, offset, before, after, from, markRead } = {}) {
		const query = { limit, offset, before, after, from };
		if (markRead !== undefined && markRead !== null) {
			query.mark_read = markRead ? "true" : "false";
		}
		return this.request("GET", "/chats/" + this.encodeSegment(chatId) + "/messages", { query });
	}

	markChatRead(chatId) {
		return this.request("POST", "/chats/" + this.encodeSegment(chatId) + "/read", { json: {} });
	}

	setTyping(chatId, active) {
		return this.request("POST", "/chats/" + this.encodeSegment(chatId) + "/typing", { json: { active: Boolean(active) } });
	}

	buildMessageBody(fields, files) {
		const photos = Array.isArray(fields.photos) ? fields.photos.filter(Boolean) : [];
		const fileList = Array.isArray(files) ? files : [];
		if (fileList.length === 0) {
			const json = {};
			if (fields.chat_id) {
				json.chat_id = fields.chat_id;
			}
			if (fields.text) {
				json.text = fields.text;
			}
			if (fields.subject) {
				json.subject = fields.subject;
			}
			if (photos.length > 0) {
				json.photos = photos;
			}
			return { body: JSON.stringify(json), contentType: "application/json" };
		}
		const form = new FormData();
		if (fields.chat_id) {
			form.append("chat_id", fields.chat_id);
		}
		if (fields.text) {
			form.append("text", fields.text);
		}
		if (fields.subject) {
			form.append("subject", fields.subject);
		}
		photos.forEach((photo) => form.append("photos", photo));
		fileList.forEach((file) => form.append("attachments", file, file.name));
		return { body: form, contentType: null };
	}

	sendMessage(chatId, { text, subject, photos, files }, onProgress) {
		const { body, contentType } = this.buildMessageBody({ text, subject, photos }, files);
		return this.upload("/chats/" + this.encodeSegment(chatId) + "/messages", { body, contentType, onProgress });
	}

	sendMessageToAddress(chatId, { text, subject, photos, files }, onProgress) {
		const { body, contentType } = this.buildMessageBody({ chat_id: chatId, text, subject, photos }, files);
		return this.upload("/messages", { body, contentType, onProgress });
	}

	getMessage(guid) {
		return this.request("GET", "/messages/" + this.encodeSegment(guid));
	}

	deleteMessage(guid) {
		return this.request("DELETE", "/messages/" + this.encodeSegment(guid));
	}

	sendTapback(guid, type, remove) {
		return this.request("POST", "/messages/" + this.encodeSegment(guid) + "/tapback", { json: { type, remove: Boolean(remove) } });
	}

	search(query, { caseSensitive, bridgeGaps, group } = {}) {
		return this.request("GET", "/search", {
			query: {
				q: query,
				case_sensitive: caseSensitive === undefined ? undefined : (caseSensitive ? "true" : "false"),
				bridge_gaps: bridgeGaps === undefined ? undefined : (bridgeGaps ? "true" : "false"),
				group
			}
		});
	}

	matchContacts(query, type) {
		return this.request("GET", "/contacts/match", { query: { q: query, type } });
	}

	getContact(chatId) {
		return this.request("GET", "/contacts/" + this.encodeSegment(chatId));
	}

	contactPhotoUrl(chatId, fallback) {
		return this.mediaUrl("/contacts/" + this.encodeSegment(chatId) + "/photo", { fallback: fallback ? "1" : undefined });
	}

	attachmentUrl(filename, download) {
		return this.mediaUrl("/attachments/" + this.encodeFilePath(filename), { download: download ? "1" : undefined });
	}

	getPhotos({ limit, offset, recent } = {}) {
		return this.request("GET", "/photos", { query: { limit, offset, recent: recent === undefined ? undefined : (recent ? "true" : "false") } });
	}

	photoUrl(path) {
		return this.mediaUrl("/photos/" + this.encodeFilePath(path));
	}
}

class SMServerSocket {
	constructor({ url, pingInterval, minDelay, maxDelay }) {
		this.url = url;
		this.pingInterval = pingInterval || 25000;
		this.minDelay = minDelay || 1000;
		this.maxDelay = maxDelay || 30000;
		this.handlers = new Map();
		this.socket = null;
		this.attempt = 0;
		this.everConnected = false;
		this.closedByUser = false;
		this.reconnectTimer = null;
		this.pingTimer = null;
		this.pingCounter = 0;
		this.openedAt = null;
	}

	get connected() {
		return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
	}

	on(event, handler) {
		if (!this.handlers.has(event)) {
			this.handlers.set(event, new Set());
		}
		this.handlers.get(event).add(handler);
		return () => this.off(event, handler);
	}

	off(event, handler) {
		const set = this.handlers.get(event);
		if (set) {
			set.delete(handler);
		}
	}

	emit(event, data, frame) {
		const set = this.handlers.get(event);
		if (!set) {
			return;
		}
		for (const handler of set) {
			try {
				handler(data, frame);
			} catch (error) {
				logError("ws.handler", error, { event });
			}
		}
	}

	connect() {
		if (this.closedByUser) {
			return;
		}
		this.clearReconnectTimer();
		if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
			return;
		}
		log("ws.connect", { url: this.url, attempt: this.attempt, everConnected: this.everConnected });
		let socket;
		try {
			socket = new WebSocket(this.url);
		} catch (error) {
			logError("ws.create", error, { url: this.url });
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;
		socket.addEventListener("open", () => this.handleOpen(socket));
		socket.addEventListener("message", (event) => this.handleMessage(event));
		socket.addEventListener("error", () => this.handleError(socket));
		socket.addEventListener("close", (event) => this.handleClose(socket, event));
	}

	reconnectNow() {
		if (this.closedByUser || this.connected) {
			return;
		}
		this.clearReconnectTimer();
		this.attempt = 0;
		this.connect();
	}

	close() {
		this.closedByUser = true;
		this.clearReconnectTimer();
		this.stopPing();
		if (this.socket) {
			this.socket.close();
		}
	}

	handleOpen(socket) {
		if (socket !== this.socket) {
			return;
		}
		const reconnected = this.everConnected;
		this.everConnected = true;
		this.attempt = 0;
		this.openedAt = Date.now();
		log("ws.open", { reconnected });
		this.startPing();
		this.emit("open", { reconnected });
	}

	handleMessage(event) {
		let frame;
		try {
			frame = parseJsonPreservingDates(event.data);
		} catch (error) {
			logError("ws.parse", error, { length: typeof event.data === "string" ? event.data.length : 0 });
			return;
		}
		if (!frame || typeof frame !== "object" || typeof frame.command !== "string") {
			log("ws.frame.ignored", { frame });
			return;
		}
		log("ws.frame", { command: frame.command });
		this.emit("message", frame.data, frame);
		this.emit(frame.command, frame.data === undefined ? null : frame.data, frame);
	}

	handleError(socket) {
		if (socket !== this.socket) {
			return;
		}
		logError("ws.error", null, { url: this.url, everConnected: this.everConnected, attempt: this.attempt });
		this.emit("error", { everConnected: this.everConnected, attempt: this.attempt });
	}

	handleClose(socket, event) {
		if (socket !== this.socket) {
			return;
		}
		this.stopPing();
		this.socket = null;
		const wasOpen = this.openedAt !== null;
		this.openedAt = null;
		log("ws.close", { code: event.code, reason: event.reason, wasOpen, byUser: this.closedByUser });
		this.emit("close", { code: event.code, reason: event.reason, wasOpen, everConnected: this.everConnected });
		this.scheduleReconnect();
	}

	scheduleReconnect() {
		if (this.closedByUser || this.reconnectTimer !== null) {
			return;
		}
		const exponential = Math.min(this.maxDelay, this.minDelay * Math.pow(2, this.attempt));
		const jitter = 0.7 + Math.random() * 0.6;
		const delay = Math.round(Math.min(this.maxDelay, exponential * jitter));
		this.attempt += 1;
		log("ws.reconnect.scheduled", { attempt: this.attempt, delay });
		this.emit("reconnecting", { attempt: this.attempt, delay, everConnected: this.everConnected });
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	clearReconnectTimer() {
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	startPing() {
		this.stopPing();
		this.pingTimer = setInterval(() => this.ping(), this.pingInterval);
	}

	stopPing() {
		if (this.pingTimer !== null) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
	}

	ping() {
		this.pingCounter += 1;
		this.send("ping", undefined, "ping-" + this.pingCounter);
	}

	send(command, params, id) {
		if (!this.connected) {
			log("ws.send.skipped", { command });
			return false;
		}
		const frame = { command };
		if (params !== undefined) {
			frame.params = params;
		}
		if (id !== undefined) {
			frame.id = id;
		}
		try {
			this.socket.send(JSON.stringify(frame));
			return true;
		} catch (error) {
			logError("ws.send", error, { command });
			return false;
		}
	}
}

window.SMServerLog = SMServerLog;
window.SMServerAPI = SMServerAPI;
window.SMServerAPIError = SMServerAPIError;
window.SMServerSocket = SMServerSocket;
window.parseJsonPreservingDates = parseJsonPreservingDates;
window.APPLE_EPOCH_OFFSET_SECONDS = APPLE_EPOCH_OFFSET_SECONDS;
