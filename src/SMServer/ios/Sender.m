#import <Foundation/Foundation.h>
#import "MRYIPCCenter.h"
#import "../shared/PrivateHeaders.h"
#import "Sender.h"
#import "SMServerIPC.h"

#define c(a) NSClassFromString(@#a)

@implementation IPCTextWatcher {
	/// This is a MCRYIPC center that libsmserver contacts whenever a new text is received.
	MRYIPCCenter* _center;
}

+ (instancetype)sharedInstance {
	static dispatch_once_t onceToken = 0;
	__strong static IPCTextWatcher* sharedInstance = nil;
	dispatch_once(&onceToken, ^{
		sharedInstance = [[self alloc] init];
	});
	return sharedInstance;
}

- (instancetype)init {
	if ((self = [super init])) {
		// Initialize blocks to empty stubs so they can be safely called
		_setTexts = ^(NSString *guid) {};
		_setTyping = ^(NSDictionary *vals) {};
		_sentTapback = ^(int tapback, NSString *guid) {};
		_textRead = ^(NSString *guid) {};

		_center = [MRYIPCCenter centerNamed:@"com.ianwelker.smserverHandleText"];

		// NOTE: addTarget: calls are intentionally disabled to prevent MRYIPC
		// from starting its Mach message loop, which throws uncaught NSExceptions
		// on iOS 15 rootless causing SIGABRT. Real-time push notifications from
		// the tweak are disabled; all other functionality (web UI, API, DB reads,
		// message sending via IWSSender) continues to work.
	}
	return self;
}

- (void)handleReceivedTextWithCallback:(NSString *)guid {
	@try {
		if (_setTexts) _setTexts(guid);
	} @catch (NSException *e) {
		NSLog(@"SMServer_app: handleReceivedTextWithCallback exception: %@", e);
	}
}

- (void)handlePartyTypingWithCallback:(NSDictionary *)vals {
	@try {
		if (_setTyping) _setTyping(vals);
	} @catch (NSException *e) {
		NSLog(@"SMServer_app: handlePartyTypingWithCallback exception: %@", e);
	}
}

- (void)handleSentTapbackWithCallback:(NSDictionary *)vals {
	@try {
		if (_sentTapback) _sentTapback([[vals objectForKey:@"tapback"] intValue], [vals objectForKey:@"guid"]);
	} @catch (NSException *e) {
		NSLog(@"SMServer_app: handleSentTapbackWithCallback exception: %@", e);
	}
}

- (void)handleTextReadWithCallback:(NSString *)guid {
	@try {
		if (_textRead) _textRead(guid);
	} @catch (NSException *e) {
		NSLog(@"SMServer_app: handleTextReadWithCallback exception: %@", e);
	}
}

@end

@implementation IWSSender

- (id)init {
	if (self = [super init]) {
		self.center = [MRYIPCCenter centerNamed:@"com.ianwelker.smserver"];
	}
	return self;
}

- (BOOL)sendIPCText:(NSString *)body withSubject:(NSString *)subject toAddress:(NSString *)address withAttachments:(NSArray *)paths {
	@try {
		NSDictionary* args = @{@"body": body, @"subject": subject, @"address": address, @"attachment": paths};
		return [[self.center callExternalMethod:@selector(sendText:) withArguments:args] boolValue];
	} @catch (NSException *e) {
		NSLog(@"SMServer_app: sendIPCText exception: %@", e);
		return NO;
	}
}

- (BOOL)markConvoAsRead:(NSString *)chat_id {
	@try {
		NSArray* chats = [chat_id componentsSeparatedByString:@","];
		for (NSString* chat in chats) {
			if (![[self.center callExternalMethod:@selector(setAllAsRead:) withArguments:chat] boolValue])
				return NO;
		}
		return YES;
	} @catch (NSException *e) {
		NSLog(@"SMServer_app: markConvoAsRead exception: %@", e);
		return NO;
	}
}

- (BOOL)sendTapback:(NSNumber *)tapback forGuid:(NSString *)guid inChat:(NSString *)chat {
	@try {
		NSDictionary* args = @{@"tapback": tapback, @"guid": guid, @"chat": chat};
		return [[self.center callExternalMethod:@selector(sendTapback:) withArguments:args] boolValue];
	} @catch (NSException *e) {
		NSLog(@"SMServer_app: sendTapback exception: %@", e);
		return NO;
	}
}

- (void)sendTyping:(BOOL)isTyping forChat:(NSString *)chat {
	@try {
		NSBundle* imcore = [[NSBundle alloc] initWithPath:@"/System/Library/PrivateFrameworks/IMCore.framework"];
		[imcore load];
		IMChatRegistry* registry = [c(IMChatRegistry) sharedInstance];
		IMChat* imchat = [registry existingChatWithChatIdentifier:chat];
		[imchat setLocalUserIsTyping:isTyping];
	} @catch (NSException *e) {
		NSLog(@"SMServer_app: sendTyping exception: %@", e);
	}
}

- (BOOL)removeObject:(NSString *)chat text:(NSString *)text {
	@try {
		NSMutableDictionary* args = [NSMutableDictionary dictionaryWithObject:chat forKey:@"chat"];
		if (text != nil)
			args[@"text"] = text;
		return [[self.center callExternalMethod:@selector(delete:) withArguments:[NSDictionary dictionaryWithDictionary:args]] boolValue];
	} @catch (NSException *e) {
		NSLog(@"SMServer_app: removeObject exception: %@", e);
		return NO;
	}
}

@end
