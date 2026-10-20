const DEFAULT_CONFIG = Object.freeze({
	api_base: "/api/v1",
	static_base: "/static",
	token: "",
	socket_port: 8740,
	socket_subdirectory: null,
	secure: location.protocol === "https:",
	theme: "dark",
	subjects_enabled: false,
	send_typing: true,
	mark_when_read: true,
	debug: false,
	version: "",
	defaults: Object.freeze({ chats: 40, messages: 100, photos: 40 }),
	custom_css: false
});

const THEMES = ["system", "dark", "light", "nord"];
const THEME_STORAGE_KEY = "smserver.theme";
const URL_BALLOON_ID = "com.apple.messages.URLBalloonProvider";
const DIGITAL_TOUCH_BALLOON_ID = "com.apple.DigitalTouchBalloonProvider";
const HANDWRITING_BALLOON_ID = "com.apple.Handwriting.HandwritingProvider";
const TAPBACK_ICONS = ["heart", "thumbs-up", "thumbs-down", "laugh", "exclaim", "question"];
const TAPBACK_LABELS = ["Love", "Like", "Dislike", "Laugh", "Emphasize", "Question"];
const PART_PREFIX_PATTERN = /^(?:p:-?\d+\/|bp:)/;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)\]]+$/;
const EMOJI_ONLY_PATTERN = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Emoji_Component}|‍|️|\s)+$/u;
const PICTOGRAPH_PATTERN = /\p{Extended_Pictographic}/u;
const RUN_GAP_MS = 10 * 60 * 1000;
const SEPARATOR_GAP_MS = 60 * 60 * 1000;
const PENDING_TIMEOUT_MS = 20000;
const TYPING_IDLE_MS = 8000;
const TYPING_STALE_MS = 30000;
const NEAR_BOTTOM_PX = 120;
const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_PX = 10;
const MAX_TOASTS = 3;
const TOAST_MS = 4500;
const SUGGEST_DEBOUNCE_MS = 250;
const MAX_SUGGESTIONS = 10;
const NEW_CHAT_RETRIES = 4;
const NEW_CHAT_RETRY_MS = 1500;
const CHAT_LIMIT_MAX = 500;

function buildConfig(injected) {
	const source = injected && typeof injected === "object" ? injected : {};
	const sourceDefaults = source.defaults && typeof source.defaults === "object" ? source.defaults : {};
	return {
		...DEFAULT_CONFIG,
		...source,
		defaults: { ...DEFAULT_CONFIG.defaults, ...sourceDefaults },
		injected: Boolean(injected && typeof injected === "object")
	};
}

const config = buildConfig(window.SMSERVER_CONFIG);
SMServerLog.debug = Boolean(config.debug);
const api = new SMServerAPI(config);

const DOM_IDS = [
	"app", "sidebar", "thread", "menu-button", "menu", "theme-options", "logout-button", "version-label",
	"battery", "battery-level", "battery-percent", "battery-bolt", "compose-button", "notifications-button",
	"search-input", "search-button", "chat-list", "pinned-row", "chat-items", "chat-list-empty", "chat-list-loading", "chat-sentinel",
	"search-results", "search-results-title", "search-results-list", "search-close",
	"thread-empty", "thread-view", "back-button", "thread-avatar", "thread-name", "thread-members", "delete-chat-button",
	"messages", "messages-top", "load-older-button", "messages-loading", "message-list", "typing-indicator", "tapback-picker", "drop-overlay",
	"composer", "attachment-strip", "upload-progress", "upload-progress-bar", "attach-button", "file-input", "camera-roll-button",
	"subject-input", "message-input", "send-button",
	"banners", "connection-banner", "connection-banner-text", "cert-banner", "cert-link", "cert-banner-close", "toasts",
	"compose-dialog", "compose-form", "compose-cancel", "compose-send", "compose-to", "compose-suggestions", "compose-text",
	"compose-attach-button", "compose-file-input", "compose-attachments",
	"photos-dialog", "photos-cancel", "photos-confirm", "photos-grid", "photos-empty", "photos-loading", "photos-more",
	"delete-dialog", "delete-form", "delete-identifier", "delete-input", "delete-cancel", "delete-confirm",
	"lightbox", "lightbox-download", "lightbox-close", "lightbox-image", "icon-template"
];

const dom = {};

const state = {
	chats: [],
	chatIndex: new Map(),
	addressIndex: new Map(),
	chatsNextOffset: 0,
	chatsHasMore: true,
	chatsLoading: false,
	chatObserver: null,
	filterQuery: "",
	currentChatId: null,
	threadToken: 0,
	threadReady: false,
	messages: [],
	messageIndex: new Map(),
	nodes: new Map(),
	tapbacks: new Map(),
	tapbackTargets: new Map(),
	nextBefore: null,
	hasOlder: false,
	loadingOlder: false,
	topObserver: null,
	newestDate: null,
	readReceiptGuid: null,
	stickToBottom: true,
	pendingSends: [],
	pendingCounter: 0,
	attachments: [],
	selectedPhotos: [],
	photos: [],
	photosNextOffset: 0,
	photosHasMore: false,
	photosLoading: false,
	photoSelection: new Set(),
	composeAttachments: [],
	composeSuggestTimer: null,
	composeSuggestSeq: 0,
	sending: false,
	typingActive: false,
	typingTimer: null,
	socket: null,
	certBannerDismissed: false,
	avatarFailed: new Set(),
	picker: null,
	longPress: null,
	suppressClick: false,
	suppressClickTimer: null,
	dragCounter: 0,
	pushedHistory: false,
	filterTimer: null
};

function toCamelCase(id) {
	return id.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
}

function bindDom() {
	const missing = [];
	for (const id of DOM_IDS) {
		const node = document.getElementById(id);
		if (!node) {
			missing.push(id);
			continue;
		}
		dom[toCamelCase(id)] = node;
	}
	if (missing.length > 0) {
		logError("dom.missing", null, { ids: missing });
	}
}

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined && text !== null) {
		node.textContent = String(text);
	}
	return node;
}

function icon(name) {
	const svg = dom.iconTemplate.content.firstElementChild.cloneNode(true);
	svg.querySelector("use").setAttribute("href", "#i-" + name);
	return svg;
}

function iconButton(className, label, iconName) {
	const button = el("button", className);
	button.type = "button";
	button.setAttribute("aria-label", label);
	button.title = label;
	button.appendChild(icon(iconName));
	return button;
}

function clearNode(node) {
	while (node.firstChild) {
		node.removeChild(node.firstChild);
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function toast(message, kind) {
	const node = el("div", "toast " + (kind || "error"), message);
	node.setAttribute("role", "status");
	while (dom.toasts.children.length >= MAX_TOASTS) {
		dom.toasts.removeChild(dom.toasts.firstChild);
	}
	dom.toasts.appendChild(node);
	setTimeout(() => {
		node.classList.add("leaving");
		setTimeout(() => node.remove(), 350);
	}, TOAST_MS);
}

function errorMessage(error) {
	if (error && typeof error.message === "string" && error.message) {
		return error.message;
	}
	return "Unexpected error";
}

function openDialog(dialog) {
	if (dialog.open) {
		return;
	}
	if (typeof dialog.showModal === "function") {
		dialog.showModal();
	} else {
		dialog.setAttribute("open", "");
	}
}

function closeDialog(dialog) {
	if (!dialog.open) {
		return;
	}
	if (typeof dialog.close === "function") {
		dialog.close();
	} else {
		dialog.removeAttribute("open");
	}
}

function formatBytes(bytes) {
	const value = Number(bytes);
	if (!Number.isFinite(value) || value < 0) {
		return "";
	}
	if (value < 1024) {
		return value + " B";
	}
	if (value < 1024 * 1024) {
		return (value / 1024).toFixed(0) + " KB";
	}
	if (value < 1024 * 1024 * 1024) {
		return (value / (1024 * 1024)).toFixed(1) + " MB";
	}
	return (value / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function isMobileLayout() {
	return window.matchMedia("(max-width: 768px)").matches;
}

function isTouchDevice() {
	return window.matchMedia("(pointer: coarse)").matches;
}

function pageActive() {
	return document.visibilityState === "visible" && document.hasFocus();
}

function baseName(path) {
	const parts = String(path || "").split("/");
	return parts[parts.length - 1] || String(path || "");
}

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const shortDateFormatter = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const fullDateFormatter = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const fullDateTimeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function appleToMs(value) {
	const number = Number(value);
	if (!Number.isFinite(number) || number === 0) {
		return null;
	}
	return number / 1e6 + APPLE_EPOCH_OFFSET_SECONDS * 1000;
}

function unixToMs(value) {
	const number = Number(value);
	if (!Number.isFinite(number) || number === 0) {
		return null;
	}
	return number * 1000;
}

function timestampMs(unixValue, appleValue) {
	const fromUnix = unixToMs(unixValue);
	if (fromUnix !== null) {
		return fromUnix;
	}
	return appleToMs(appleValue);
}

function appleDateString(value) {
	if (typeof value === "string" && /^\d+$/.test(value)) {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return String(Math.trunc(value));
	}
	return null;
}

function compareAppleDates(a, b) {
	if (a === b) {
		return 0;
	}
	if (a === null) {
		return -1;
	}
	if (b === null) {
		return 1;
	}
	if (a.length !== b.length) {
		return a.length - b.length;
	}
	return a < b ? -1 : 1;
}

function sameDay(aMs, bMs) {
	const a = new Date(aMs);
	const b = new Date(bMs);
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayDistance(ms) {
	const now = new Date();
	const date = new Date(ms);
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	return Math.round((startOfToday - startOfDay) / (24 * 60 * 60 * 1000));
}

function separatorLabel(ms) {
	const date = new Date(ms);
	const time = timeFormatter.format(date);
	const distance = dayDistance(ms);
	if (distance === 0) {
		return "Today " + time;
	}
	if (distance === 1) {
		return "Yesterday " + time;
	}
	if (distance > 1 && distance < 7) {
		return weekdayFormatter.format(date) + " " + time;
	}
	if (date.getFullYear() === new Date().getFullYear()) {
		return shortDateFormatter.format(date) + ", " + time;
	}
	return fullDateFormatter.format(date) + ", " + time;
}

function relativeTimeLabel(ms) {
	if (ms === null || ms === undefined) {
		return "";
	}
	const date = new Date(ms);
	const distance = dayDistance(ms);
	if (distance === 0) {
		return timeFormatter.format(date);
	}
	if (distance === 1) {
		return "Yesterday";
	}
	if (distance > 1 && distance < 7) {
		return weekdayFormatter.format(date);
	}
	if (date.getFullYear() === new Date().getFullYear()) {
		return shortDateFormatter.format(date);
	}
	return fullDateFormatter.format(date);
}

function fullDateLabel(ms) {
	return fullDateTimeFormatter.format(new Date(ms));
}

function readStoredTheme() {
	try {
		return localStorage.getItem(THEME_STORAGE_KEY);
	} catch (error) {
		return null;
	}
}

function initialTheme() {
	const stored = readStoredTheme();
	if (THEMES.includes(stored)) {
		return stored;
	}
	return THEMES.includes(config.theme) ? config.theme : "dark";
}

function applyTheme(theme, persist) {
	const resolved = THEMES.includes(theme) ? theme : "dark";
	document.documentElement.setAttribute("data-theme", resolved);
	for (const button of dom.themeOptions.querySelectorAll("[data-theme-option]")) {
		button.setAttribute("aria-checked", String(button.dataset.themeOption === resolved));
	}
	if (persist) {
		try {
			localStorage.setItem(THEME_STORAGE_KEY, resolved);
		} catch (error) {
			logError("theme.persist", error, { theme: resolved });
		}
	}
	log("theme.apply", { theme: resolved, persist: Boolean(persist) });
}

function setMenuOpen(open) {
	dom.menu.hidden = !open;
	dom.menuButton.setAttribute("aria-expanded", String(open));
}

function setupMenu() {
	dom.menuButton.addEventListener("click", (event) => {
		event.stopPropagation();
		setMenuOpen(dom.menu.hidden);
	});
	for (const button of dom.themeOptions.querySelectorAll("[data-theme-option]")) {
		button.addEventListener("click", () => {
			applyTheme(button.dataset.themeOption, true);
			setMenuOpen(false);
		});
	}
	dom.logoutButton.addEventListener("click", () => {
		setMenuOpen(false);
		handleLogout();
	});
	document.addEventListener("click", (event) => {
		if (!dom.menu.hidden && !dom.menu.contains(event.target) && event.target !== dom.menuButton) {
			setMenuOpen(false);
		}
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !dom.menu.hidden) {
			setMenuOpen(false);
		}
	});
}

async function handleLogout() {
	try {
		await api.logout(true);
	} catch (error) {
		logError("auth.logout", error, {});
	}
	location.reload();
}

function handleBattery(data) {
	if (!data || typeof data !== "object") {
		return;
	}
	const percentage = Number(data.percentage);
	if (!Number.isFinite(percentage)) {
		return;
	}
	const clamped = Math.max(0, Math.min(100, percentage));
	const charging = Boolean(data.charging);
	dom.battery.hidden = false;
	dom.batteryLevel.style.width = clamped + "%";
	dom.batteryPercent.textContent = Math.round(clamped) + "%";
	dom.batteryBolt.hidden = !charging;
	dom.battery.classList.toggle("low", clamped <= 20);
	dom.battery.classList.toggle("medium", clamped > 20 && clamped <= 35);
	dom.battery.title = "Battery " + Math.round(clamped) + "%" + (charging ? ", charging" : "");
	dom.battery.setAttribute("aria-label", dom.battery.title);
}

function notificationsSupported() {
	return "Notification" in window && typeof Notification.requestPermission === "function";
}

function updateNotificationButton() {
	dom.notificationsButton.hidden = !notificationsSupported() || Notification.permission !== "default";
}

function requestNotificationPermission() {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		try {
			const maybePromise = Notification.requestPermission(finish);
			if (maybePromise && typeof maybePromise.then === "function") {
				maybePromise.then(finish, () => finish("default"));
			}
		} catch (error) {
			logError("notifications.request", error, {});
			finish("default");
		}
	});
}

function setupNotifications() {
	updateNotificationButton();
	dom.notificationsButton.addEventListener("click", async () => {
		const result = await requestNotificationPermission();
		log("notifications.permission", { result });
		updateNotificationButton();
	});
}

function showNotification(chat, msg) {
	if (!notificationsSupported() || Notification.permission !== "granted") {
		return;
	}
	if (msg.fromMe || (isCurrentChat(chat) && pageActive())) {
		return;
	}
	try {
		const notification = new Notification(chat.name, {
			body: messagePreview(msg, chat),
			tag: "smserver-" + chat.id,
			icon: "/favicon.ico"
		});
		notification.addEventListener("click", () => {
			window.focus();
			openChat(chat.id);
			notification.close();
		});
	} catch (error) {
		logError("notifications.show", error, { chat: chat.id });
	}
}

function updateTitle() {
	let unread = 0;
	for (const chat of state.chats) {
		if (chat.unread) {
			unread += 1;
		}
	}
	document.title = unread > 0 ? "(" + unread + ") SMServer" : "SMServer";
}

function makeChatRecord(raw) {
	const id = String(raw.chat_identifier || raw.chat_id || raw.id || "");
	const addresses = String(raw.addresses || id).split(",").map((item) => item.trim()).filter(Boolean);
	return {
		id,
		queryId: raw.addresses ? String(raw.addresses) : id,
		addresses: addresses.length > 0 ? addresses : [id],
		name: raw.display_name || id,
		latestText: typeof raw.latest_text === "string" ? raw.latest_text : "",
		timeMs: timestampMs(raw.time_marker_unix, raw.time_marker),
		relativeTime: typeof raw.relative_time === "string" ? raw.relative_time : "",
		unread: Boolean(raw.has_unread),
		pinned: Boolean(raw.pinned),
		isGroup: Boolean(raw.is_group),
		members: Array.isArray(raw.members) ? raw.members.filter((member) => member && typeof member === "object") : [],
		avatarUrl: typeof raw.avatar_url === "string" ? raw.avatar_url : null,
		placeholder: Boolean(raw.placeholder),
		typing: false,
		typingTimer: null,
		node: null
	};
}

function updateChatRecord(chat, raw) {
	const fresh = makeChatRecord(raw);
	chat.queryId = fresh.queryId;
	chat.addresses = fresh.addresses;
	chat.name = fresh.name;
	chat.latestText = fresh.latestText;
	chat.timeMs = fresh.timeMs;
	chat.relativeTime = fresh.relativeTime;
	chat.unread = fresh.unread;
	chat.pinned = fresh.pinned;
	chat.isGroup = fresh.isGroup;
	chat.members = fresh.members;
	chat.avatarUrl = fresh.avatarUrl;
	chat.placeholder = false;
}

function indexChat(chat) {
	state.chatIndex.set(chat.id, chat);
	for (const address of chat.addresses) {
		if (!state.addressIndex.has(address)) {
			state.addressIndex.set(address, chat);
		}
	}
}

function unindexChat(chat) {
	state.chatIndex.delete(chat.id);
	for (const address of chat.addresses) {
		if (state.addressIndex.get(address) === chat) {
			state.addressIndex.delete(address);
		}
	}
}

function findChat(identifier) {
	if (!identifier) {
		return null;
	}
	return state.chatIndex.get(identifier) || state.addressIndex.get(identifier) || null;
}

function findChatForMessage(msg) {
	return findChat(msg.chatId);
}

function upsertChatRecord(raw) {
	const id = String(raw.chat_identifier || raw.chat_id || raw.id || "");
	if (!id) {
		return null;
	}
	const existing = state.chatIndex.get(id);
	if (existing) {
		const wasTyping = existing.typing;
		unindexChat(existing);
		updateChatRecord(existing, raw);
		existing.typing = wasTyping;
		indexChat(existing);
		renderChatNode(existing);
		return { chat: existing, created: false };
	}
	const chat = makeChatRecord(raw);
	indexChat(chat);
	renderChatNode(chat);
	return { chat, created: true };
}

function addChatRecord(raw, options) {
	const result = upsertChatRecord(raw);
	if (!result) {
		return null;
	}
	if (result.created) {
		if (options && options.top) {
			state.chats.unshift(result.chat);
		} else {
			state.chats.push(result.chat);
		}
		attachChatNode(result.chat, Boolean(options && options.top));
		dom.chatListEmpty.hidden = true;
	}
	return result.chat;
}

function removeChat(chat) {
	const index = state.chats.indexOf(chat);
	if (index !== -1) {
		state.chats.splice(index, 1);
	}
	unindexChat(chat);
	if (chat.node) {
		chat.node.remove();
	}
	dom.chatListEmpty.hidden = state.chats.length > 0;
	dom.pinnedRow.hidden = !state.chats.some((item) => item.pinned);
	updateTitle();
}

function messagePreviewText(msg) {
	if (msg.text.trim()) {
		return msg.text.trim();
	}
	if (msg.subject) {
		return msg.subject;
	}
	if (msg.attachments.length > 0) {
		return msg.attachments.length === 1 ? "Attachment: " + baseName(msg.attachments[0].filename || "file") : msg.attachments.length + " attachments";
	}
	if (msg.balloon) {
		return msg.balloon === URL_BALLOON_ID ? "Link" : "App message";
	}
	if (msg.isTapback) {
		return "Reaction";
	}
	return "Message";
}

function messagePreview(msg, chat) {
	const text = messagePreviewText(msg);
	if (chat && chat.isGroup && !msg.fromMe && msg.sender) {
		return msg.sender + ": " + text;
	}
	return text;
}

function chatPreviewText(chat) {
	if (chat.typing) {
		return (chat.isGroup ? "Someone" : chat.name) + " is typing…";
	}
	return chat.latestText;
}

function chatTimeLabel(chat) {
	if (chat.timeMs !== null && chat.timeMs !== undefined) {
		return relativeTimeLabel(chat.timeMs);
	}
	return chat.relativeTime;
}

function createChatRow(chat) {
	const row = el("button", "chat-row");
	row.type = "button";
	row.dataset.chatId = chat.id;
	row.appendChild(createAvatar(chat, "md"));
	const body = el("div", "chat-row-body");
	const top = el("div", "chat-row-top");
	const name = el("span", "chat-row-name", chat.name);
	name.dir = "auto";
	top.appendChild(name);
	top.appendChild(el("span", "chat-row-time", chatTimeLabel(chat)));
	body.appendChild(top);
	const preview = el("div", "chat-row-preview", chatPreviewText(chat));
	preview.dir = "auto";
	body.appendChild(preview);
	row.appendChild(body);
	const badge = el("span", "chat-row-unread");
	badge.setAttribute("aria-label", "Unread");
	row.appendChild(badge);
	row.classList.toggle("unread", chat.unread);
	row.classList.toggle("typing", chat.typing);
	row.classList.toggle("selected", chat.id === state.currentChatId);
	row.setAttribute("aria-current", chat.id === state.currentChatId ? "true" : "false");
	row.addEventListener("click", () => openChat(chat.id));
	return row;
}

function createPinnedTile(chat) {
	const tile = el("button", "pinned-tile");
	tile.type = "button";
	tile.dataset.chatId = chat.id;
	tile.title = chat.name;
	tile.setAttribute("aria-label", chat.name + (chat.unread ? ", unread" : ""));
	tile.appendChild(createAvatar(chat, "lg"));
	const name = el("span", "pinned-tile-name", chat.name);
	name.dir = "auto";
	tile.appendChild(name);
	const badge = el("span", "chat-row-unread");
	tile.appendChild(badge);
	tile.classList.toggle("unread", chat.unread);
	tile.classList.toggle("typing", chat.typing);
	tile.classList.toggle("selected", chat.id === state.currentChatId);
	tile.addEventListener("click", () => openChat(chat.id));
	return tile;
}

function renderChatNode(chat) {
	const fresh = chat.pinned ? createPinnedTile(chat) : createChatRow(chat);
	fresh.hidden = Boolean(chat.filteredOut);
	const previous = chat.node;
	chat.node = fresh;
	if (!previous || !previous.parentNode) {
		return;
	}
	const wasPinned = previous.parentNode === dom.pinnedRow;
	if (wasPinned === chat.pinned) {
		previous.replaceWith(fresh);
		return;
	}
	previous.remove();
	attachChatNode(chat, false);
}

function attachChatNode(chat, top) {
	const container = chat.pinned ? dom.pinnedRow : dom.chatItems;
	if (top && !chat.pinned) {
		container.insertBefore(chat.node, container.firstChild);
	} else {
		container.appendChild(chat.node);
	}
	if (chat.pinned) {
		dom.pinnedRow.hidden = Boolean(state.filterQuery);
	}
}

function renderChatOrder() {
	const pinnedFragment = document.createDocumentFragment();
	const listFragment = document.createDocumentFragment();
	let hasPinned = false;
	for (const chat of state.chats) {
		if (chat.pinned) {
			hasPinned = true;
			pinnedFragment.appendChild(chat.node);
		} else {
			listFragment.appendChild(chat.node);
		}
	}
	clearNode(dom.pinnedRow);
	clearNode(dom.chatItems);
	dom.pinnedRow.appendChild(pinnedFragment);
	dom.chatItems.appendChild(listFragment);
	dom.pinnedRow.hidden = !hasPinned || Boolean(state.filterQuery);
	dom.chatListEmpty.hidden = state.chats.length > 0;
}

function moveChatToTop(chat) {
	if (chat.pinned) {
		return;
	}
	const index = state.chats.indexOf(chat);
	if (index > 0) {
		state.chats.splice(index, 1);
		state.chats.unshift(chat);
	}
	if (chat.node && dom.chatItems.firstChild !== chat.node) {
		dom.chatItems.insertBefore(chat.node, dom.chatItems.firstChild);
	}
}

function applyChatPage(items, replace) {
	const ordered = [];
	for (const raw of items) {
		const result = upsertChatRecord(raw);
		if (!result) {
			continue;
		}
		if (!ordered.includes(result.chat)) {
			ordered.push(result.chat);
		}
	}
	if (replace) {
		const keep = new Set(ordered);
		for (const chat of state.chats) {
			if (!keep.has(chat)) {
				if (chat.id === state.currentChatId) {
					ordered.push(chat);
				} else {
					unindexChat(chat);
					if (chat.node) {
						chat.node.remove();
					}
				}
			}
		}
		state.chats = ordered;
		renderChatOrder();
		return;
	}
	for (const chat of ordered) {
		if (!state.chats.includes(chat)) {
			state.chats.push(chat);
			attachChatNode(chat, false);
		}
	}
	dom.chatListEmpty.hidden = state.chats.length > 0;
}

async function loadChats(options) {
	const reset = Boolean(options && options.reset);
	if (state.chatsLoading || (!reset && !state.chatsHasMore)) {
		return;
	}
	state.chatsLoading = true;
	dom.chatListLoading.hidden = false;
	const offset = reset ? 0 : state.chatsNextOffset;
	const limit = reset ? Math.min(CHAT_LIMIT_MAX, Math.max(config.defaults.chats, state.chats.length)) : config.defaults.chats;
	log("chats.page", { offset, limit, reset });
	try {
		const page = await api.getChats({ limit, offset });
		const items = Array.isArray(page && page.items) ? page.items : [];
		applyChatPage(items, reset);
		const nextOffset = page && page.next_offset !== null && page.next_offset !== undefined ? Number(page.next_offset) : null;
		state.chatsHasMore = Boolean(page && page.has_more) && nextOffset !== null;
		state.chatsNextOffset = state.chatsHasMore ? nextOffset : offset + items.length;
		applyChatFilter();
		updateTitle();
	} catch (error) {
		logError("chats.page.failed", error, { offset, limit });
		toast("Could not load conversations: " + errorMessage(error));
	} finally {
		state.chatsLoading = false;
		dom.chatListLoading.hidden = true;
		reobserveChatSentinel();
	}
}

function setupChatObserver() {
	state.chatObserver = new IntersectionObserver((entries) => {
		if (entries.some((entry) => entry.isIntersecting) && !state.filterQuery) {
			loadChats({ reset: false });
		}
	}, { root: dom.chatList, rootMargin: "200px 0px", threshold: 0 });
	state.chatObserver.observe(dom.chatSentinel);
}

function reobserveChatSentinel() {
	if (!state.chatObserver) {
		return;
	}
	state.chatObserver.unobserve(dom.chatSentinel);
	state.chatObserver.observe(dom.chatSentinel);
}

function chatMatchesQuery(chat, query) {
	if (chat.name.toLowerCase().includes(query) || chat.id.toLowerCase().includes(query)) {
		return true;
	}
	if (chat.latestText.toLowerCase().includes(query)) {
		return true;
	}
	return chat.members.some((member) => String(member.display_name || member.chat_identifier || "").toLowerCase().includes(query));
}

function applyChatFilter() {
	const query = state.filterQuery.trim().toLowerCase();
	let visible = 0;
	for (const chat of state.chats) {
		const match = !query || chatMatchesQuery(chat, query);
		chat.filteredOut = !match;
		if (chat.node) {
			chat.node.hidden = !match;
		}
		if (match) {
			visible += 1;
		}
	}
	dom.pinnedRow.hidden = Boolean(query) || !state.chats.some((chat) => chat.pinned);
	dom.chatSentinel.hidden = Boolean(query);
	dom.chatListEmpty.hidden = visible > 0 || state.chatsLoading;
	dom.chatListEmpty.textContent = query ? "No matching conversations" : "No conversations";
}

function avatarHue(name) {
	let hash = 0;
	for (const character of String(name || "")) {
		hash = (hash * 31 + character.codePointAt(0)) % 360;
	}
	return hash;
}

function initialsFor(name) {
	const cleaned = String(name || "").replace(/\p{Extended_Pictographic}/gu, "").trim();
	if (!cleaned || !/\p{L}/u.test(cleaned)) {
		return "";
	}
	const words = cleaned.split(/\s+/).filter(Boolean);
	const first = Array.from(words[0])[0] || "";
	const last = words.length > 1 ? Array.from(words[words.length - 1])[0] || "" : "";
	return (first + last).toUpperCase();
}

function avatarSource(subject) {
	if (subject.avatarUrl) {
		return api.withToken(subject.avatarUrl);
	}
	if (!subject.id) {
		return null;
	}
	return api.contactPhotoUrl(subject.id, false);
}

function createAvatar(subject, size) {
	const wrap = el("span", "avatar avatar-" + size);
	wrap.setAttribute("aria-hidden", "true");
	wrap.style.setProperty("--avatar-hue", String(avatarHue(subject.name || subject.id)));
	const initials = initialsFor(subject.name);
	if (initials) {
		wrap.appendChild(el("span", "avatar-initials", initials));
	} else {
		wrap.appendChild(icon(subject.isGroup ? "users" : "user"));
	}
	const source = avatarSource(subject);
	if (source && !state.avatarFailed.has(source)) {
		const image = el("img", "avatar-image");
		image.alt = "";
		image.loading = "lazy";
		image.decoding = "async";
		image.addEventListener("error", () => {
			state.avatarFailed.add(source);
			image.remove();
		});
		image.addEventListener("load", () => wrap.classList.add("has-image"));
		image.src = source;
		wrap.appendChild(image);
	}
	return wrap;
}

function currentChat() {
	return state.currentChatId ? state.chatIndex.get(state.currentChatId) || null : null;
}

function isCurrentChat(chat) {
	return Boolean(chat) && chat.id === state.currentChatId;
}

async function ensureChat(chatId, retries) {
	const known = findChat(chatId);
	if (known) {
		return known;
	}
	const attempts = Number.isFinite(retries) ? retries : 0;
	for (let attempt = 0; attempt <= attempts; attempt += 1) {
		try {
			const raw = await api.getChat(chatId);
			return addChatRecord(raw, { top: true });
		} catch (error) {
			if (!error || error.status !== 404) {
				logError("chat.fetch.failed", error, { chatId });
				throw error;
			}
			if (attempt < attempts) {
				await sleep(NEW_CHAT_RETRY_MS);
			}
		}
	}
	return null;
}

function createPlaceholderChat(chatId) {
	return addChatRecord({ chat_identifier: chatId, display_name: chatId, members: [], placeholder: true }, { top: true });
}

function selectChatRow(chat) {
	for (const item of state.chats) {
		if (!item.node) {
			continue;
		}
		const selected = item === chat;
		item.node.classList.toggle("selected", selected);
		item.node.setAttribute("aria-current", selected ? "true" : "false");
	}
}

function resetThreadState() {
	state.threadToken += 1;
	state.threadReady = false;
	state.messages = [];
	state.messageIndex = new Map();
	state.nodes = new Map();
	state.tapbacks = new Map();
	state.tapbackTargets = new Map();
	state.nextBefore = null;
	state.hasOlder = false;
	state.loadingOlder = false;
	state.newestDate = null;
	state.readReceiptGuid = null;
	state.stickToBottom = true;
	state.pendingSends = [];
	clearNode(dom.messageList);
	dom.typingIndicator.hidden = true;
	closeTapbackPicker();
	updateOlderControls();
}

function renderThreadHeader(chat) {
	clearNode(dom.threadAvatar);
	dom.threadAvatar.appendChild(createAvatar(chat, "md"));
	dom.threadName.textContent = chat.name;
	let members = "";
	if (chat.isGroup) {
		members = chat.members.map((member) => member.display_name || member.chat_identifier || "").filter(Boolean).join(", ");
	} else if (chat.name !== chat.id) {
		members = chat.addresses.join(", ");
	}
	dom.threadMembers.textContent = members;
	dom.threadMembers.hidden = !members;
	dom.messageInput.placeholder = chat.isGroup ? "Message group" : "Message";
}

async function openChat(chatId, options) {
	const settings = options || {};
	let chat = null;
	try {
		chat = await ensureChat(chatId, 0);
	} catch (error) {
		toast("Could not load the conversation: " + errorMessage(error));
		return;
	}
	if (!chat && settings.allowPlaceholder) {
		chat = createPlaceholderChat(chatId);
	}
	if (!chat) {
		toast("Conversation not found");
		return;
	}
	if (isMobileLayout()) {
		closeSearchResults();
	}
	if (isCurrentChat(chat) && !settings.force) {
		showPane("thread");
		if (settings.scrollToGuid) {
			highlightMessage(settings.scrollToGuid);
		}
		return;
	}
	stopTyping(currentChat());
	state.currentChatId = chat.id;
	log("chat.open", { chat: chat.id });
	selectChatRow(chat);
	resetThreadState();
	renderThreadHeader(chat);
	dom.threadEmpty.hidden = true;
	dom.threadView.hidden = false;
	showPane("thread");
	await loadInitialMessages(chat, settings);
	markChatRead(chat);
	if (!isTouchDevice()) {
		dom.messageInput.focus();
	}
}

function closeThread() {
	const chat = currentChat();
	stopTyping(chat);
	state.currentChatId = null;
	resetThreadState();
	selectChatRow(null);
	dom.threadView.hidden = true;
	dom.threadEmpty.hidden = false;
	showPane("list");
}

function setThreadLoading(loading) {
	dom.messagesLoading.hidden = !loading;
}

function updateOlderControls() {
	dom.loadOlderButton.hidden = !state.hasOlder || state.loadingOlder || !state.threadReady;
	dom.messagesLoading.hidden = !state.loadingOlder;
}

async function loadInitialMessages(chat, options) {
	const token = state.threadToken;
	setThreadLoading(true);
	log("messages.initial", { chat: chat.id });
	try {
		const page = await api.getMessages(chat.queryId, { limit: config.defaults.messages, markRead: false });
		if (token !== state.threadToken) {
			return;
		}
		ingestPage(page, "initial");
		renderPendingRows();
		updateReadReceipt();
		scrollToBottom();
		requestAnimationFrame(() => {
			if (token === state.threadToken) {
				scrollToBottom();
			}
		});
		if (options && options.scrollToGuid) {
			highlightMessage(options.scrollToGuid);
		}
	} catch (error) {
		if (token !== state.threadToken) {
			return;
		}
		logError("messages.initial.failed", error, { chat: chat.id });
		if (!(error && error.status === 404 && chat.placeholder)) {
			toast("Could not load messages: " + errorMessage(error));
		}
	} finally {
		if (token === state.threadToken) {
			state.threadReady = true;
			setThreadLoading(false);
			updateOlderControls();
			reobserveTop();
		}
	}
}

async function loadOlderMessages() {
	const chat = currentChat();
	if (!chat || !state.hasOlder || state.loadingOlder || !state.threadReady) {
		return;
	}
	const token = state.threadToken;
	const before = state.nextBefore;
	state.loadingOlder = true;
	updateOlderControls();
	log("messages.older", { chat: chat.id, before });
	try {
		const page = await api.getMessages(chat.queryId, { limit: config.defaults.messages, before, markRead: false });
		if (token !== state.threadToken) {
			return;
		}
		const previousHeight = dom.messages.scrollHeight;
		const previousTop = dom.messages.scrollTop;
		const result = ingestPage(page, "older");
		renderPendingRows();
		refreshTapbackTargets(result.tapbackTargets);
		updateReadReceipt();
		dom.messages.scrollTop = previousTop + (dom.messages.scrollHeight - previousHeight);
		if (state.nextBefore === before) {
			state.hasOlder = false;
		}
	} catch (error) {
		if (token !== state.threadToken) {
			return;
		}
		logError("messages.older.failed", error, { chat: chat.id, before });
		toast("Could not load older messages: " + errorMessage(error));
	} finally {
		if (token === state.threadToken) {
			state.loadingOlder = false;
			updateOlderControls();
			reobserveTop();
		}
	}
}

async function resyncCurrentChat() {
	const chat = currentChat();
	if (!chat || !state.threadReady) {
		return;
	}
	const token = state.threadToken;
	log("messages.resync", { chat: chat.id, after: state.newestDate });
	try {
		const page = await api.getMessages(chat.queryId, { limit: config.defaults.messages, after: state.newestDate, markRead: false });
		if (token !== state.threadToken) {
			return;
		}
		const wasNearBottom = isNearBottom();
		const result = ingestPage(page, "newer");
		renderPendingRows();
		refreshTapbackTargets(result.tapbackTargets);
		updateReadReceipt();
		if (wasNearBottom && (result.inserted > 0 || result.tapbackTargets.size > 0)) {
			scrollToBottom();
		}
		if (result.inserted > 0 && pageActive()) {
			markChatRead(chat);
		}
	} catch (error) {
		if (token === state.threadToken) {
			logError("messages.resync.failed", error, { chat: chat.id });
		}
	}
}

function setupThreadObservers() {
	state.topObserver = new IntersectionObserver((entries) => {
		if (entries.some((entry) => entry.isIntersecting)) {
			loadOlderMessages();
		}
	}, { root: dom.messages, rootMargin: "250px 0px 0px 0px", threshold: 0 });
	state.topObserver.observe(dom.messagesTop);
}

function reobserveTop() {
	if (!state.topObserver) {
		return;
	}
	state.topObserver.unobserve(dom.messagesTop);
	state.topObserver.observe(dom.messagesTop);
}

function isNearBottom() {
	const container = dom.messages;
	return container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_PX;
}

function scrollToBottom() {
	dom.messages.scrollTop = dom.messages.scrollHeight;
	state.stickToBottom = true;
}

function trackNewestDate(value) {
	const candidate = appleDateString(value);
	if (candidate === null) {
		return;
	}
	if (compareAppleDates(candidate, state.newestDate) > 0) {
		state.newestDate = candidate;
	}
}

function stringField(raw, key) {
	const value = raw[key];
	return typeof value === "string" ? value : (value === null || value === undefined ? "" : String(value));
}

function normalizeAttachments(raw) {
	if (!Array.isArray(raw.attachments)) {
		return [];
	}
	return raw.attachments.filter((item) => item && typeof item === "object" && (item.filename || item.url)).map((item) => ({
		filename: stringField(item, "filename"),
		mimeType: stringField(item, "mime_type").toLowerCase(),
		url: stringField(item, "url"),
		size: Number.isFinite(Number(item.size)) ? Number(item.size) : (Number.isFinite(Number(item.total_bytes)) ? Number(item.total_bytes) : null)
	}));
}

function normalizeMessage(raw) {
	if (!raw || typeof raw !== "object") {
		return null;
	}
	const guid = stringField(raw, "guid") || (raw.ROWID !== undefined && raw.ROWID !== null ? "rowid-" + raw.ROWID : "");
	if (!guid) {
		return null;
	}
	const assocType = Number(raw.associated_message_type) || 0;
	const isGroup = Boolean(raw.is_group);
	const handle = stringField(raw, "id") || stringField(raw, "handle");
	const dateMs = timestampMs(raw.date_unix, raw.date);
	const fromMe = Boolean(raw.is_from_me);
	const sender = stringField(raw, "sender");
	const msg = {
		guid,
		raw,
		chatId: stringField(raw, "chat_identifier") || (!isGroup ? handle : ""),
		handle,
		sender,
		text: stringField(raw, "text"),
		subject: stringField(raw, "subject"),
		fromMe,
		imessage: raw.imessage === undefined || raw.imessage === null ? true : Boolean(raw.imessage),
		dateMs: dateMs === null ? Date.now() : dateMs,
		appleDate: appleDateString(raw.date),
		dateReadMs: timestampMs(raw.date_read_unix, raw.date_read),
		attachments: normalizeAttachments(raw),
		balloon: stringField(raw, "balloon_bundle_id"),
		assocGuid: stringField(raw, "associated_message_guid"),
		assocType,
		isTapback: assocType >= 2000 && assocType <= 3005,
		isEvent: Boolean(Number(raw.item_type) || Number(raw.group_action_type)),
		itemDescription: stringField(raw, "item_description"),
		isGroup,
		linkTitle: stringField(raw, "link_title"),
		linkSubtitle: stringField(raw, "link_subtitle"),
		linkType: stringField(raw, "link_type"),
		pending: false,
		unconfirmed: false,
		identity: ""
	};
	msg.identity = fromMe ? "me" : (handle || sender || msg.chatId || "them");
	return msg;
}

function stripPart(assocGuid) {
	return String(assocGuid || "").replace(PART_PREFIX_PATTERN, "");
}

function registerTapback(msg) {
	if (!msg.assocGuid) {
		return null;
	}
	const targetGuid = stripPart(msg.assocGuid);
	let bucket = state.tapbacks.get(msg.assocGuid);
	if (!bucket) {
		bucket = new Map();
		state.tapbacks.set(msg.assocGuid, bucket);
	}
	bucket.set(msg.guid, msg);
	let targets = state.tapbackTargets.get(targetGuid);
	if (!targets) {
		targets = new Set();
		state.tapbackTargets.set(targetGuid, targets);
	}
	targets.add(msg.assocGuid);
	return msg.assocGuid;
}

function resolveTapbacks(assocGuid) {
	const bucket = state.tapbacks.get(assocGuid);
	if (!bucket) {
		return [];
	}
	const events = Array.from(bucket.values()).sort((a, b) => a.dateMs - b.dateMs);
	const current = new Map();
	for (const event of events) {
		if (event.assocType >= 2000 && event.assocType <= 2005) {
			current.set(event.identity, { type: event.assocType - 2000, fromMe: event.fromMe, sender: event.sender, identity: event.identity });
		} else if (event.assocType >= 3000 && event.assocType <= 3005) {
			const existing = current.get(event.identity);
			if (existing && existing.type === event.assocType - 3000) {
				current.delete(event.identity);
			}
		}
	}
	return Array.from(current.values());
}

function refreshTapbackTargets(targets) {
	for (const assocGuid of targets) {
		refreshRowByGuid(stripPart(assocGuid));
	}
}

function ingestPage(page, mode) {
	const items = Array.isArray(page && page.items) ? page.items : [];
	const records = [];
	const tapbackTargets = new Set();
	for (const raw of items) {
		const msg = normalizeMessage(raw);
		if (!msg) {
			continue;
		}
		trackNewestDate(msg.appleDate);
		if (msg.isTapback) {
			const target = registerTapback(msg);
			if (target) {
				tapbackTargets.add(target);
			}
			continue;
		}
		if ((msg.isEvent && !msg.itemDescription) || state.messageIndex.has(msg.guid)) {
			continue;
		}
		if (msg.fromMe) {
			resolvePendingSend(msg);
		}
		records.push(msg);
	}
	insertRecords(records);
	if (page) {
		trackNewestDate(page.newest_date);
	}
	if (mode === "initial" || mode === "older") {
		state.hasOlder = Boolean(page && page.has_more);
		state.nextBefore = appleDateString(page ? page.next_before : null);
		if (state.nextBefore === null) {
			state.hasOlder = false;
		}
	}
	log("messages.ingest", { mode, received: items.length, inserted: records.length, tapbacks: tapbackTargets.size });
	return { inserted: records.length, tapbackTargets };
}

function insertRecords(records) {
	if (records.length === 0) {
		return;
	}
	records.sort((a, b) => a.dateMs - b.dateMs);
	const existing = state.messages;
	const merged = [];
	let i = 0;
	let j = 0;
	while (i < existing.length || j < records.length) {
		if (j >= records.length || (i < existing.length && existing[i].dateMs <= records[j].dateMs)) {
			merged.push(existing[i]);
			i += 1;
		} else {
			state.messageIndex.set(records[j].guid, records[j]);
			merged.push(records[j]);
			j += 1;
		}
	}
	state.messages = merged;
}

function removeMessageRecord(guid) {
	const index = state.messages.findIndex((item) => item.guid === guid);
	if (index === -1) {
		return;
	}
	state.messages.splice(index, 1);
	state.messageIndex.delete(guid);
	const node = state.nodes.get(guid);
	if (node) {
		node.remove();
		state.nodes.delete(guid);
	}
	if (index > 0) {
		refreshRow(index - 1);
	}
	if (index < state.messages.length) {
		refreshRow(index);
	}
}

function sameRun(a, b) {
	if (!a || !b || a.isEvent || b.isEvent) {
		return false;
	}
	const gap = b.dateMs - a.dateMs;
	return a.fromMe === b.fromMe && a.identity === b.identity && gap < RUN_GAP_MS && gap > -RUN_GAP_MS;
}

function rowContext(index) {
	const msg = state.messages[index];
	const prev = index > 0 ? state.messages[index - 1] : null;
	const next = index < state.messages.length - 1 ? state.messages[index + 1] : null;
	const separator = !prev || !sameDay(prev.dateMs, msg.dateMs) || msg.dateMs - prev.dateMs >= SEPARATOR_GAP_MS;
	const first = separator || !sameRun(prev, msg);
	const last = !next || !sameRun(msg, next) || !sameDay(msg.dateMs, next.dateMs) || next.dateMs - msg.dateMs >= SEPARATOR_GAP_MS;
	const chat = currentChat();
	return { separator, first, last, isGroup: Boolean(chat && chat.isGroup) || msg.isGroup };
}

function renderPendingRows() {
	const messages = state.messages;
	const touched = new Set();
	let index = 0;
	while (index < messages.length) {
		if (state.nodes.has(messages[index].guid)) {
			index += 1;
			continue;
		}
		const fragment = document.createDocumentFragment();
		const start = index;
		while (index < messages.length && !state.nodes.has(messages[index].guid)) {
			const row = createMessageRow(messages[index], rowContext(index));
			state.nodes.set(messages[index].guid, row);
			fragment.appendChild(row);
			index += 1;
		}
		const anchor = index < messages.length ? state.nodes.get(messages[index].guid) : null;
		dom.messageList.insertBefore(fragment, anchor);
		if (start > 0) {
			touched.add(start - 1);
		}
		if (index < messages.length) {
			touched.add(index);
		}
	}
	for (const rowIndex of touched) {
		refreshRow(rowIndex);
	}
}

function refreshRow(index) {
	const msg = state.messages[index];
	if (!msg) {
		return;
	}
	const old = state.nodes.get(msg.guid);
	if (!old) {
		return;
	}
	const fresh = createMessageRow(msg, rowContext(index));
	old.replaceWith(fresh);
	state.nodes.set(msg.guid, fresh);
}

function refreshRowByGuid(guid) {
	if (!guid || !state.nodes.has(guid)) {
		return;
	}
	const index = state.messages.findIndex((item) => item.guid === guid);
	if (index !== -1) {
		refreshRow(index);
	}
}

function createEventRow(msg, ctx) {
	const row = el("div", "msg event");
	row.dataset.guid = msg.guid;
	if (ctx.separator) {
		row.appendChild(el("div", "separator", separatorLabel(msg.dateMs)));
	}
	const text = el("span", "event-text", msg.itemDescription);
	text.dir = "auto";
	row.appendChild(text);
	return row;
}

function createMessageRow(msg, ctx) {
	if (msg.isEvent) {
		return createEventRow(msg, ctx);
	}
	const row = el("div", "msg");
	row.dataset.guid = msg.guid;
	row.classList.add(msg.fromMe ? "me" : "them", msg.imessage ? "imessage" : "sms");
	row.classList.toggle("first", ctx.first);
	row.classList.toggle("last", ctx.last);
	row.classList.toggle("pending", msg.pending);
	row.classList.toggle("pending-failed", msg.unconfirmed);
	if (ctx.separator) {
		row.appendChild(el("div", "separator", separatorLabel(msg.dateMs)));
	}
	const showSender = ctx.isGroup && !msg.fromMe;
	if (showSender && ctx.first) {
		const sender = el("div", "msg-sender", msg.sender || msg.handle || "Unknown sender");
		sender.dir = "auto";
		row.appendChild(sender);
	}
	const line = el("div", "msg-line");
	if (showSender) {
		const slot = el("div", "msg-avatar-slot");
		if (ctx.first) {
			slot.appendChild(createAvatar({ id: msg.handle || msg.chatId, name: msg.sender || msg.handle, avatarUrl: null, isGroup: false }, "sm"));
		}
		line.appendChild(slot);
	}
	const parts = el("div", "msg-parts");
	parts.title = fullDateLabel(msg.dateMs);
	for (const part of buildParts(msg)) {
		parts.appendChild(part);
	}
	line.appendChild(parts);
	row.appendChild(line);
	if (msg.pending) {
		row.appendChild(el("div", "msg-status", msg.unconfirmed ? "Not confirmed, check your iPhone" : "Sending…"));
	} else if (msg.guid === state.readReceiptGuid && msg.dateReadMs) {
		const receipt = el("div", "msg-receipt");
		receipt.appendChild(el("strong", "", "Read"));
		receipt.appendChild(document.createTextNode(" " + relativeReadLabel(msg.dateReadMs)));
		row.appendChild(receipt);
	}
	renderTapbackBadges(row, msg);
	return row;
}

function relativeReadLabel(ms) {
	const distance = dayDistance(ms);
	if (distance === 0) {
		return timeFormatter.format(new Date(ms));
	}
	return separatorLabel(ms);
}

function buildParts(msg) {
	if (msg.pending) {
		return buildPendingParts(msg);
	}
	if (msg.balloon === URL_BALLOON_ID) {
		return [createRichLinkPart(msg)];
	}
	if (msg.balloon) {
		return [createUnsupportedPart(msg)];
	}
	const parts = msg.attachments.map((attachment, index) => createAttachmentPart(msg, attachment, index));
	if (msg.text.trim() || msg.subject || parts.length === 0) {
		parts.push(createTextPart(msg, msg.attachments.length));
	}
	return parts;
}

function buildPendingParts(msg) {
	const parts = [];
	for (const name of msg.pendingFiles) {
		const chip = el("div", "bubble part media");
		chip.appendChild(createFileChipContent(name, "Uploading"));
		parts.push(chip);
	}
	if (msg.pendingPhotos > 0) {
		const chip = el("div", "bubble part media");
		chip.appendChild(createFileChipContent(msg.pendingPhotos === 1 ? "1 photo" : msg.pendingPhotos + " photos", "Camera roll"));
		parts.push(chip);
	}
	if (msg.text || msg.subject || parts.length === 0) {
		parts.push(createTextPart(msg, parts.length));
	}
	return parts;
}

function createTextPart(msg, partIndex) {
	const part = el("div", "bubble part text");
	part.dataset.part = "p:" + partIndex + "/";
	part.dir = "auto";
	if (msg.subject) {
		const subject = el("div", "bubble-subject", msg.subject);
		part.appendChild(subject);
	}
	const text = msg.text.trim() ? msg.text : "";
	if (text) {
		const body = el("div", "bubble-text");
		appendTextWithLinks(body, text);
		part.appendChild(body);
		if (!msg.subject && isEmojiOnly(text)) {
			part.classList.add("emoji-only");
		}
	} else if (!msg.subject) {
		part.appendChild(el("div", "bubble-text no-text", "No text content"));
	}
	return part;
}

function appendTextWithLinks(container, text) {
	let last = 0;
	URL_PATTERN.lastIndex = 0;
	let match = URL_PATTERN.exec(text);
	while (match !== null) {
		let url = match[0];
		const trailing = url.match(TRAILING_PUNCTUATION_PATTERN);
		if (trailing) {
			url = url.slice(0, url.length - trailing[0].length);
		}
		if (match.index > last) {
			container.appendChild(document.createTextNode(text.slice(last, match.index)));
		}
		const link = el("a", "text-link", url);
		link.href = url;
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		container.appendChild(link);
		last = match.index + url.length;
		URL_PATTERN.lastIndex = last;
		match = URL_PATTERN.exec(text);
	}
	if (last < text.length) {
		container.appendChild(document.createTextNode(text.slice(last)));
	}
}

function isEmojiOnly(text) {
	const trimmed = text.trim();
	if (!trimmed || trimmed.length > 40) {
		return false;
	}
	return EMOJI_ONLY_PATTERN.test(trimmed) && PICTOGRAPH_PATTERN.test(trimmed);
}

function attachmentUrl(attachment, download) {
	if (attachment.filename) {
		return api.attachmentUrl(attachment.filename, download);
	}
	if (attachment.url) {
		let url = attachment.url;
		if (download) {
			url += (url.includes("?") ? "&" : "?") + "download=1";
		}
		return api.withToken(url);
	}
	return "";
}

function attachmentMeta(attachment) {
	const size = attachment.size !== null ? formatBytes(attachment.size) : "";
	const type = attachment.mimeType || baseName(attachment.filename).split(".").pop() || "file";
	return size ? type + " · " + size : type;
}

function createFileChipContent(name, meta) {
	const fragment = document.createDocumentFragment();
	fragment.appendChild(icon("file"));
	const body = el("div", "file-chip-body");
	const nameNode = el("span", "file-chip-name", name);
	nameNode.dir = "auto";
	body.appendChild(nameNode);
	if (meta) {
		body.appendChild(el("span", "file-chip-meta", meta));
	}
	fragment.appendChild(body);
	return fragment;
}

function createAttachmentPart(msg, attachment, index) {
	const url = attachmentUrl(attachment, false);
	const downloadUrl = attachmentUrl(attachment, true);
	const name = baseName(attachment.filename) || "attachment";
	const mime = attachment.mimeType;
	const part = el("div", "bubble part media");
	part.dataset.part = "p:" + index + "/";
	if (mime.startsWith("image/")) {
		part.classList.add("image");
		const image = el("img", "attachment-image");
		image.alt = name;
		image.loading = "lazy";
		image.decoding = "async";
		image.dataset.full = url;
		image.dataset.download = downloadUrl;
		image.addEventListener("load", () => {
			if (state.stickToBottom) {
				scrollToBottom();
			}
		});
		image.addEventListener("error", () => {
			part.classList.remove("image");
			clearNode(part);
			part.appendChild(createFileChipLink(name, attachmentMeta(attachment), downloadUrl));
		});
		image.src = url;
		part.appendChild(image);
	} else if (mime.startsWith("video/")) {
		const video = el("video", "attachment-video");
		video.controls = true;
		video.playsInline = true;
		video.preload = "metadata";
		video.src = url;
		part.appendChild(video);
	} else if (mime.startsWith("audio/")) {
		const audio = el("audio", "attachment-audio");
		audio.controls = true;
		audio.preload = "none";
		audio.src = url;
		part.appendChild(audio);
	} else {
		part.appendChild(createFileChipLink(name, attachmentMeta(attachment), downloadUrl));
	}
	return part;
}

function createFileChipLink(name, meta, downloadUrl) {
	const link = el("a", "file-chip");
	link.href = downloadUrl;
	link.setAttribute("download", name);
	link.title = "Download " + name;
	link.appendChild(createFileChipContent(name, meta));
	const download = icon("download");
	download.classList.add("file-chip-download");
	link.appendChild(download);
	return link;
}

function safeLinkHref(text) {
	const trimmed = String(text || "").trim();
	if (!trimmed) {
		return "";
	}
	const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
	if (schemeMatch) {
		const scheme = schemeMatch[1].toLowerCase();
		return scheme === "http" || scheme === "https" || scheme === "mailto" ? trimmed : "";
	}
	return "//" + trimmed;
}

function hostnameOf(href) {
	try {
		return new URL(href, location.href).hostname;
	} catch (error) {
		return "";
	}
}

function createRichLinkPart(msg) {
	const href = safeLinkHref(msg.text);
	const card = el(href ? "a" : "div", "bubble part link-card");
	card.dataset.part = "bp:";
	if (href) {
		card.href = href;
		card.target = "_blank";
		card.rel = "noopener noreferrer";
	}
	const images = msg.attachments.filter((item) => item.mimeType.startsWith("image/"));
	if (images.length > 0) {
		const image = el("img", "link-card-image");
		image.alt = "";
		image.loading = "lazy";
		image.decoding = "async";
		image.addEventListener("error", () => image.remove());
		image.addEventListener("load", () => {
			if (state.stickToBottom) {
				scrollToBottom();
			}
		});
		image.src = attachmentUrl(images[images.length - 1], false);
		card.appendChild(image);
	}
	const host = hostnameOf(href);
	const body = el("div", "link-card-body");
	const title = el("div", "link-card-title", msg.linkTitle || host || msg.text || "Link");
	title.dir = "auto";
	body.appendChild(title);
	const subtitle = el("div", "link-card-subtitle", msg.linkSubtitle || host || "");
	subtitle.dir = "auto";
	body.appendChild(subtitle);
	card.appendChild(body);
	return card;
}

function createUnsupportedPart(msg) {
	const part = el("div", "bubble part unsupported");
	part.dataset.part = "p:0/";
	part.appendChild(icon("phone"));
	const body = el("div", "unsupported-body");
	let title = "App message";
	if (msg.balloon === DIGITAL_TOUCH_BALLOON_ID) {
		title = "Digital Touch message";
	} else if (msg.balloon === HANDWRITING_BALLOON_ID) {
		title = "Handwritten message";
	}
	body.appendChild(el("div", "unsupported-title", title));
	body.appendChild(el("div", "unsupported-text", "Can't display this message, open it on your iPhone"));
	part.appendChild(body);
	return part;
}

function findPart(row, partId) {
	const parts = row.querySelectorAll(".part");
	if (parts.length === 0) {
		return null;
	}
	for (const part of parts) {
		if ((part.dataset.part || "") === partId) {
			return part;
		}
	}
	return parts[parts.length - 1];
}

function renderTapbackBadges(row, msg) {
	const targets = state.tapbackTargets.get(msg.guid);
	if (!targets) {
		return;
	}
	for (const assocGuid of targets) {
		const reactions = resolveTapbacks(assocGuid);
		if (reactions.length === 0) {
			continue;
		}
		const partId = assocGuid.slice(0, assocGuid.length - msg.guid.length);
		const part = findPart(row, partId);
		if (!part) {
			continue;
		}
		const box = el("div", "tapbacks");
		for (const reaction of reactions) {
			const badge = el("span", "tapback" + (reaction.fromMe ? " mine" : ""));
			badge.title = (reaction.fromMe ? "You" : reaction.sender || "Someone") + ": " + TAPBACK_LABELS[reaction.type];
			badge.appendChild(icon(TAPBACK_ICONS[reaction.type]));
			box.appendChild(badge);
		}
		part.classList.add("has-tapbacks");
		part.appendChild(box);
	}
}

function openTapbackPicker(part, msg) {
	const partGuid = (part.dataset.part || "") + msg.guid;
	const mine = resolveTapbacks(partGuid).find((reaction) => reaction.fromMe) || null;
	const picker = dom.tapbackPicker;
	clearNode(picker);
	TAPBACK_ICONS.forEach((name, type) => {
		const button = iconButton("", TAPBACK_LABELS[type], name);
		const active = mine !== null && mine.type === type;
		button.setAttribute("aria-pressed", String(active));
		button.addEventListener("click", () => {
			closeTapbackPicker();
			sendTapback(msg, partGuid, type, active);
		});
		picker.appendChild(button);
	});
	picker.appendChild(el("span", "picker-separator"));
	const remove = iconButton("delete", "Delete message", "trash");
	remove.addEventListener("click", () => {
		closeTapbackPicker();
		deleteMessage(msg);
	});
	picker.appendChild(remove);
	picker.hidden = false;
	positionTapbackPicker(part);
	state.picker = { guid: msg.guid, partGuid };
	picker.firstElementChild.focus({ preventScroll: true });
}

function positionTapbackPicker(part) {
	const container = dom.messages;
	const picker = dom.tapbackPicker;
	const containerRect = container.getBoundingClientRect();
	const partRect = part.getBoundingClientRect();
	const width = picker.offsetWidth;
	const height = picker.offsetHeight;
	let left = partRect.left - containerRect.left + container.scrollLeft;
	if (left + width > container.clientWidth - 8) {
		left = container.clientWidth - width - 8;
	}
	left = Math.max(8, left);
	let top = partRect.top - containerRect.top + container.scrollTop - height - 8;
	if (partRect.top - containerRect.top - height - 8 < 0) {
		top = partRect.bottom - containerRect.top + container.scrollTop + 8;
	}
	picker.style.left = left + "px";
	picker.style.top = top + "px";
}

function closeTapbackPicker() {
	if (!state.picker) {
		return;
	}
	state.picker = null;
	dom.tapbackPicker.hidden = true;
	clearNode(dom.tapbackPicker);
}

async function sendTapback(msg, partGuid, type, remove) {
	log("tapback.send", { guid: partGuid, type, remove });
	try {
		await api.sendTapback(partGuid, type, remove);
		registerTapback({
			guid: "local-" + Date.now() + "-" + Math.random().toString(36).slice(2),
			assocGuid: partGuid,
			assocType: (remove ? 3000 : 2000) + type,
			fromMe: true,
			identity: "me",
			sender: "",
			dateMs: Date.now()
		});
		refreshRowByGuid(msg.guid);
	} catch (error) {
		logError("tapback.failed", error, { guid: partGuid, type, remove });
		toast("Could not send the reaction: " + errorMessage(error));
	}
}

async function deleteMessage(msg) {
	if (!window.confirm("Delete this message from your iPhone? This cannot be undone.")) {
		return;
	}
	log("message.delete", { guid: msg.guid });
	try {
		await api.deleteMessage(msg.guid);
		removeMessageRecord(msg.guid);
		updateReadReceipt();
		toast("Message deleted", "success");
	} catch (error) {
		logError("message.delete.failed", error, { guid: msg.guid });
		toast("Could not delete the message: " + errorMessage(error));
	}
}

function suppressNextClick() {
	state.suppressClick = true;
	clearTimeout(state.suppressClickTimer);
	state.suppressClickTimer = setTimeout(() => {
		state.suppressClick = false;
	}, 700);
}

function messageFromTarget(target) {
	const part = target.closest(".part");
	const row = target.closest(".msg");
	if (!part || !row || !row.dataset.guid) {
		return null;
	}
	const msg = state.messageIndex.get(row.dataset.guid);
	if (!msg || msg.pending || msg.isEvent) {
		return null;
	}
	return { part, msg };
}

function handleMessageListClick(event) {
	if (state.suppressClick) {
		state.suppressClick = false;
		event.preventDefault();
		return;
	}
	const image = event.target.closest(".attachment-image");
	if (image) {
		openLightbox(image.dataset.full, image.dataset.download);
		return;
	}
	if (event.target.closest("a, video, audio, button, .tapbacks")) {
		return;
	}
	const hit = messageFromTarget(event.target);
	if (!hit) {
		return;
	}
	const partGuid = (hit.part.dataset.part || "") + hit.msg.guid;
	if (state.picker && state.picker.partGuid === partGuid) {
		closeTapbackPicker();
		return;
	}
	openTapbackPicker(hit.part, hit.msg);
}

function handleMessageContextMenu(event) {
	const hit = messageFromTarget(event.target);
	if (!hit) {
		return;
	}
	event.preventDefault();
	openTapbackPicker(hit.part, hit.msg);
}

function cancelLongPress() {
	if (state.longPress) {
		clearTimeout(state.longPress.timer);
		state.longPress = null;
	}
}

function handlePointerDown(event) {
	if (event.pointerType === "mouse") {
		return;
	}
	const hit = messageFromTarget(event.target);
	if (!hit) {
		return;
	}
	cancelLongPress();
	state.longPress = {
		startX: event.clientX,
		startY: event.clientY,
		timer: setTimeout(() => {
			state.longPress = null;
			suppressNextClick();
			openTapbackPicker(hit.part, hit.msg);
		}, LONG_PRESS_MS)
	};
}

function handlePointerMove(event) {
	if (!state.longPress) {
		return;
	}
	if (Math.abs(event.clientX - state.longPress.startX) > LONG_PRESS_MOVE_PX || Math.abs(event.clientY - state.longPress.startY) > LONG_PRESS_MOVE_PX) {
		cancelLongPress();
	}
}

function setupMessageInteractions() {
	dom.messageList.addEventListener("click", handleMessageListClick);
	dom.messageList.addEventListener("contextmenu", handleMessageContextMenu);
	dom.messageList.addEventListener("pointerdown", handlePointerDown);
	dom.messageList.addEventListener("pointermove", handlePointerMove, { passive: true });
	dom.messageList.addEventListener("pointerup", cancelLongPress);
	dom.messageList.addEventListener("pointercancel", cancelLongPress);
	dom.messageList.addEventListener("pointerleave", cancelLongPress);
	dom.messages.addEventListener("scroll", () => {
		state.stickToBottom = isNearBottom();
		cancelLongPress();
		closeTapbackPicker();
	}, { passive: true });
	document.addEventListener("pointerdown", (event) => {
		if (state.picker && !dom.tapbackPicker.contains(event.target) && !event.target.closest(".part")) {
			closeTapbackPicker();
		}
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && state.picker) {
			closeTapbackPicker();
		}
	});
	dom.loadOlderButton.addEventListener("click", () => loadOlderMessages());
}

function highlightMessage(guid) {
	const node = state.nodes.get(guid) || state.nodes.get(stripPart(guid));
	if (!node) {
		toast("That message is not in the loaded history yet", "info");
		return;
	}
	node.scrollIntoView({ block: "center" });
	state.stickToBottom = isNearBottom();
	node.classList.add("highlight");
	setTimeout(() => node.classList.remove("highlight"), 2000);
}

function computeReadReceiptGuid() {
	for (let index = state.messages.length - 1; index >= 0; index -= 1) {
		const msg = state.messages[index];
		if (msg.fromMe && !msg.pending && msg.imessage && msg.dateReadMs) {
			return msg.guid;
		}
	}
	return null;
}

function updateReadReceipt() {
	const next = computeReadReceiptGuid();
	if (next === state.readReceiptGuid) {
		return;
	}
	const previous = state.readReceiptGuid;
	state.readReceiptGuid = next;
	refreshRowByGuid(previous);
	refreshRowByGuid(next);
}

function handleReadMessage(data) {
	if (!data || typeof data !== "object") {
		return;
	}
	const guid = stringField(data, "guid");
	const msg = state.messageIndex.get(guid) || state.messageIndex.get(stripPart(guid));
	if (!msg) {
		return;
	}
	const readMs = timestampMs(data.date_read_unix, data.date_read);
	msg.dateReadMs = readMs === null ? Date.now() : readMs;
	log("message.read", { guid: msg.guid });
	const wasNearBottom = isNearBottom();
	updateReadReceipt();
	if (state.readReceiptGuid === msg.guid) {
		refreshRowByGuid(msg.guid);
	}
	if (wasNearBottom) {
		scrollToBottom();
	}
}

function setChatTyping(chat, active) {
	if (!chat) {
		return;
	}
	clearTimeout(chat.typingTimer);
	chat.typing = active;
	if (active) {
		chat.typingTimer = setTimeout(() => setChatTyping(chat, false), TYPING_STALE_MS);
	}
	renderChatNode(chat);
	if (isCurrentChat(chat)) {
		const wasNearBottom = isNearBottom();
		dom.typingIndicator.hidden = !active;
		if (active && wasNearBottom) {
			scrollToBottom();
		}
	}
}

function handleTypingEvent(data) {
	if (!data || typeof data !== "object") {
		return;
	}
	const chat = findChat(stringField(data, "chat"));
	if (!chat) {
		return;
	}
	setChatTyping(chat, Boolean(data.active));
}

function sendTypingState(chat, active) {
	if (!chat || !config.send_typing || chat.placeholder) {
		return;
	}
	log("typing.send", { chat: chat.id, active });
	const sent = state.socket ? state.socket.send("send-typing", { chat: chat.id, active }) : false;
	if (!sent) {
		api.setTyping(chat.id, active).catch((error) => logError("typing.fallback.failed", error, { chat: chat.id }));
	}
}

function stopTyping(chat) {
	clearTimeout(state.typingTimer);
	state.typingTimer = null;
	if (state.typingActive) {
		state.typingActive = false;
		sendTypingState(chat, false);
	}
}

function handleComposerTyping() {
	const chat = currentChat();
	if (!chat || !config.send_typing) {
		return;
	}
	if (dom.messageInput.value.length === 0) {
		stopTyping(chat);
		return;
	}
	if (!state.typingActive) {
		state.typingActive = true;
		sendTypingState(chat, true);
	}
	clearTimeout(state.typingTimer);
	state.typingTimer = setTimeout(() => stopTyping(chat), TYPING_IDLE_MS);
}

function autoGrowTextarea(textarea) {
	textarea.style.height = "auto";
	textarea.style.height = textarea.scrollHeight + "px";
}

function handleComposerKeydown(event) {
	if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) {
		return;
	}
	event.preventDefault();
	sendCurrentMessage();
}

function handleComposerPaste(event) {
	const files = event.clipboardData && event.clipboardData.files ? Array.from(event.clipboardData.files) : [];
	if (files.length === 0) {
		return;
	}
	event.preventDefault();
	addFiles(files);
}

function addFiles(fileList) {
	const files = Array.from(fileList || []);
	for (const file of files) {
		state.attachments.push({
			file,
			previewUrl: file.type && file.type.startsWith("image/") ? URL.createObjectURL(file) : null
		});
	}
	log("composer.files.added", { count: files.length, total: state.attachments.length });
	renderAttachmentStrip();
}

function removeAttachment(entry) {
	const index = state.attachments.indexOf(entry);
	if (index !== -1) {
		if (entry.previewUrl) {
			URL.revokeObjectURL(entry.previewUrl);
		}
		state.attachments.splice(index, 1);
	}
	renderAttachmentStrip();
}

function removeSelectedPhoto(path) {
	const index = state.selectedPhotos.indexOf(path);
	if (index !== -1) {
		state.selectedPhotos.splice(index, 1);
	}
	renderAttachmentStrip();
}

function createAttachmentItem({ name, meta, thumbUrl, onRemove }) {
	const item = el("div", "attachment-item");
	if (thumbUrl) {
		const thumb = el("img", "attachment-thumb");
		thumb.alt = "";
		thumb.src = thumbUrl;
		item.appendChild(thumb);
	} else {
		item.appendChild(icon("file"));
	}
	const info = el("div", "attachment-info");
	const nameNode = el("span", "attachment-name", name);
	nameNode.title = name;
	info.appendChild(nameNode);
	if (meta) {
		info.appendChild(el("span", "attachment-meta", meta));
	}
	item.appendChild(info);
	const remove = iconButton("attachment-remove", "Remove " + name, "close");
	remove.addEventListener("click", onRemove);
	item.appendChild(remove);
	return item;
}

function renderAttachmentList(container, entries, photos, removeFile, removePhoto) {
	clearNode(container);
	const fragment = document.createDocumentFragment();
	for (const entry of entries) {
		fragment.appendChild(createAttachmentItem({
			name: entry.file.name,
			meta: formatBytes(entry.file.size),
			thumbUrl: entry.previewUrl,
			onRemove: () => removeFile(entry)
		}));
	}
	for (const path of photos) {
		fragment.appendChild(createAttachmentItem({
			name: baseName(path),
			meta: "Camera roll",
			thumbUrl: api.photoUrl(path),
			onRemove: () => removePhoto(path)
		}));
	}
	container.appendChild(fragment);
	container.hidden = entries.length === 0 && photos.length === 0;
}

function renderAttachmentStrip() {
	renderAttachmentList(dom.attachmentStrip, state.attachments, state.selectedPhotos, removeAttachment, removeSelectedPhoto);
}

function clearComposerAttachments() {
	for (const entry of state.attachments) {
		if (entry.previewUrl) {
			URL.revokeObjectURL(entry.previewUrl);
		}
	}
	state.attachments = [];
	state.selectedPhotos = [];
	dom.fileInput.value = "";
	renderAttachmentStrip();
}

function setSending(sending) {
	state.sending = sending;
	dom.sendButton.disabled = sending;
	dom.attachButton.disabled = sending;
	dom.cameraRollButton.disabled = sending;
	dom.composer.classList.toggle("sending", sending);
}

function restoreComposer({ text, subject, files, photos }) {
	const current = dom.messageInput.value;
	dom.messageInput.value = current ? text + "\n" + current : text;
	if (subject && !dom.subjectInput.value) {
		dom.subjectInput.value = subject;
	}
	autoGrowTextarea(dom.messageInput);
	addFiles(files.map((entry) => entry.file));
	for (const path of photos) {
		if (!state.selectedPhotos.includes(path)) {
			state.selectedPhotos.push(path);
		}
	}
	renderAttachmentStrip();
}

async function refreshPlaceholderChat(chat) {
	await sleep(NEW_CHAT_RETRY_MS);
	try {
		const raw = await api.getChat(chat.id);
		upsertChatRecord(raw);
		if (isCurrentChat(chat)) {
			renderThreadHeader(chat);
		}
	} catch (error) {
		log("chat.placeholder.pending", { chat: chat.id, status: error && error.status });
	}
}

function showUploadProgress(ratio) {
	const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
	dom.uploadProgress.hidden = false;
	dom.uploadProgress.setAttribute("aria-valuenow", String(percent));
	dom.uploadProgressBar.style.width = percent + "%";
}

function hideUploadProgress() {
	dom.uploadProgress.hidden = true;
	dom.uploadProgressBar.style.width = "0%";
}

function addPendingBubble(chat, { text, subject, files, photos }) {
	state.pendingCounter += 1;
	const now = Date.now();
	const msg = {
		guid: "pending-" + state.pendingCounter,
		raw: null,
		chatId: chat.id,
		handle: "",
		sender: "",
		text,
		subject,
		fromMe: true,
		imessage: true,
		dateMs: now,
		appleDate: null,
		dateReadMs: null,
		attachments: [],
		balloon: "",
		assocGuid: "",
		assocType: 0,
		isTapback: false,
		isEvent: false,
		itemDescription: "",
		isGroup: chat.isGroup,
		linkTitle: "",
		linkSubtitle: "",
		linkType: "",
		pending: true,
		unconfirmed: false,
		identity: "me",
		pendingFiles: files.map((entry) => entry.file.name),
		pendingPhotos: photos.length
	};
	insertRecords([msg]);
	renderPendingRows();
	scrollToBottom();
	state.pendingSends.push(msg);
	return msg;
}

function resolvePendingSend(incoming) {
	if (state.pendingSends.length === 0) {
		return;
	}
	let index = state.pendingSends.findIndex((pending) => pending.text === incoming.text && pending.subject === incoming.subject);
	if (index === -1) {
		index = 0;
	}
	const [pending] = state.pendingSends.splice(index, 1);
	removeMessageRecord(pending.guid);
	log("send.confirmed", { pending: pending.guid, guid: incoming.guid });
}

function removePendingBubble(pending) {
	const index = state.pendingSends.indexOf(pending);
	if (index !== -1) {
		state.pendingSends.splice(index, 1);
	}
	removeMessageRecord(pending.guid);
}

function schedulePendingTimeout(pending) {
	setTimeout(async () => {
		if (!state.pendingSends.includes(pending) || pending.chatId !== state.currentChatId) {
			return;
		}
		log("send.timeout", { pending: pending.guid });
		await resyncCurrentChat();
		if (state.pendingSends.includes(pending)) {
			pending.unconfirmed = true;
			refreshRowByGuid(pending.guid);
		}
	}, PENDING_TIMEOUT_MS);
}

async function sendCurrentMessage() {
	const chat = currentChat();
	if (!chat || state.sending) {
		return;
	}
	const text = dom.messageInput.value.trim();
	const subject = config.subjects_enabled ? dom.subjectInput.value.trim() : "";
	const files = state.attachments.slice();
	const photos = state.selectedPhotos.slice();
	if (!text && !subject && files.length === 0 && photos.length === 0) {
		return;
	}
	setSending(true);
	stopTyping(chat);
	closeTapbackPicker();
	dom.messageInput.value = "";
	dom.subjectInput.value = "";
	autoGrowTextarea(dom.messageInput);
	clearComposerAttachments();
	const pending = addPendingBubble(chat, { text, subject, files, photos });
	log("send.start", { chat: chat.id, files: files.length, photos: photos.length, length: text.length });
	try {
		const progress = files.length > 0 ? showUploadProgress : null;
		const payload = { text, subject, photos, files: files.map((entry) => entry.file) };
		if (chat.placeholder) {
			await api.sendMessageToAddress(chat.id, payload, progress);
			refreshPlaceholderChat(chat);
		} else {
			await api.sendMessage(chat.id, payload, progress);
		}
		log("send.accepted", { chat: chat.id });
		schedulePendingTimeout(pending);
	} catch (error) {
		logError("send.failed", error, { chat: chat.id });
		removePendingBubble(pending);
		restoreComposer({ text, subject, files, photos });
		toast("Could not send: " + errorMessage(error));
	} finally {
		setSending(false);
		hideUploadProgress();
		if (!isTouchDevice()) {
			dom.messageInput.focus();
		}
	}
}

function hasFiles(event) {
	const types = event.dataTransfer && event.dataTransfer.types ? Array.from(event.dataTransfer.types) : [];
	return types.includes("Files");
}

function setupDragAndDrop() {
	const target = dom.threadView;
	target.addEventListener("dragenter", (event) => {
		if (!hasFiles(event)) {
			return;
		}
		event.preventDefault();
		state.dragCounter += 1;
		dom.dropOverlay.hidden = false;
	});
	target.addEventListener("dragover", (event) => {
		if (hasFiles(event)) {
			event.preventDefault();
		}
	});
	target.addEventListener("dragleave", () => {
		state.dragCounter = Math.max(0, state.dragCounter - 1);
		if (state.dragCounter === 0) {
			dom.dropOverlay.hidden = true;
		}
	});
	target.addEventListener("drop", (event) => {
		if (!hasFiles(event)) {
			return;
		}
		event.preventDefault();
		state.dragCounter = 0;
		dom.dropOverlay.hidden = true;
		addFiles(event.dataTransfer.files);
	});
}

function setupComposer() {
	dom.messageInput.addEventListener("input", () => {
		autoGrowTextarea(dom.messageInput);
		handleComposerTyping();
	});
	dom.messageInput.addEventListener("keydown", handleComposerKeydown);
	dom.messageInput.addEventListener("paste", handleComposerPaste);
	dom.subjectInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.isComposing) {
			event.preventDefault();
			dom.messageInput.focus();
		}
	});
	dom.composer.addEventListener("submit", (event) => {
		event.preventDefault();
		sendCurrentMessage();
	});
	dom.attachButton.addEventListener("click", () => dom.fileInput.click());
	dom.fileInput.addEventListener("change", () => {
		addFiles(dom.fileInput.files);
		dom.fileInput.value = "";
	});
	dom.cameraRollButton.addEventListener("click", () => openCameraRoll());
	setupDragAndDrop();
}

function photoSource(photo) {
	if (photo.path) {
		return api.photoUrl(photo.path);
	}
	return api.withToken(photo.url);
}

function createPhotoTile(photo) {
	const tile = el("button", "photo-tile");
	tile.type = "button";
	tile.setAttribute("aria-pressed", String(state.photoSelection.has(photo.path)));
	tile.setAttribute("aria-label", baseName(photo.path));
	const image = el("img");
	image.alt = "";
	image.loading = "lazy";
	image.decoding = "async";
	image.src = photoSource(photo);
	tile.appendChild(image);
	if (photo.is_favorite) {
		const heart = icon("heart");
		heart.classList.add("photo-tile-favorite");
		tile.appendChild(heart);
	}
	const check = el("span", "photo-tile-check");
	check.appendChild(icon("check"));
	tile.appendChild(check);
	tile.addEventListener("click", () => {
		if (state.photoSelection.has(photo.path)) {
			state.photoSelection.delete(photo.path);
		} else {
			state.photoSelection.add(photo.path);
		}
		tile.setAttribute("aria-pressed", String(state.photoSelection.has(photo.path)));
		updatePhotosConfirm();
	});
	return tile;
}

function updatePhotosConfirm() {
	const count = state.photoSelection.size;
	dom.photosConfirm.disabled = count === 0;
	dom.photosConfirm.textContent = count > 0 ? "Add " + count : "Add";
}

async function loadPhotos(reset) {
	if (state.photosLoading) {
		return;
	}
	state.photosLoading = true;
	dom.photosLoading.hidden = false;
	dom.photosMore.hidden = true;
	const offset = reset ? 0 : state.photosNextOffset;
	log("photos.page", { offset });
	try {
		const page = await api.getPhotos({ limit: config.defaults.photos, offset });
		const items = Array.isArray(page && page.items) ? page.items : [];
		if (reset) {
			state.photos = [];
			clearNode(dom.photosGrid);
		}
		const fragment = document.createDocumentFragment();
		for (const raw of items) {
			if (!raw || typeof raw !== "object" || !raw.path) {
				continue;
			}
			state.photos.push(raw);
			fragment.appendChild(createPhotoTile(raw));
		}
		dom.photosGrid.appendChild(fragment);
		const nextOffset = page && page.next_offset !== null && page.next_offset !== undefined ? Number(page.next_offset) : null;
		state.photosHasMore = Boolean(page && page.has_more) && nextOffset !== null;
		state.photosNextOffset = state.photosHasMore ? nextOffset : state.photos.length;
		dom.photosEmpty.hidden = state.photos.length > 0;
	} catch (error) {
		logError("photos.page.failed", error, { offset });
		toast("Could not load the camera roll: " + errorMessage(error));
	} finally {
		state.photosLoading = false;
		dom.photosLoading.hidden = true;
		dom.photosMore.hidden = !state.photosHasMore;
	}
}

function clearPhotoSelection() {
	state.photoSelection.clear();
	for (const tile of dom.photosGrid.querySelectorAll(".photo-tile")) {
		tile.setAttribute("aria-pressed", "false");
	}
	updatePhotosConfirm();
}

function openCameraRoll() {
	clearPhotoSelection();
	openDialog(dom.photosDialog);
	if (state.photos.length === 0) {
		loadPhotos(true);
	}
}

function confirmPhotos() {
	for (const path of state.photoSelection) {
		if (!state.selectedPhotos.includes(path)) {
			state.selectedPhotos.push(path);
		}
	}
	log("photos.selected", { count: state.photoSelection.size });
	clearPhotoSelection();
	renderAttachmentStrip();
	closeDialog(dom.photosDialog);
}

function setupPhotos() {
	dom.photosCancel.addEventListener("click", () => {
		clearPhotoSelection();
		closeDialog(dom.photosDialog);
	});
	dom.photosConfirm.addEventListener("click", () => confirmPhotos());
	dom.photosMore.addEventListener("click", () => loadPhotos(false));
	dom.photosDialog.addEventListener("close", () => clearPhotoSelection());
}

function renderComposeAttachments() {
	renderAttachmentList(dom.composeAttachments, state.composeAttachments, [], (entry) => {
		const index = state.composeAttachments.indexOf(entry);
		if (index !== -1) {
			if (entry.previewUrl) {
				URL.revokeObjectURL(entry.previewUrl);
			}
			state.composeAttachments.splice(index, 1);
		}
		renderComposeAttachments();
	}, () => {});
}

function resetComposeDialog() {
	for (const entry of state.composeAttachments) {
		if (entry.previewUrl) {
			URL.revokeObjectURL(entry.previewUrl);
		}
	}
	state.composeAttachments = [];
	state.composeSuggestSeq += 1;
	clearTimeout(state.composeSuggestTimer);
	dom.composeTo.value = "";
	dom.composeText.value = "";
	dom.composeFileInput.value = "";
	dom.composeSuggestions.hidden = true;
	dom.composeTo.setAttribute("aria-expanded", "false");
	clearNode(dom.composeSuggestions);
	renderComposeAttachments();
	dom.composeSend.disabled = false;
}

function openCompose(prefillTo) {
	resetComposeDialog();
	dom.composeTo.value = prefillTo || "";
	openDialog(dom.composeDialog);
	if (prefillTo) {
		dom.composeText.focus();
	} else {
		dom.composeTo.focus();
	}
}

function mergeSuggestions(byAddress, byName) {
	const seen = new Set();
	const result = [];
	const push = (name, address) => {
		const key = String(address || "").trim();
		if (!key || seen.has(key) || result.length >= MAX_SUGGESTIONS) {
			return;
		}
		seen.add(key);
		result.push({ name: name || key, address: key });
	};
	const addressItems = byAddress && Array.isArray(byAddress.items) ? byAddress.items : [];
	for (const item of addressItems) {
		push(item.display_name, item.chat_id);
	}
	const nameItems = byName && Array.isArray(byName.items) ? byName.items : [];
	for (const item of nameItems) {
		const addresses = Array.isArray(item.addresses) ? item.addresses : [];
		for (const address of addresses) {
			push(item.name, address);
		}
	}
	return result;
}

function renderComposeSuggestions(items) {
	clearNode(dom.composeSuggestions);
	dom.composeSuggestions.hidden = items.length === 0;
	dom.composeTo.setAttribute("aria-expanded", String(items.length > 0));
	const fragment = document.createDocumentFragment();
	for (const item of items) {
		const button = el("button", "suggestion");
		button.type = "button";
		button.setAttribute("role", "option");
		button.appendChild(el("span", "suggestion-name", item.name));
		button.appendChild(el("span", "suggestion-address", item.address));
		button.addEventListener("click", () => {
			dom.composeTo.value = item.address;
			clearNode(dom.composeSuggestions);
			dom.composeSuggestions.hidden = true;
			dom.composeTo.setAttribute("aria-expanded", "false");
			dom.composeText.focus();
		});
		fragment.appendChild(button);
	}
	dom.composeSuggestions.appendChild(fragment);
}

async function fetchComposeSuggestions(query) {
	state.composeSuggestSeq += 1;
	const seq = state.composeSuggestSeq;
	log("compose.suggest", { query });
	const [byAddress, byName] = await Promise.all([
		api.matchContacts(query, "address").catch((error) => {
			logError("compose.suggest.address", error, { query });
			return null;
		}),
		api.matchContacts(query, "name").catch((error) => {
			logError("compose.suggest.name", error, { query });
			return null;
		})
	]);
	if (seq !== state.composeSuggestSeq) {
		return;
	}
	renderComposeSuggestions(mergeSuggestions(byAddress, byName));
}

function handleComposeToInput() {
	clearTimeout(state.composeSuggestTimer);
	const query = dom.composeTo.value.trim();
	if (query.length < 2) {
		state.composeSuggestSeq += 1;
		clearNode(dom.composeSuggestions);
		dom.composeSuggestions.hidden = true;
		dom.composeTo.setAttribute("aria-expanded", "false");
		return;
	}
	state.composeSuggestTimer = setTimeout(() => fetchComposeSuggestions(query), SUGGEST_DEBOUNCE_MS);
}

async function openSentConversation(chatId) {
	let chat = null;
	try {
		chat = await ensureChat(chatId, NEW_CHAT_RETRIES);
	} catch (error) {
		chat = null;
	}
	if (chat) {
		await openChat(chat.id, { force: true });
		return;
	}
	await openChat(chatId, { allowPlaceholder: true, force: true });
}

async function submitCompose() {
	const to = dom.composeTo.value.trim();
	const text = dom.composeText.value.trim();
	const files = state.composeAttachments.map((entry) => entry.file);
	if (!to) {
		toast("Enter a phone number or email address");
		dom.composeTo.focus();
		return;
	}
	if (!text && files.length === 0) {
		toast("Enter a message or attach a file");
		dom.composeText.focus();
		return;
	}
	if (dom.composeSend.disabled) {
		return;
	}
	dom.composeSend.disabled = true;
	log("compose.send", { to, files: files.length });
	try {
		const response = await api.sendMessageToAddress(to, { text, subject: "", photos: [], files }, null);
		const chatId = response && typeof response.chat_id === "string" && response.chat_id ? response.chat_id : to;
		closeDialog(dom.composeDialog);
		resetComposeDialog();
		toast("Message sent", "success");
		await openSentConversation(chatId);
	} catch (error) {
		logError("compose.send.failed", error, { to });
		toast("Could not send: " + errorMessage(error));
		dom.composeSend.disabled = false;
	}
}

function setupCompose() {
	dom.composeButton.addEventListener("click", () => openCompose(""));
	dom.composeCancel.addEventListener("click", () => {
		closeDialog(dom.composeDialog);
		resetComposeDialog();
	});
	dom.composeForm.addEventListener("submit", (event) => {
		event.preventDefault();
		submitCompose();
	});
	dom.composeTo.addEventListener("input", handleComposeToInput);
	dom.composeTo.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.isComposing) {
			event.preventDefault();
			const first = dom.composeSuggestions.querySelector(".suggestion");
			if (first && !dom.composeSuggestions.hidden) {
				first.click();
			} else {
				dom.composeText.focus();
			}
		} else if (event.key === "ArrowDown" && !dom.composeSuggestions.hidden) {
			event.preventDefault();
			const first = dom.composeSuggestions.querySelector(".suggestion");
			if (first) {
				first.focus();
			}
		}
	});
	dom.composeText.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
			event.preventDefault();
			submitCompose();
		}
	});
	dom.composeText.addEventListener("paste", (event) => {
		const files = event.clipboardData && event.clipboardData.files ? Array.from(event.clipboardData.files) : [];
		if (files.length > 0) {
			event.preventDefault();
			addComposeFiles(files);
		}
	});
	dom.composeAttachButton.addEventListener("click", () => dom.composeFileInput.click());
	dom.composeFileInput.addEventListener("change", () => {
		addComposeFiles(dom.composeFileInput.files);
		dom.composeFileInput.value = "";
	});
	dom.composeDialog.addEventListener("close", () => resetComposeDialog());
}

function addComposeFiles(fileList) {
	for (const file of Array.from(fileList || [])) {
		state.composeAttachments.push({
			file,
			previewUrl: file.type && file.type.startsWith("image/") ? URL.createObjectURL(file) : null
		});
	}
	renderComposeAttachments();
}

function setupSearch() {
	dom.searchInput.addEventListener("input", () => {
		clearTimeout(state.filterTimer);
		state.filterTimer = setTimeout(() => {
			state.filterQuery = dom.searchInput.value;
			applyChatFilter();
		}, 80);
	});
	dom.searchInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.isComposing) {
			event.preventDefault();
			runSearch();
		} else if (event.key === "Escape") {
			dom.searchInput.value = "";
			state.filterQuery = "";
			applyChatFilter();
			closeSearchResults();
		}
	});
	dom.searchInput.addEventListener("search", () => {
		state.filterQuery = dom.searchInput.value;
		applyChatFilter();
		if (!dom.searchInput.value) {
			closeSearchResults();
		}
	});
	dom.searchButton.addEventListener("click", () => runSearch());
	dom.searchClose.addEventListener("click", () => closeSearchResults());
}

function closeSearchResults() {
	dom.searchResults.hidden = true;
	clearNode(dom.searchResultsList);
}

async function runSearch() {
	const query = dom.searchInput.value.trim();
	if (!query) {
		closeSearchResults();
		return;
	}
	dom.searchResults.hidden = false;
	dom.searchResultsTitle.textContent = "Searching for “" + query + "”…";
	clearNode(dom.searchResultsList);
	const spinner = el("div", "spinner");
	dom.searchResultsList.appendChild(spinner);
	log("search.run", { query });
	try {
		const result = await api.search(query, {});
		if (dom.searchInput.value.trim() !== query) {
			return;
		}
		renderSearchResults(query, result);
	} catch (error) {
		logError("search.failed", error, { query });
		closeSearchResults();
		toast("Search failed: " + errorMessage(error));
	}
}

function appendHighlightedText(container, text, query) {
	const lower = text.toLowerCase();
	const needle = query.toLowerCase();
	let index = 0;
	if (!needle) {
		container.textContent = text;
		return;
	}
	let found = lower.indexOf(needle, index);
	while (found !== -1) {
		if (found > index) {
			container.appendChild(document.createTextNode(text.slice(index, found)));
		}
		container.appendChild(el("mark", "", text.slice(found, found + needle.length)));
		index = found + needle.length;
		found = lower.indexOf(needle, index);
	}
	if (index < text.length) {
		container.appendChild(document.createTextNode(text.slice(index)));
	}
}

function searchResultChatName(item) {
	const chat = findChat(stringField(item, "chat_identifier"));
	if (chat) {
		return chat.name;
	}
	return stringField(item, "display_name") || stringField(item, "chat_identifier") || "Unknown";
}

function createSearchResult(item, query) {
	const button = el("button", "search-result");
	button.type = "button";
	const top = el("div", "search-result-top");
	const name = el("span", "search-result-name", searchResultChatName(item));
	name.dir = "auto";
	top.appendChild(name);
	const ms = timestampMs(item.date_unix, item.date);
	top.appendChild(el("span", "search-result-time", ms === null ? "" : relativeTimeLabel(ms)));
	button.appendChild(top);
	const snippet = el("div", "search-result-snippet");
	snippet.dir = "auto";
	const text = stringField(item, "text") || (item.cache_has_attachments ? "Attachment" : "");
	appendHighlightedText(snippet, text, query);
	button.appendChild(snippet);
	button.addEventListener("click", () => {
		openChat(stringField(item, "chat_identifier"), { scrollToGuid: stringField(item, "guid") });
	});
	return button;
}

function createContactResult(contact) {
	const button = el("button", "search-result");
	button.type = "button";
	const top = el("div", "search-result-top");
	const name = el("span", "search-result-name", stringField(contact, "display_name") || stringField(contact, "chat_id"));
	name.dir = "auto";
	top.appendChild(name);
	button.appendChild(top);
	button.appendChild(el("div", "search-result-snippet", stringField(contact, "chat_id")));
	button.addEventListener("click", () => openChat(stringField(contact, "chat_id"), { allowPlaceholder: true }));
	return button;
}

function renderSearchResults(query, result) {
	clearNode(dom.searchResultsList);
	const items = Array.isArray(result && result.items) ? result.items.slice() : [];
	items.sort((a, b) => (Number(b.date_unix) || 0) - (Number(a.date_unix) || 0));
	const contacts = Array.isArray(result && result.contacts) ? result.contacts : [];
	dom.searchResultsTitle.textContent = items.length + (items.length === 1 ? " result" : " results") + " for “" + query + "”";
	const fragment = document.createDocumentFragment();
	if (items.length > 0) {
		fragment.appendChild(el("div", "search-section", "Messages"));
		for (const item of items) {
			fragment.appendChild(createSearchResult(item, query));
		}
	}
	if (contacts.length > 0) {
		fragment.appendChild(el("div", "search-section", "Contacts"));
		for (const contact of contacts) {
			fragment.appendChild(createContactResult(contact));
		}
	}
	if (items.length === 0 && contacts.length === 0) {
		fragment.appendChild(el("div", "list-empty", "No messages match your search"));
	}
	dom.searchResultsList.appendChild(fragment);
	log("search.rendered", { query, items: items.length, contacts: contacts.length });
}

function openDeleteChatDialog() {
	const chat = currentChat();
	if (!chat) {
		return;
	}
	dom.deleteIdentifier.textContent = chat.id;
	dom.deleteInput.value = "";
	dom.deleteConfirm.disabled = true;
	openDialog(dom.deleteDialog);
	dom.deleteInput.focus();
}

async function deleteCurrentChat() {
	const chat = currentChat();
	if (!chat || dom.deleteInput.value.trim() !== chat.id || dom.deleteConfirm.disabled) {
		return;
	}
	dom.deleteConfirm.disabled = true;
	log("chat.delete", { chat: chat.id });
	try {
		await api.deleteChat(chat.id);
		closeDialog(dom.deleteDialog);
		removeChat(chat);
		closeThread();
		toast("Conversation deleted", "success");
	} catch (error) {
		logError("chat.delete.failed", error, { chat: chat.id });
		toast("Could not delete the conversation: " + errorMessage(error));
		dom.deleteConfirm.disabled = false;
	}
}

function setupDeleteDialog() {
	dom.deleteInput.addEventListener("input", () => {
		const chat = currentChat();
		dom.deleteConfirm.disabled = !chat || dom.deleteInput.value.trim() !== chat.id;
	});
	dom.deleteForm.addEventListener("submit", (event) => {
		event.preventDefault();
		deleteCurrentChat();
	});
	dom.deleteCancel.addEventListener("click", () => closeDialog(dom.deleteDialog));
}

function openLightbox(url, downloadUrl) {
	dom.lightboxImage.src = url;
	dom.lightboxDownload.href = downloadUrl || url;
	openDialog(dom.lightbox);
	dom.lightboxClose.focus();
}

function setupLightbox() {
	dom.lightboxClose.addEventListener("click", () => closeDialog(dom.lightbox));
	dom.lightbox.addEventListener("click", (event) => {
		if (event.target === dom.lightbox || event.target === dom.lightboxImage) {
			closeDialog(dom.lightbox);
		}
	});
	dom.lightbox.addEventListener("close", () => {
		dom.lightboxImage.removeAttribute("src");
	});
}

function markChatRead(chat) {
	if (!chat) {
		return;
	}
	const wasUnread = chat.unread;
	chat.unread = false;
	if (wasUnread) {
		renderChatNode(chat);
	}
	updateTitle();
	if (!config.mark_when_read || chat.placeholder) {
		return;
	}
	log("chat.read", { chat: chat.id });
	api.markChatRead(chat.id).catch((error) => logError("chat.read.failed", error, { chat: chat.id }));
}

function applyChatUpdate(chat, msg) {
	chat.latestText = messagePreview(msg, chat);
	chat.timeMs = msg.dateMs;
	chat.relativeTime = relativeTimeLabel(msg.dateMs);
	if (!msg.fromMe && !(isCurrentChat(chat) && pageActive())) {
		chat.unread = true;
	}
	if (!msg.fromMe && !msg.isTapback) {
		setChatTyping(chat, false);
	}
	moveChatToTop(chat);
	renderChatNode(chat);
	updateTitle();
}

function appendToThread(msg) {
	if (msg.isTapback) {
		const target = registerTapback(msg);
		if (target) {
			refreshRowByGuid(stripPart(target));
		}
		return;
	}
	if ((msg.isEvent && !msg.itemDescription) || state.messageIndex.has(msg.guid)) {
		return;
	}
	const wasNearBottom = isNearBottom();
	if (msg.fromMe) {
		resolvePendingSend(msg);
	}
	insertRecords([msg]);
	renderPendingRows();
	updateReadReceipt();
	if (wasNearBottom || msg.fromMe) {
		scrollToBottom();
	}
}

async function handleNewMessage(data) {
	const msg = normalizeMessage(data);
	if (!msg) {
		log("ws.new-message.ignored", { data });
		return;
	}
	log("ws.new-message", { guid: msg.guid, chat: msg.chatId, fromMe: msg.fromMe, tapback: msg.isTapback });
	let chat = findChatForMessage(msg);
	if (!chat && msg.chatId) {
		chat = await ensureChat(msg.chatId, 1).catch(() => null);
	}
	if (!chat) {
		logError("ws.new-message.unknown-chat", null, { chat: msg.chatId });
		loadChats({ reset: true });
		return;
	}
	applyChatUpdate(chat, msg);
	if (isCurrentChat(chat)) {
		trackNewestDate(msg.appleDate);
		appendToThread(msg);
		if (!msg.fromMe && pageActive()) {
			markChatRead(chat);
		}
	}
	showNotification(chat, msg);
}

function socketUrl() {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	let url;
	if (config.socket_subdirectory) {
		const subdirectory = String(config.socket_subdirectory).replace(/^\/+|\/+$/g, "");
		url = scheme + "://" + location.host + "/" + subdirectory;
	} else {
		url = scheme + "://" + location.hostname + ":" + config.socket_port + "/";
	}
	if (config.token) {
		url += "?token=" + encodeURIComponent(config.token);
	}
	return url;
}

function certificateTrustUrl() {
	return "https://" + location.hostname + ":" + config.socket_port + "/";
}

function showConnectionBanner(text) {
	dom.connectionBannerText.textContent = text;
	dom.connectionBanner.hidden = false;
}

function hideConnectionBanner() {
	dom.connectionBanner.hidden = true;
}

function showCertBanner() {
	if (state.certBannerDismissed) {
		return;
	}
	dom.certLink.href = certificateTrustUrl();
	dom.certLink.textContent = certificateTrustUrl();
	dom.certBanner.hidden = false;
}

function hideCertBanner() {
	dom.certBanner.hidden = true;
}

async function resyncAfterReconnect() {
	log("ws.resync", { chat: state.currentChatId });
	await loadChats({ reset: true });
	await resyncCurrentChat();
}

function setupSocket() {
	const socket = new SMServerSocket({ url: socketUrl(), pingInterval: 25000, minDelay: 1000, maxDelay: 30000 });
	state.socket = socket;
	socket.on("open", ({ reconnected }) => {
		hideConnectionBanner();
		hideCertBanner();
		if (reconnected) {
			resyncAfterReconnect();
		}
	});
	socket.on("close", ({ everConnected }) => {
		showConnectionBanner("Reconnecting…");
		if (!everConnected && location.protocol === "https:" && !config.socket_subdirectory) {
			showCertBanner();
		}
	});
	socket.on("reconnecting", ({ attempt, delay }) => {
		showConnectionBanner("Reconnecting… (attempt " + attempt + ", next try in " + Math.round(delay / 1000) + "s)");
	});
	socket.on("hello", (data) => log("ws.hello", { data }));
	socket.on("battery-status", handleBattery);
	socket.on("new-message", (data) => {
		handleNewMessage(data).catch((error) => logError("ws.new-message.failed", error, {}));
	});
	socket.on("typing", handleTypingEvent);
	socket.on("read-message", handleReadMessage);
	socket.on("pong", (data, frame) => log("ws.pong", { id: frame && frame.id }));
	dom.certBannerClose.addEventListener("click", () => {
		state.certBannerDismissed = true;
		hideCertBanner();
	});
	socket.connect();
}

function showPane(pane) {
	const showThread = pane === "thread";
	dom.app.classList.toggle("show-thread", showThread);
	if (showThread && isMobileLayout() && !state.pushedHistory) {
		state.pushedHistory = true;
		history.pushState({ smserverThread: true }, "");
	}
}

function handleBack() {
	if (state.pushedHistory) {
		history.back();
		return;
	}
	closeThread();
}

function setupHistory() {
	window.addEventListener("popstate", () => {
		if (state.pushedHistory) {
			state.pushedHistory = false;
			closeThread();
		}
	});
}

function setupFocusHandlers() {
	const onActive = () => {
		const chat = currentChat();
		if (chat && chat.unread) {
			markChatRead(chat);
		}
		if (state.socket && document.visibilityState === "visible") {
			state.socket.reconnectNow();
		}
	};
	window.addEventListener("focus", onActive);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") {
			onActive();
		}
	});
}

function setupViewport() {
	if (!window.visualViewport) {
		return;
	}
	const update = () => {
		document.documentElement.style.setProperty("--viewport-height", Math.round(window.visualViewport.height) + "px");
		dom.app.classList.add("viewport-sized");
		if (state.stickToBottom && state.currentChatId) {
			scrollToBottom();
		}
	};
	window.visualViewport.addEventListener("resize", update);
	window.visualViewport.addEventListener("scroll", () => {
		if (document.activeElement === dom.messageInput) {
			window.scrollTo(0, 0);
		}
	});
}

function applyServerInfo(info) {
	if (!info || typeof info !== "object") {
		return;
	}
	const server = info.server && typeof info.server === "object" ? info.server : {};
	const features = info.features && typeof info.features === "object" ? info.features : {};
	if (Number.isFinite(Number(server.socket_port)) && Number(server.socket_port) > 0) {
		config.socket_port = Number(server.socket_port);
	}
	if (server.socket_subdirectory !== undefined) {
		config.socket_subdirectory = server.socket_subdirectory || null;
	}
	if (typeof server.secure === "boolean") {
		config.secure = server.secure;
	}
	if (typeof info.theme === "string") {
		config.theme = info.theme;
	}
	for (const key of ["subjects_enabled", "send_typing", "mark_when_read"]) {
		if (typeof features[key] === "boolean") {
			config[key] = features[key];
		}
	}
	if (info.defaults && typeof info.defaults === "object") {
		config.defaults = { ...config.defaults, ...info.defaults };
	}
	if (typeof info.version === "string") {
		config.version = info.version;
	}
	if (info.battery) {
		handleBattery(info.battery);
	}
}

async function loadServerInfoIfNeeded() {
	if (config.injected) {
		return;
	}
	log("config.fallback", {});
	try {
		applyServerInfo(await api.getServer());
		applyTheme(initialTheme(), false);
	} catch (error) {
		logError("config.fallback.failed", error, {});
		toast("Could not load server settings, using defaults");
	}
}

function setupThread() {
	setupThreadObservers();
	setupMessageInteractions();
	dom.deleteChatButton.addEventListener("click", () => openDeleteChatDialog());
	dom.backButton.addEventListener("click", () => handleBack());
}

async function init() {
	bindDom();
	api.onUnauthorized = () => {
		logError("auth.lost", null, {});
		location.reload();
	};
	applyTheme(initialTheme(), false);
	setupMenu();
	setupNotifications();
	setupSearch();
	setupComposer();
	setupCompose();
	setupPhotos();
	setupDeleteDialog();
	setupLightbox();
	setupThread();
	setupHistory();
	setupFocusHandlers();
	setupViewport();
	await loadServerInfoIfNeeded();
	dom.subjectInput.hidden = !config.subjects_enabled;
	dom.versionLabel.textContent = config.version ? "SMServer " + config.version : "SMServer";
	setupSocket();
	await loadChats({ reset: true });
	setupChatObserver();
	log("app.ready", { chats: state.chats.length });
}

document.addEventListener("DOMContentLoaded", () => {
	init().catch((error) => {
		logError("app.init.failed", error, {});
		toast("SMServer failed to start: " + errorMessage(error));
	});
});
