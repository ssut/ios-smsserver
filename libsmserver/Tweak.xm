#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>
#import "Tweak.h"
#import "SMSIPC.h"

static void SMSFileLog(NSString *line) {
	static dispatch_queue_t queue = nil;
	static dispatch_once_t onceToken;
	dispatch_once(&onceToken, ^{
		queue = dispatch_queue_create("com.ianwelker.smserver.tweaklog", DISPATCH_QUEUE_SERIAL);
	});
	NSDate *now = [NSDate date];
	dispatch_async(queue, ^{
		static NSISO8601DateFormatter *formatter = nil;
		if (!formatter) {
			formatter = [[NSISO8601DateFormatter alloc] init];
			formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
		}
		const char *path = "/var/mobile/Library/SMServer/springboard.log";
		struct stat st;
		if (stat(path, &st) == 0 && st.st_size > 2 * 1024 * 1024) {
			rename(path, "/var/mobile/Library/SMServer/springboard.log.1");
		}
		FILE *fp = fopen(path, "a");
		if (!fp) return;
		fprintf(fp, "%s %s\n", [formatter stringFromDate:now].UTF8String, line.UTF8String);
		fclose(fp);
	});
}

#define SMSLog(fmt, ...) do { NSString *smsLine = [NSString stringWithFormat:@"[libsmserver] pid=%d " fmt, getpid(), ##__VA_ARGS__]; NSLog(@"%@", smsLine); SMSFileLog(smsLine); } while (0)

static unsigned long long const SMSModernCapabilities = 4485895ULL;
static unsigned int const SMSLegacyCapabilities = 17159;
static NSString *const SMSTweakVersion = @"0.9.2";
static BOOL SMSInSpringBoard = NO;

static id SMSRunOnMain(NSString *label, id (^block)(void)) {
	__block id result = nil;
	void (^wrapped)(void) = ^{
		@try {
			result = block();
		} @catch (NSException *exception) {
			SMSLog(@"event=main_block_exception label=%@ name=%@ reason=\"%@\"", label, exception.name, exception.reason);
			result = nil;
		}
	};
	if ([NSThread isMainThread]) {
		wrapped();
	} else {
		dispatch_sync(dispatch_get_main_queue(), wrapped);
	}
	return result;
}

static NSString *SMSStringArg(id dict, NSString *key) {
	if (![dict isKindOfClass:[NSDictionary class]]) return nil;
	id value = dict[key];
	return [value isKindOfClass:[NSString class]] ? value : nil;
}

static dispatch_queue_t SMSEventQueue(void) {
	static dispatch_queue_t queue = nil;
	static dispatch_once_t onceToken;
	dispatch_once(&onceToken, ^{
		queue = dispatch_queue_create("com.ianwelker.smserver.events", DISPATCH_QUEUE_SERIAL);
	});
	return queue;
}

static void SMSEmitEvent(NSString *method, id args) {
	if (!SMSInSpringBoard || !args) return;
	dispatch_async(SMSEventQueue(), ^{
		@autoreleasepool {
			BOOL delivered = SMSIPCSendOneway(SMSIPC_APP_SOCKET, method, args, 2.0);
			SMSLog(@"event=app_event method=%@ delivered=%d", method, delivered);
		}
	});
}

static BOOL SMSDaemonIsConnected(IMDaemonController *controller) {
	NSNumber *connected = SMSRunOnMain(@"daemon_is_connected", ^id{
		return @([controller respondsToSelector:@selector(isConnected)] && [controller isConnected]);
	});
	return connected.boolValue;
}

static BOOL SMSEnsureDaemonConnected(double timeoutSeconds) {
	IMDaemonController *controller = SMSRunOnMain(@"daemon_lookup", ^id{
		return [%c(IMDaemonController) sharedController];
	});
	if (!controller) {
		SMSLog(@"event=daemon_controller_missing");
		return NO;
	}
	if (SMSDaemonIsConnected(controller)) return YES;
	NSNumber *started = SMSRunOnMain(@"daemon_connect", ^id{
		BOOL ok = NO;
		NSString *mode = nil;
		if ([controller respondsToSelector:@selector(connectToDaemonWithLaunch:capabilities:blockUntilConnected:)]) {
			ok = [controller connectToDaemonWithLaunch:YES capabilities:SMSModernCapabilities blockUntilConnected:NO];
			mode = @"capabilities";
		} else {
			ok = [controller connectToDaemon];
			mode = @"legacy";
		}
		SMSLog(@"event=daemon_connect_requested mode=%@ result=%d", mode, ok);
		return @(ok);
	});
	if ([NSThread isMainThread]) return SMSDaemonIsConnected(controller);
	CFAbsoluteTime startedAt = CFAbsoluteTimeGetCurrent();
	while (CFAbsoluteTimeGetCurrent() - startedAt < timeoutSeconds) {
		if (SMSDaemonIsConnected(controller)) {
			SMSLog(@"event=daemon_connected waited_ms=%.0f requested=%@", (CFAbsoluteTimeGetCurrent() - startedAt) * 1000.0, started);
			return YES;
		}
		usleep(50000);
	}
	SMSLog(@"event=daemon_connect_timeout timeout_s=%.1f", timeoutSeconds);
	return NO;
}

static BOOL SMSAccountIsUsable(IMAccount *account) {
	if (!account) return NO;
	if ([account respondsToSelector:@selector(isActive)] && ![account isActive]) return NO;
	if ([account respondsToSelector:@selector(isOperational)] && ![account isOperational]) return NO;
	return YES;
}

static NSString *SMSAccountService(IMAccount *account) {
	return [account respondsToSelector:@selector(serviceName)] ? ([account serviceName] ?: @"?") : @"?";
}

static IMAccount *SMSUsableSMSAccount(void) {
	IMAccountController *controller = [%c(IMAccountController) sharedInstance];
	IMAccount *account = [controller respondsToSelector:@selector(activeSMSAccount)] ? [controller activeSMSAccount] : nil;
	if (SMSAccountIsUsable(account)) return account;
	Class serviceClass = %c(IMServiceImpl);
	if ([controller respondsToSelector:@selector(bestAccountForService:)] && [serviceClass respondsToSelector:@selector(smsService)]) {
		id service = [serviceClass smsService];
		account = service ? [controller bestAccountForService:service] : nil;
		if (SMSAccountIsUsable(account)) return account;
	}
	if ([controller respondsToSelector:@selector(accounts)]) {
		for (IMAccount *candidate in [controller accounts]) {
			if ([SMSAccountService(candidate) isEqualToString:@"SMS"] && SMSAccountIsUsable(candidate)) return candidate;
		}
	}
	return nil;
}

static IMAccount *SMSAccountForAddress(NSString *address) {
	IMAccountController *controller = [%c(IMAccountController) sharedInstance];
	NSMutableArray *candidates = [NSMutableArray array];
	NSMutableArray *sources = [NSMutableArray array];
	if ([controller respondsToSelector:@selector(__ck_bestAccountForAddress:)]) {
		id account = [controller __ck_bestAccountForAddress:address];
		if (account) { [candidates addObject:account]; [sources addObject:@"ck_best"]; }
	}
	if ([controller respondsToSelector:@selector(activeIMessageAccount)]) {
		id account = [controller activeIMessageAccount];
		if (account) { [candidates addObject:account]; [sources addObject:@"active_imessage"]; }
	}
	if ([controller respondsToSelector:@selector(activeSMSAccount)]) {
		id account = [controller activeSMSAccount];
		if (account) { [candidates addObject:account]; [sources addObject:@"active_sms"]; }
	}
	Class serviceClass = %c(IMServiceImpl);
	if ([controller respondsToSelector:@selector(bestAccountForService:)] && [serviceClass respondsToSelector:@selector(smsService)]) {
		id service = [serviceClass smsService];
		id account = service ? [controller bestAccountForService:service] : nil;
		if (account) { [candidates addObject:account]; [sources addObject:@"best_sms"]; }
	}
	for (NSUInteger idx = 0; idx < candidates.count; idx++) {
		IMAccount *account = candidates[idx];
		if (SMSAccountIsUsable(account)) {
			SMSLog(@"event=account_selected source=%@ service=%@ candidates=%lu", sources[idx], [account respondsToSelector:@selector(serviceName)] ? [account serviceName] : @"?", (unsigned long)candidates.count);
			return account;
		}
	}
	IMAccount *fallback = candidates.firstObject;
	SMSLog(@"event=account_fallback source=%@ candidates=%lu", sources.firstObject ?: @"none", (unsigned long)candidates.count);
	return fallback;
}

static BOOL SMSAddressNeedsIMessage(NSString *address) {
	return [address hasPrefix:@"chat"] && ![address containsString:@"@"] && address.length >= 20;
}

static IMChat *SMSChatForAddress(NSString *address, BOOL create) {
	IMChatRegistry *registry = [%c(IMChatRegistry) sharedInstance];
	IMChat *chat = [registry existingChatWithChatIdentifier:address];
	if (chat) {
		SMSLog(@"event=chat_found source=existing");
		return chat;
	}
	if (!create) {
		SMSLog(@"event=chat_missing create=0");
		return nil;
	}
	if (SMSAddressNeedsIMessage(address)) {
		SMSLog(@"event=chat_missing reason=group_identifier_not_found");
		return nil;
	}
	IMAccount *account = SMSAccountForAddress(address);
	if (!account) {
		SMSLog(@"event=chat_create_failed reason=no_account");
		return nil;
	}
	if (SMSAddressNeedsIMessage(address) && ![SMSAccountService(account) isEqualToString:@"iMessage"]) {
		SMSLog(@"event=chat_create_refused reason=imessage_required service=%@", SMSAccountService(account));
		return nil;
	}
	IMHandle *handle = nil;
	if ([account respondsToSelector:@selector(imHandleWithID:)]) handle = [account imHandleWithID:address];
	if (!handle) handle = [[%c(IMHandle) alloc] initWithAccount:account ID:address alreadyCanonical:YES];
	chat = handle ? [registry chatForIMHandle:handle] : nil;
	SMSLog(@"event=chat_created handle=%d chat=%d", handle != nil, chat != nil);
	return chat;
}

static IMChat *SMSSendableChat(IMChat *chat, NSString *address, NSString **reason) {
	IMAccount *account = [chat respondsToSelector:@selector(account)] ? [chat account] : nil;
	if (chat && SMSAccountIsUsable(account)) {
		SMSLog(@"event=chat_service_ok service=%@", SMSAccountService(account));
		return chat;
	}
	BOOL isGroup = [address hasPrefix:@"chat"] && ![address containsString:@"@"];
	BOOL isEmail = [address containsString:@"@"];
	SMSLog(@"event=chat_service_unusable service=%@ chat=%d group=%d email=%d", account ? SMSAccountService(account) : @"none", chat != nil, isGroup, isEmail);
	if (isGroup) {
		if (reason) *reason = @"imessage_unavailable";
		return nil;
	}
	IMAccount *sms = SMSUsableSMSAccount();
	if (!sms) {
		SMSLog(@"event=sms_fallback_failed reason=no_usable_sms_account");
		if (reason) *reason = @"no_sms_account";
		return nil;
	}
	IMHandle *handle = [sms respondsToSelector:@selector(imHandleWithID:)] ? [sms imHandleWithID:address] : nil;
	if (!handle) handle = [[%c(IMHandle) alloc] initWithAccount:sms ID:address alreadyCanonical:YES];
	IMChat *smsChat = handle ? [[%c(IMChatRegistry) sharedInstance] chatForIMHandle:handle] : nil;
	if (!smsChat && reason) *reason = @"no_chat";
	IMAccount *smsChatAccount = [smsChat respondsToSelector:@selector(account)] ? [smsChat account] : nil;
	SMSLog(@"event=sms_fallback chat=%d guid=%@ service=%@", smsChat != nil, [smsChat respondsToSelector:@selector(guid)] ? [smsChat guid] : @"?", smsChatAccount ? SMSAccountService(smsChatAccount) : @"none");
	return smsChat;
}

static CKConversation *SMSConversationForChat(IMChat *chat, NSString *address) {
	CKConversationList *list = [%c(CKConversationList) sharedConversationList];
	if (!list) {
		SMSLog(@"event=conversation_list_missing");
		return nil;
	}
	CKConversation *conversation = nil;
	NSString *source = @"none";
	if (!conversation && chat && [list respondsToSelector:@selector(conversationForExistingChat:)]) {
		conversation = [list conversationForExistingChat:chat];
		if (conversation) source = @"existing_chat";
	}
	if (!conversation && address && [list respondsToSelector:@selector(conversationForExistingChatWithChatIdentifier:)]) {
		conversation = [list conversationForExistingChatWithChatIdentifier:address];
		if (conversation) source = @"chat_identifier";
	}
	if (!conversation && chat && [list respondsToSelector:@selector(_conversationForChat:)]) {
		conversation = [list _conversationForChat:chat];
		if (conversation) source = @"conversation_for_chat";
	}
	if (!conversation && address && [list respondsToSelector:@selector(conversationForExistingChatWithGroupID:)]) {
		conversation = [list conversationForExistingChatWithGroupID:address];
		if (conversation) source = @"group_id";
	}
	SMSLog(@"event=conversation_lookup source=%@ found=%d", source, conversation != nil);
	return conversation;
}

static id SMSChatItemForGUID(IMChat *chat, NSString *structuredGUID) {
	if (structuredGUID.length < 36) {
		SMSLog(@"event=chat_item_invalid_guid length=%lu", (unsigned long)structuredGUID.length);
		return nil;
	}
	NSString *messageGUID = [structuredGUID substringFromIndex:structuredGUID.length - 36];
	NSString *partGUID = [structuredGUID containsString:@"/"] || [structuredGUID hasPrefix:@"bp:"] ? structuredGUID : [@"p:0/" stringByAppendingString:messageGUID];
	for (int attempt = 0; attempt < 3; attempt++) {
		[chat loadMessagesUpToGUID:messageGUID date:nil limit:0 loadImmediately:YES];
		for (id item in [chat chatItems]) {
			if (![item respondsToSelector:@selector(guid)]) continue;
			NSString *itemGUID = [item guid];
			if ([itemGUID isEqualToString:partGUID] || [itemGUID isEqualToString:structuredGUID]) {
				SMSLog(@"event=chat_item_found source=chat_items attempt=%d", attempt);
				return item;
			}
		}
	}
	IMMessage *message = [chat messageForGUID:messageGUID];
	IMMessageItem *item = [message respondsToSelector:@selector(_imMessageItem)] ? [message _imMessageItem] : nil;
	if (!item) {
		SMSLog(@"event=chat_item_missing message=%d", message != nil);
		return nil;
	}
	long long index = 0;
	if ([structuredGUID hasPrefix:@"p:"]) {
		NSRange slash = [structuredGUID rangeOfString:@"/"];
		if (slash.location != NSNotFound && slash.location > 2) {
			index = [[structuredGUID substringWithRange:NSMakeRange(2, slash.location - 2)] longLongValue];
		}
	}
	NSUInteger rangeStart = (NSUInteger)index;
	NSUInteger rangeLength = item.body.length;
	NSUInteger attachmentCount = [message respondsToSelector:@selector(inlineAttachmentAttributesArray)] ? [message inlineAttachmentAttributesArray].count : 0;
	if ((NSUInteger)index != attachmentCount) {
		rangeLength = 1;
	} else if ([message respondsToSelector:@selector(hasInlineAttachments)] && [message hasInlineAttachments]) {
		rangeStart = attachmentCount;
	}
	Class partClass = %c(IMTextMessagePartChatItem);
	id part = [partClass alloc];
	if ([part respondsToSelector:@selector(_initWithItem:text:index:messagePartRange:subject:isShowingEditHistory:)]) {
		part = [part _initWithItem:item text:item.body index:index messagePartRange:NSMakeRange(rangeStart, rangeLength) subject:item.subject isShowingEditHistory:NO];
	} else if ([part respondsToSelector:@selector(_initWithItem:text:index:messagePartRange:subject:)]) {
		part = [part _initWithItem:item text:item.body index:index messagePartRange:NSMakeRange(rangeStart, rangeLength) subject:item.subject];
	} else {
		SMSLog(@"event=chat_item_init_unavailable");
		return nil;
	}
	SMSLog(@"event=chat_item_found source=constructed index=%lld", index);
	return part;
}

static NSDictionary *SMSSendResult(BOOL ok, NSString *reason, NSString *service) {
	NSMutableDictionary *result = [NSMutableDictionary dictionaryWithObject:@(ok) forKey:@"ok"];
	if (reason) result[@"reason"] = reason;
	if (service) result[@"service"] = service;
	return result;
}

@interface SMSSpringBoardService : NSObject
+ (instancetype)sharedInstance;
@end

@implementation SMSSpringBoardService {
	dispatch_source_t _server;
	NSMutableOrderedSet<NSString *> *_emitted;
	NSMutableDictionary<NSString *, NSArray *> *_typingState;
}

+ (instancetype)sharedInstance {
	static SMSSpringBoardService *instance = nil;
	static dispatch_once_t onceToken;
	dispatch_once(&onceToken, ^{
		instance = [[self alloc] init];
	});
	return instance;
}

- (instancetype)init {
	if ((self = [super init])) {
		_emitted = [NSMutableOrderedSet orderedSet];
		_typingState = [NSMutableDictionary dictionary];
		__weak SMSSpringBoardService *weakSelf = self;
		_server = SMSIPCStartManagedServer(SMSIPC_SPRINGBOARD_SOCKET, 90.0, 10.0, ^id(NSString *method, id args) {
			return [weakSelf handleMethod:method args:args];
		});
		SMSLog(@"event=springboard_service_started server=%d version=%@", _server != nil, SMSTweakVersion);
		[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(receivedText:) name:@"__kIMChatMessageReceivedNotification" object:nil];
		[[NSNotificationCenter defaultCenter] addObserver:self selector:@selector(itemsChanged:) name:@"__kIMChatItemsDidChangeNotification" object:nil];
	}
	return self;
}

- (BOOL)markEmitted:(NSString *)key {
	if ([_emitted containsObject:key]) return NO;
	[_emitted addObject:key];
	while (_emitted.count > 512) [_emitted removeObjectAtIndex:0];
	return YES;
}

- (void)noteTypingFrom:(NSString *)sender typing:(BOOL)typing {
	if (![sender isKindOfClass:[NSString class]] || !sender.length) return;
	NSArray *last = _typingState[sender];
	CFAbsoluteTime now = CFAbsoluteTimeGetCurrent();
	if (last && [last[0] boolValue] == typing && now - [last[1] doubleValue] < 3.0) return;
	_typingState[sender] = @[@(typing), @(now)];
	if (_typingState.count > 256) [_typingState removeAllObjects];
	SMSEmitEvent(@"handlePartyTyping", @{@"chat": sender, @"typing": @(typing ? 1 : 0)});
}

- (id)handleMethod:(NSString *)method args:(id)args {
	SMSLog(@"event=ipc_method method=%@", method);
	if ([method isEqualToString:@"ping"]) return [self ping];
	if ([method isEqualToString:@"sendText"]) return [self sendText:args];
	if ([method isEqualToString:@"setAllAsRead"]) return [self setAllAsRead:args];
	if ([method isEqualToString:@"sendTapback"]) return [self sendTapback:args];
	if ([method isEqualToString:@"getPinnedChats"]) return [self getPinnedChats];
	if ([method isEqualToString:@"delete"]) return [self deleteObject:args];
	if ([method isEqualToString:@"sendTyping"]) return [self sendTyping:args];
	SMSLog(@"event=ipc_unknown_method method=%@", method);
	[NSException raise:@"SMSUnknownMethod" format:@"unknown method %@", method];
	return nil;
}

- (NSDictionary *)ping {
	BOOL connected = SMSEnsureDaemonConnected(3.0);
	NSDictionary *state = SMSRunOnMain(@"ping_state", ^id{
		IMDaemonController *controller = [%c(IMDaemonController) sharedController];
		unsigned long long caps = [controller respondsToSelector:@selector(processCapabilities)] ? [controller processCapabilities] : 0;
		return @{@"capabilities": @(caps)};
	});
	return @{@"version": SMSTweakVersion, @"pid": @(getpid()), @"connected": @(connected), @"capabilities": state[@"capabilities"] ?: @0};
}

- (NSDictionary *)sendText:(id)vals {
	NSString *address = SMSStringArg(vals, @"address");
	NSString *body = SMSStringArg(vals, @"body") ?: @"";
	NSString *subject = SMSStringArg(vals, @"subject") ?: @"";
	id rawAttachments = [vals isKindOfClass:[NSDictionary class]] ? vals[@"attachment"] : nil;
	NSArray *attachments = [rawAttachments isKindOfClass:[NSArray class]] ? rawAttachments : @[];
	SMSLog(@"event=send_text_request body_length=%lu subject_length=%lu attachments=%lu", (unsigned long)body.length, (unsigned long)subject.length, (unsigned long)attachments.count);
	if (!address.length) {
		SMSLog(@"event=send_text_rejected reason=missing_address");
		return SMSSendResult(NO, @"missing_address", nil);
	}
	if (!body.length && !attachments.count) {
		SMSLog(@"event=send_text_rejected reason=empty_message");
		return SMSSendResult(NO, @"empty_message", nil);
	}
	if (!SMSEnsureDaemonConnected(5.0)) {
		SMSLog(@"event=send_text_rejected reason=daemon_unavailable");
		return SMSSendResult(NO, @"daemon_unavailable", nil);
	}
	NSDictionary *result = SMSRunOnMain(@"send_text", ^id{
		NSString *reason = nil;
		IMChat *found = SMSChatForAddress(address, YES);
		if (!found && SMSAddressNeedsIMessage(address)) reason = @"chat_not_found";
		IMChat *chat = found ? SMSSendableChat(found, address, &reason) : nil;
		if (!chat) {
			SMSLog(@"event=send_text_failed reason=%@", reason ?: @"no_chat");
			return SMSSendResult(NO, reason ?: @"no_chat", nil);
		}
		CKConversation *conversation = SMSConversationForChat(chat, nil);
		NSAttributedString *text = [[NSAttributedString alloc] initWithString:body];
		if (conversation) {
			CKComposition *composition = [%c(CKComposition) composition];
			CKMediaObjectManager *manager = [%c(CKMediaObjectManager) sharedInstance];
			NSUInteger added = 0;
			for (id path in attachments) {
				if (![path isKindOfClass:[NSString class]]) continue;
				if (![[NSFileManager defaultManager] isReadableFileAtPath:path]) {
					SMSLog(@"event=send_text_attachment_unreadable path=%@", path);
					continue;
				}
				CKMediaObject *object = [manager mediaObjectWithFileURL:[NSURL fileURLWithPath:path] filename:nil transcoderUserInfo:@{} attributionInfo:@{} hideAttachment:NO];
				if (!object) {
					SMSLog(@"event=send_text_attachment_failed path=%@", path);
					continue;
				}
				composition = [composition compositionByAppendingMediaObject:object];
				added++;
			}
			if (text.length) composition = [composition compositionByAppendingText:text];
			if (subject.length) [composition setSubject:[[NSAttributedString alloc] initWithString:subject]];
			id message = [conversation messageWithComposition:composition];
			if (!message) {
				SMSLog(@"event=send_text_failed reason=message_from_composition_nil");
				return SMSSendResult(NO, @"compose_failed", nil);
			}
			IMAccount *chatAccount = [chat respondsToSelector:@selector(account)] ? [chat account] : nil;
			NSString *service = SMSAccountService(chatAccount);
			Class serviceClass = %c(IMServiceImpl);
			id smsService = [serviceClass respondsToSelector:@selector(smsService)] ? [serviceClass smsService] : nil;
			if ([service isEqualToString:@"SMS"] && smsService && [conversation respondsToSelector:@selector(sendMessage:onService:newComposition:)]) {
				[conversation sendMessage:message onService:smsService newComposition:YES];
			} else {
				[conversation sendMessage:message newComposition:YES];
			}
			SMSLog(@"event=send_text_dispatched path=composition service=%@ attachments=%lu guid=%@", service, (unsigned long)added, [message respondsToSelector:@selector(guid)] ? [message guid] : @"?");
			if (attachments.count && !added) return SMSSendResult(NO, @"attachment_unreadable", service);
			return SMSSendResult(YES, nil, service);
		}
		if (chat && !attachments.count) {
			Class messageClass = %c(IMMessage);
			IMMessage *message = nil;
			if ([messageClass respondsToSelector:@selector(instantMessageWithText:flags:threadIdentifier:)]) {
				message = [messageClass instantMessageWithText:text flags:1048581 threadIdentifier:nil];
			} else {
				message = [messageClass instantMessageWithText:text flags:1048581];
			}
			if (!message) {
				SMSLog(@"event=send_text_failed reason=instant_message_nil");
				return SMSSendResult(NO, @"compose_failed", nil);
			}
			[chat sendMessage:message];
			SMSLog(@"event=send_text_dispatched path=imchat guid=%@", [message guid]);
			return SMSSendResult(YES, nil, SMSAccountService([chat account]));
		}
		SMSLog(@"event=send_text_failed reason=no_conversation chat=%d conversation=%d", chat != nil, conversation != nil);
		return SMSSendResult(NO, @"no_conversation", nil);
	});
	return result ?: SMSSendResult(NO, @"internal_error", nil);
}

- (NSNumber *)setAllAsRead:(id)chatId {
	if (![chatId isKindOfClass:[NSString class]] || ![chatId length]) return @NO;
	if (!SMSEnsureDaemonConnected(5.0)) return @NO;
	NSNumber *result = SMSRunOnMain(@"mark_read", ^id{
		IMChat *chat = SMSChatForAddress(chatId, NO);
		if (!chat) return @NO;
		[chat markAllMessagesAsRead];
		SMSLog(@"event=mark_read_done");
		return @YES;
	});
	return result ?: @NO;
}

- (NSNumber *)sendTyping:(id)vals {
	NSString *chatId = SMSStringArg(vals, @"chat");
	BOOL typing = [vals isKindOfClass:[NSDictionary class]] && [vals[@"typing"] boolValue];
	if (!chatId.length) return @NO;
	if (!SMSEnsureDaemonConnected(3.0)) return @NO;
	NSNumber *result = SMSRunOnMain(@"send_typing", ^id{
		IMChat *chat = SMSChatForAddress(chatId, NO);
		if (!chat || ![chat respondsToSelector:@selector(setLocalUserIsTyping:)]) return @NO;
		[chat setLocalUserIsTyping:typing];
		SMSLog(@"event=typing_sent typing=%d", typing);
		return @YES;
	});
	return result ?: @NO;
}

- (NSNumber *)sendTapback:(id)vals {
	NSString *chatId = SMSStringArg(vals, @"chat");
	NSString *guid = SMSStringArg(vals, @"guid");
	long long tapback = [vals isKindOfClass:[NSDictionary class]] ? [vals[@"tapback"] longLongValue] : 0;
	if (!chatId.length || !guid.length || tapback <= 0) {
		SMSLog(@"event=tapback_rejected reason=invalid_args");
		return @NO;
	}
	if (!SMSEnsureDaemonConnected(5.0)) return @NO;
	NSNumber *result = SMSRunOnMain(@"send_tapback", ^id{
		IMChat *chat = SMSChatForAddress(chatId, NO);
		if (!chat) return @NO;
		id item = SMSChatItemForGUID(chat, guid);
		if (!item) return @NO;
		if ([chat respondsToSelector:@selector(sendMessageAcknowledgment:forChatItem:withAssociatedMessageInfo:)] || [chat respondsToSelector:@selector(sendMessageAcknowledgment:forChatItem:withMessageSummaryInfo:)]) {
			IMMessageItem *messageItem = [item respondsToSelector:@selector(_item)] ? [item _item] : nil;
			NSString *summary = [messageItem respondsToSelector:@selector(body)] ? [[messageItem body] string] : @"";
			NSDictionary *info = @{@"amc": @1, @"ams": summary ?: @""};
			if ([chat respondsToSelector:@selector(sendMessageAcknowledgment:forChatItem:withAssociatedMessageInfo:)]) {
				[chat sendMessageAcknowledgment:tapback forChatItem:item withAssociatedMessageInfo:info];
			} else {
				[chat sendMessageAcknowledgment:tapback forChatItem:item withMessageSummaryInfo:info];
			}
		} else if ([chat respondsToSelector:@selector(sendMessageAcknowledgment:forChatItem:)]) {
			[chat sendMessageAcknowledgment:tapback forChatItem:item];
		} else {
			SMSLog(@"event=tapback_unsupported");
			return @NO;
		}
		SMSLog(@"event=tapback_sent tapback=%lld", tapback);
		return @YES;
	});
	if (result.boolValue) SMSEmitEvent(@"handleSentTapback", @{@"tapback": @(tapback), @"guid": guid});
	return result ?: @NO;
}

- (NSArray *)getPinnedChats {
	if ([[[UIDevice currentDevice] systemVersion] floatValue] < 14.0) return @[];
	if (!SMSEnsureDaemonConnected(5.0)) return @[];
	for (int attempt = 0; attempt < 2; attempt++) {
		NSArray *pins = SMSRunOnMain(@"pinned_chats", ^id{
			IMPinnedConversationsController *controller = [%c(IMPinnedConversationsController) sharedInstance];
			NSArray *identifiers = [[controller pinnedConversationIdentifierSet] array] ?: @[];
			CKConversationList *list = [%c(CKConversationList) sharedConversationList];
			NSMutableArray *chats = [NSMutableArray arrayWithCapacity:identifiers.count];
			for (id pin in identifiers) {
				CKConversation *conversation = [list conversationForExistingChatWithPinningIdentifier:pin];
				NSString *identifier = [[conversation chat] chatIdentifier];
				if (identifier.length) [chats addObject:identifier];
			}
			return chats;
		});
		if (pins.count || attempt == 1) {
			SMSLog(@"event=pinned_chats count=%lu attempt=%d", (unsigned long)pins.count, attempt);
			return pins ?: @[];
		}
		usleep(300000);
	}
	return @[];
}

- (NSNumber *)deleteObject:(id)vals {
	NSString *chatId = SMSStringArg(vals, @"chat");
	NSString *text = SMSStringArg(vals, @"text");
	if (!chatId.length) return @NO;
	if (!SMSEnsureDaemonConnected(5.0)) return @NO;
	NSNumber *result = SMSRunOnMain(@"delete", ^id{
		IMChat *chat = SMSChatForAddress(chatId, NO);
		if (!chat) return @NO;
		if (!text.length) {
			[chat remove];
			SMSLog(@"event=delete_conversation_done");
			return @YES;
		}
		id item = SMSChatItemForGUID(chat, text);
		if (!item) return @NO;
		[chat deleteChatItems:@[item]];
		SMSLog(@"event=delete_item_done");
		return @YES;
	});
	return result ?: @NO;
}

- (void)receivedText:(NSNotification *)notification {
	@try {
		IMMessage *message = notification.userInfo[@"__kIMChatValueKey"];
		if (![message respondsToSelector:@selector(guid)]) return;
		if ([message respondsToSelector:@selector(isTypingMessage)] && ((BOOL (*)(id, SEL))objc_msgSend)(message, @selector(isTypingMessage))) return;
		NSString *guid = [message guid];
		if (!guid.length || ![self markEmitted:[@"received:" stringByAppendingString:guid]]) return;
		SMSLog(@"event=message_received");
		SMSEmitEvent(@"handleReceivedText", guid);
	} @catch (NSException *exception) {
		SMSLog(@"event=received_text_exception name=%@ reason=\"%@\"", exception.name, exception.reason);
	}
}

- (void)itemsChanged:(NSNotification *)notification {
	@try {
		IMChat *chat = notification.object;
		if (![chat respondsToSelector:@selector(lastSentMessage)]) return;
		IMMessage *message = [chat lastSentMessage];
		if (!message || ![message respondsToSelector:@selector(isFromMe)] || ![message isFromMe]) return;
		NSString *guid = [message guid];
		if (!guid.length) return;
		BOOL read = [message respondsToSelector:@selector(isRead)] && [message isRead];
		BOOL delivered = [message respondsToSelector:@selector(isDelivered)] && [message isDelivered];
		BOOL sent = [message respondsToSelector:@selector(isSent)] && [message isSent];
		if (read) {
			if ([self markEmitted:[@"read:" stringByAppendingString:guid]]) {
				SMSLog(@"event=message_read");
				SMSEmitEvent(@"handleTextRead", guid);
			}
		} else if (delivered || sent) {
			if ([self markEmitted:[@"sent:" stringByAppendingString:guid]]) {
				SMSLog(@"event=message_sent delivered=%d sent=%d", delivered, sent);
				SMSEmitEvent(@"handleReceivedText", guid);
			}
		}
	} @catch (NSException *exception) {
		SMSLog(@"event=items_changed_exception name=%@ reason=\"%@\"", exception.name, exception.reason);
	}
}

@end

static void SMSNoteTyping(IMMessageItem *item, BOOL typing) {
	if (!SMSInSpringBoard || ![NSThread isMainThread]) return;
	@try {
		id sender = [item respondsToSelector:@selector(sender)] ? [item sender] : nil;
		[[SMSSpringBoardService sharedInstance] noteTypingFrom:sender typing:typing];
	} @catch (NSException *exception) {
		SMSLog(@"event=typing_hook_exception name=%@ reason=\"%@\"", exception.name, exception.reason);
	}
}

%group CapabilitiesModern
%hook IMDaemonController
- (unsigned long long)processCapabilities {
	unsigned long long orig = %orig;
	if (!SMSInSpringBoard) return orig;
	unsigned long long elevated = orig | SMSModernCapabilities;
	static BOOL logged = NO;
	if (!logged) {
		logged = YES;
		SMSLog(@"event=capabilities_elevated api=processCapabilities orig=%llu elevated=%llu", orig, elevated);
	}
	return elevated;
}
%end
%end

%group CapabilitiesLegacy
%hook IMDaemonController
- (unsigned)_capabilities {
	if (!SMSInSpringBoard) return %orig;
	return SMSLegacyCapabilities;
}
%end
%end

%group TypingHooks
%hook IMMessageItem
- (bool)isCancelTypingMessage {
	bool orig = %orig;
	if (orig) SMSNoteTyping(self, NO);
	return orig;
}

- (bool)isIncomingTypingMessage {
	bool orig = %orig;
	if (orig) SMSNoteTyping(self, YES);
	return orig;
}
%end
%end

%ctor {
	@autoreleasepool {
		NSString *bundleID = [[NSBundle mainBundle] bundleIdentifier];
		SMSInSpringBoard = [bundleID isEqualToString:@"com.apple.springboard"];
		SMSLog(@"event=tweak_loaded bundle=%@ version=%@ springboard=%d", bundleID, SMSTweakVersion, SMSInSpringBoard);
		if (!SMSInSpringBoard) return;
		dlopen("/System/Library/PrivateFrameworks/IMCore.framework/IMCore", RTLD_LAZY);
		dlopen("/System/Library/PrivateFrameworks/ChatKit.framework/ChatKit", RTLD_LAZY);
		Class daemonClass = objc_getClass("IMDaemonController");
		if (daemonClass && class_getInstanceMethod(daemonClass, @selector(processCapabilities))) {
			%init(CapabilitiesModern);
			SMSLog(@"event=hooks_installed group=CapabilitiesModern");
		} else if (daemonClass && class_getInstanceMethod(daemonClass, sel_registerName("_capabilities"))) {
			%init(CapabilitiesLegacy);
			SMSLog(@"event=hooks_installed group=CapabilitiesLegacy");
		} else {
			SMSLog(@"event=hooks_skipped group=Capabilities reason=missing_class_or_selector class=%d", daemonClass != nil);
		}
		Class itemClass = objc_getClass("IMMessageItem");
		if (itemClass && class_getInstanceMethod(itemClass, @selector(isIncomingTypingMessage)) && class_getInstanceMethod(itemClass, @selector(isCancelTypingMessage))) {
			%init(TypingHooks);
			SMSLog(@"event=hooks_installed group=TypingHooks");
		}
		dispatch_async(dispatch_get_main_queue(), ^{
			[SMSSpringBoardService sharedInstance];
		});
	}
}
