#import <Foundation/Foundation.h>

@interface NSObject (Undocumented)
@end

@interface __NSCFString
@end

@class IMChat;
@class IMHandle;
@class IMAccount;

@interface CKComposition : NSObject
+ (CKComposition *)composition;
- (id)initWithText:(id)arg1 subject:(id)arg2;
- (id)compositionByAppendingMediaObject:(id)arg1;
- (id)compositionByAppendingText:(id)arg1;
- (void)setSubject:(id)arg1;
- (void)setText:(id)arg1;
@end

@interface CKMediaObject : NSObject
@end

@interface CKMediaObjectManager : NSObject
+ (id)sharedInstance;
- (id)mediaObjectWithFileURL:(id)arg1 filename:(id)arg2 transcoderUserInfo:(id)arg3 attributionInfo:(id)arg4 hideAttachment:(_Bool)arg5;
@end

@interface CKConversation : NSObject
@property (nonatomic, retain) IMChat *chat;
- (id)messageWithComposition:(id)arg1;
- (void)sendMessage:(id)arg1 newComposition:(bool)arg2;
- (void)sendMessage:(id)arg1 onService:(id)arg2 newComposition:(bool)arg3;
@end

@interface CKConversationList : NSObject
+ (id)sharedConversationList;
- (id)conversationForExistingChatWithGroupID:(id)arg1;
- (id)conversationForExistingChatWithChatIdentifier:(id)arg1;
- (id)conversationForExistingChatWithPinningIdentifier:(id)arg1;
- (id)conversationForExistingChat:(id)arg1;
- (id)_conversationForChat:(id)arg1;
@end

@interface IMDaemonController : NSObject
+ (id)sharedController;
- (BOOL)connectToDaemon;
- (BOOL)connectToDaemonWithLaunch:(BOOL)launch capabilities:(unsigned long long)capabilities blockUntilConnected:(BOOL)block;
- (BOOL)isConnected;
- (unsigned long long)processCapabilities;
- (unsigned long long)capabilities;
@end

@interface IMPinnedConversationsController : NSObject
+ (id)sharedInstance;
- (NSOrderedSet *)pinnedConversationIdentifierSet;
@end

@interface NSConcreteNotification : NSNotification
@end

@interface IMItemsController : NSObject
@end

@interface IMChat : IMItemsController
- (void)sendMessage:(id)arg1;
- (void)markAllMessagesAsRead;
- (void)sendMessageAcknowledgment:(long long)arg1 forChatItem:(id)arg2;
- (void)sendMessageAcknowledgment:(long long)arg1 forChatItem:(id)arg2 withMessageSummaryInfo:(id)arg3;
- (void)sendMessageAcknowledgment:(long long)arg1 forChatItem:(id)arg2 withAssociatedMessageInfo:(id)arg3;
- (void)remove;
- (NSArray *)chatItems;
- (id)messageItemForGUID:(id)arg1;
- (id)messageForGUID:(id)arg1;
- (void)loadMessagesUpToGUID:(id)arg1 date:(id)arg2 limit:(unsigned long long)arg3 loadImmediately:(BOOL)arg4;
- (void)deleteChatItems:(id)arg1;
- (NSString *)chatIdentifier;
- (NSString *)guid;
- (IMAccount *)account;
- (id)lastSentMessage;
- (void)setLocalUserIsTyping:(BOOL)arg1;
@end

@interface IMChatItem : NSObject
- (id)_item;
@end

@interface IMTranscriptChatItem : IMChatItem
- (NSString *)guid;
@end

@interface IMTextMessagePartChatItem : IMTranscriptChatItem
- (id)_initWithItem:(id)arg1 text:(id)arg2 index:(long long)arg3 messagePartRange:(NSRange)arg4 subject:(id)arg5;
- (id)_initWithItem:(id)arg1 text:(id)arg2 index:(long long)arg3 messagePartRange:(NSRange)arg4 subject:(id)arg5 isShowingEditHistory:(BOOL)arg6;
@end

@interface IMChatRegistry : NSObject
+ (id)sharedInstance;
- (id)chatForIMHandle:(id)arg1;
- (id)existingChatWithChatIdentifier:(id)arg1;
@end

@interface IMHandle : NSObject
- (id)initWithAccount:(id)arg1 ID:(id)arg2 alreadyCanonical:(_Bool)arg3;
@end

@interface IMMessageItem : NSObject
- (NSString *)subject;
- (NSAttributedString *)body;
- (id)sender;
@end

@interface IMMessage : NSObject
+ (id)instantMessageWithText:(id)arg1 flags:(unsigned long long)arg2;
+ (id)instantMessageWithText:(id)arg1 flags:(unsigned long long)arg2 threadIdentifier:(id)arg3;
- (NSString *)guid;
- (IMMessageItem *)_imMessageItem;
- (bool)hasInlineAttachments;
- (NSArray *)inlineAttachmentAttributesArray;
- (bool)isFromMe;
- (bool)isDelivered;
- (bool)isSent;
- (bool)isRead;
@end

@interface IMAccount : NSObject
- (id)imHandleWithID:(id)arg1;
- (NSString *)serviceName;
- (BOOL)isActive;
- (BOOL)isOperational;
@end

@interface IMServiceImpl : NSObject
+ (id)iMessageService;
+ (id)smsService;
@end

@interface IMAccountController : NSObject
+ (id)sharedInstance;
- (id)activeIMessageAccount;
- (IMAccount *)activeSMSAccount;
- (id)__ck_bestAccountForAddress:(id)arg1;
- (id)bestAccountForService:(id)arg1;
- (NSArray *)accounts;
@end
