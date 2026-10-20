#ifndef SMSIPC_h
#define SMSIPC_h

#import <Foundation/Foundation.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <string.h>

#define SMSIPC_DIRECTORY @"/var/mobile/Library/SMServer"
#define SMSIPC_SPRINGBOARD_SOCKET @"/var/mobile/Library/SMServer/springboard.sock"
#define SMSIPC_APP_SOCKET @"/var/mobile/Library/SMServer/app.sock"
#define SMSIPC_MAX_FRAME_BYTES (16u * 1024u * 1024u)
#define SMSIPC_ERROR_DOMAIN @"com.ianwelker.smserver.ipc"

#define SMSIPCLog(fmt, ...) NSLog(@"[smsipc] pid=%d " fmt, getpid(), ##__VA_ARGS__)

typedef id (^SMSIPCHandler)(NSString *method, id args);

static __attribute__((unused)) NSError *SMSIPCError(NSInteger code, NSString *message) {
	return [NSError errorWithDomain:SMSIPC_ERROR_DOMAIN code:code userInfo:@{NSLocalizedDescriptionKey: message ?: @"unknown"}];
}

static __attribute__((unused)) BOOL SMSIPCEnsureDirectory(void) {
	const char *dir = SMSIPC_DIRECTORY.fileSystemRepresentation;
	struct stat st;
	if (stat(dir, &st) != 0) {
		if (mkdir(dir, 0700) != 0 && errno != EEXIST) {
			SMSIPCLog(@"event=ipc_dir_create_failed path=%s errno=%d error=%s", dir, errno, strerror(errno));
			return NO;
		}
		if (stat(dir, &st) != 0) {
			SMSIPCLog(@"event=ipc_dir_stat_failed path=%s errno=%d", dir, errno);
			return NO;
		}
		SMSIPCLog(@"event=ipc_dir_created path=%s uid=%d", dir, (int)st.st_uid);
	}
	if (!S_ISDIR(st.st_mode)) {
		SMSIPCLog(@"event=ipc_dir_not_directory path=%s", dir);
		return NO;
	}
	if (st.st_uid != getuid() && getuid() != 0) {
		SMSIPCLog(@"event=ipc_dir_wrong_owner path=%s owner=%d uid=%d", dir, (int)st.st_uid, (int)getuid());
		return NO;
	}
	return YES;
}

static __attribute__((unused)) BOOL SMSIPCFillAddress(struct sockaddr_un *addr, NSString *path) {
	memset(addr, 0, sizeof(*addr));
	addr->sun_family = AF_UNIX;
	const char *cpath = path.fileSystemRepresentation;
	if (strlen(cpath) >= sizeof(addr->sun_path)) {
		SMSIPCLog(@"event=ipc_path_too_long path=%s", cpath);
		return NO;
	}
	strlcpy(addr->sun_path, cpath, sizeof(addr->sun_path));
	return YES;
}

static __attribute__((unused)) void SMSIPCConfigureSocket(int fd, double timeoutSeconds) {
	int one = 1;
	setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
	struct timeval tv;
	tv.tv_sec = (time_t)timeoutSeconds;
	tv.tv_usec = (suseconds_t)((timeoutSeconds - (double)tv.tv_sec) * 1000000.0);
	setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
	setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
}

static __attribute__((unused)) BOOL SMSIPCWriteAll(int fd, const void *buffer, size_t length) {
	const uint8_t *bytes = (const uint8_t *)buffer;
	size_t written = 0;
	while (written < length) {
		ssize_t n = write(fd, bytes + written, length - written);
		if (n < 0) {
			if (errno == EINTR) continue;
			return NO;
		}
		if (n == 0) return NO;
		written += (size_t)n;
	}
	return YES;
}

static __attribute__((unused)) BOOL SMSIPCReadAll(int fd, void *buffer, size_t length) {
	uint8_t *bytes = (uint8_t *)buffer;
	size_t received = 0;
	while (received < length) {
		ssize_t n = read(fd, bytes + received, length - received);
		if (n < 0) {
			if (errno == EINTR) continue;
			return NO;
		}
		if (n == 0) return NO;
		received += (size_t)n;
	}
	return YES;
}

static __attribute__((unused)) BOOL SMSIPCWriteFrame(int fd, NSDictionary *frame, NSError **error) {
	NSError *serializationError = nil;
	NSData *payload = [NSPropertyListSerialization dataWithPropertyList:frame format:NSPropertyListBinaryFormat_v1_0 options:0 error:&serializationError];
	if (!payload) {
		if (error) *error = SMSIPCError(1, [NSString stringWithFormat:@"serialize failed: %@", serializationError.localizedDescription]);
		return NO;
	}
	if (payload.length > SMSIPC_MAX_FRAME_BYTES) {
		if (error) *error = SMSIPCError(2, @"frame too large");
		return NO;
	}
	uint32_t header = htonl((uint32_t)payload.length);
	if (!SMSIPCWriteAll(fd, &header, sizeof(header)) || !SMSIPCWriteAll(fd, payload.bytes, payload.length)) {
		if (error) *error = SMSIPCError(3, [NSString stringWithFormat:@"write failed errno=%d", errno]);
		return NO;
	}
	return YES;
}

static __attribute__((unused)) NSDictionary *SMSIPCReadFrame(int fd, NSError **error) {
	uint32_t header = 0;
	if (!SMSIPCReadAll(fd, &header, sizeof(header))) {
		if (error) *error = SMSIPCError(4, [NSString stringWithFormat:@"read header failed errno=%d", errno]);
		return nil;
	}
	uint32_t length = ntohl(header);
	if (length == 0 || length > SMSIPC_MAX_FRAME_BYTES) {
		if (error) *error = SMSIPCError(5, [NSString stringWithFormat:@"invalid frame length %u", length]);
		return nil;
	}
	NSMutableData *payload = [NSMutableData dataWithLength:length];
	if (!SMSIPCReadAll(fd, payload.mutableBytes, length)) {
		if (error) *error = SMSIPCError(6, [NSString stringWithFormat:@"read payload failed errno=%d", errno]);
		return nil;
	}
	NSError *parseError = nil;
	id object = [NSPropertyListSerialization propertyListWithData:payload options:NSPropertyListImmutable format:NULL error:&parseError];
	if (![object isKindOfClass:[NSDictionary class]]) {
		if (error) *error = SMSIPCError(7, [NSString stringWithFormat:@"invalid frame: %@", parseError.localizedDescription ?: @"not a dictionary"]);
		return nil;
	}
	return object;
}

static __attribute__((unused)) int SMSIPCConnect(NSString *path, double timeoutSeconds, NSError **error) {
	struct sockaddr_un addr;
	if (!SMSIPCFillAddress(&addr, path)) {
		if (error) *error = SMSIPCError(8, @"socket path too long");
		return -1;
	}
	int fd = socket(AF_UNIX, SOCK_STREAM, 0);
	if (fd < 0) {
		if (error) *error = SMSIPCError(9, [NSString stringWithFormat:@"socket failed errno=%d", errno]);
		return -1;
	}
	SMSIPCConfigureSocket(fd, timeoutSeconds);
	if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
		int savedErrno = errno;
		close(fd);
		if (error) *error = SMSIPCError(10, [NSString stringWithFormat:@"connect failed errno=%d (%s)", savedErrno, strerror(savedErrno)]);
		return -1;
	}
	return fd;
}

static __attribute__((unused)) id SMSIPCCall(NSString *path, NSString *method, id args, double timeoutSeconds, NSError **error) {
	CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
	NSError *localError = nil;
	int fd = SMSIPCConnect(path, timeoutSeconds, &localError);
	if (fd < 0) {
		SMSIPCLog(@"event=ipc_call_connect_failed method=%@ path=%@ error=\"%@\"", method, path, localError.localizedDescription);
		if (error) *error = localError;
		return nil;
	}
	NSMutableDictionary *request = [NSMutableDictionary dictionaryWithObject:method forKey:@"m"];
	if (args) request[@"a"] = args;
	id result = nil;
	NSDictionary *response = nil;
	if (SMSIPCWriteFrame(fd, request, &localError)) {
		response = SMSIPCReadFrame(fd, &localError);
	}
	close(fd);
	double elapsedMs = (CFAbsoluteTimeGetCurrent() - started) * 1000.0;
	if (!response) {
		SMSIPCLog(@"event=ipc_call_failed method=%@ elapsed_ms=%.1f error=\"%@\"", method, elapsedMs, localError.localizedDescription);
		if (error) *error = localError;
		return nil;
	}
	if (![response[@"ok"] boolValue]) {
		NSString *message = [response[@"e"] isKindOfClass:[NSString class]] ? response[@"e"] : @"remote error";
		SMSIPCLog(@"event=ipc_call_remote_error method=%@ elapsed_ms=%.1f error=\"%@\"", method, elapsedMs, message);
		if (error) *error = SMSIPCError(11, message);
		return nil;
	}
	result = response[@"r"];
	SMSIPCLog(@"event=ipc_call_ok method=%@ elapsed_ms=%.1f", method, elapsedMs);
	return result;
}

static __attribute__((unused)) BOOL SMSIPCSendOneway(NSString *path, NSString *method, id args, double timeoutSeconds) {
	NSError *error = nil;
	int fd = SMSIPCConnect(path, timeoutSeconds, &error);
	if (fd < 0) {
		SMSIPCLog(@"event=ipc_event_skipped method=%@ reason=\"%@\"", method, error.localizedDescription);
		return NO;
	}
	NSMutableDictionary *request = [NSMutableDictionary dictionaryWithDictionary:@{@"m": method, @"o": @YES}];
	if (args) request[@"a"] = args;
	BOOL ok = SMSIPCWriteFrame(fd, request, &error);
	close(fd);
	if (!ok) {
		SMSIPCLog(@"event=ipc_event_failed method=%@ error=\"%@\"", method, error.localizedDescription);
	}
	return ok;
}

static __attribute__((unused)) void SMSIPCHandleClient(int fd, SMSIPCHandler handler) {
	uid_t peerUid = (uid_t)-1;
	gid_t peerGid = (gid_t)-1;
	if (getpeereid(fd, &peerUid, &peerGid) != 0 || (peerUid != getuid() && peerUid != 0)) {
		SMSIPCLog(@"event=ipc_peer_rejected peer_uid=%d uid=%d", (int)peerUid, (int)getuid());
		close(fd);
		return;
	}
	NSError *error = nil;
	NSDictionary *request = SMSIPCReadFrame(fd, &error);
	if (!request) {
		SMSIPCLog(@"event=ipc_server_read_failed error=\"%@\"", error.localizedDescription);
		close(fd);
		return;
	}
	NSString *method = [request[@"m"] isKindOfClass:[NSString class]] ? request[@"m"] : nil;
	BOOL oneway = [request[@"o"] boolValue];
	NSMutableDictionary *response = [NSMutableDictionary dictionary];
	CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
	if (!method.length) {
		response[@"ok"] = @NO;
		response[@"e"] = @"missing method";
	} else {
		@try {
			id result = handler(method, request[@"a"]);
			response[@"ok"] = @YES;
			if (result && [NSPropertyListSerialization propertyList:result isValidForFormat:NSPropertyListBinaryFormat_v1_0]) {
				response[@"r"] = result;
			}
		} @catch (NSException *exception) {
			SMSIPCLog(@"event=ipc_handler_exception method=%@ name=%@ reason=\"%@\"", method, exception.name, exception.reason);
			response[@"ok"] = @NO;
			response[@"e"] = [NSString stringWithFormat:@"%@: %@", exception.name, exception.reason];
		}
	}
	SMSIPCLog(@"event=ipc_request_handled method=%@ oneway=%d ok=%@ elapsed_ms=%.1f", method, oneway, response[@"ok"], (CFAbsoluteTimeGetCurrent() - started) * 1000.0);
	if (!oneway && !SMSIPCWriteFrame(fd, response, &error)) {
		SMSIPCLog(@"event=ipc_server_write_failed method=%@ error=\"%@\"", method, error.localizedDescription);
	}
	close(fd);
}

static __attribute__((unused)) ino_t SMSIPCSocketInode(NSString *path) {
	struct stat st;
	if (lstat(path.fileSystemRepresentation, &st) != 0 || !S_ISSOCK(st.st_mode)) return 0;
	return st.st_ino;
}

static __attribute__((unused)) dispatch_source_t SMSIPCStartServer(NSString *path, double clientTimeoutSeconds, SMSIPCHandler handler) {
	if (!SMSIPCEnsureDirectory()) return nil;
	struct sockaddr_un addr;
	if (!SMSIPCFillAddress(&addr, path)) return nil;
	int fd = socket(AF_UNIX, SOCK_STREAM, 0);
	if (fd < 0) {
		SMSIPCLog(@"event=ipc_server_socket_failed path=%@ errno=%d", path, errno);
		return nil;
	}
	struct stat st;
	if (lstat(addr.sun_path, &st) == 0) {
		if (S_ISSOCK(st.st_mode)) {
			unlink(addr.sun_path);
		} else {
			SMSIPCLog(@"event=ipc_server_path_occupied path=%@ mode=%o", path, st.st_mode);
			close(fd);
			return nil;
		}
	}
	mode_t oldMask = umask(0077);
	int bound = bind(fd, (struct sockaddr *)&addr, sizeof(addr));
	umask(oldMask);
	if (bound != 0) {
		SMSIPCLog(@"event=ipc_server_bind_failed path=%@ errno=%d error=%s", path, errno, strerror(errno));
		close(fd);
		return nil;
	}
	chmod(addr.sun_path, 0600);
	ino_t boundInode = SMSIPCSocketInode(path);
	if (listen(fd, 64) != 0) {
		SMSIPCLog(@"event=ipc_server_listen_failed path=%@ errno=%d", path, errno);
		close(fd);
		unlink(addr.sun_path);
		return nil;
	}
	int flags = fcntl(fd, F_GETFL, 0);
	fcntl(fd, F_SETFL, flags | O_NONBLOCK);
	dispatch_queue_t acceptQueue = dispatch_queue_create("com.ianwelker.smserver.ipc.accept", DISPATCH_QUEUE_SERIAL);
	dispatch_queue_t workQueue = dispatch_queue_create("com.ianwelker.smserver.ipc.work", DISPATCH_QUEUE_CONCURRENT);
	dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)fd, 0, acceptQueue);
	if (!source) {
		SMSIPCLog(@"event=ipc_server_source_failed path=%@", path);
		close(fd);
		return nil;
	}
	SMSIPCHandler retainedHandler = [handler copy];
	dispatch_source_set_event_handler(source, ^{
		for (;;) {
			int client = accept(fd, NULL, NULL);
			if (client < 0) {
				if (errno == EINTR) continue;
				if (errno != EAGAIN && errno != EWOULDBLOCK) {
					SMSIPCLog(@"event=ipc_server_accept_failed path=%@ errno=%d", path, errno);
				}
				break;
			}
			int clientFlags = fcntl(client, F_GETFL, 0);
			fcntl(client, F_SETFL, clientFlags & ~O_NONBLOCK);
			SMSIPCConfigureSocket(client, clientTimeoutSeconds);
			dispatch_async(workQueue, ^{
				@autoreleasepool {
					SMSIPCHandleClient(client, retainedHandler);
				}
			});
		}
	});
	dispatch_source_set_cancel_handler(source, ^{
		close(fd);
		BOOL owned = boundInode != 0 && SMSIPCSocketInode(path) == boundInode;
		if (owned) unlink(addr.sun_path);
		SMSIPCLog(@"event=ipc_server_stopped path=%@ unlinked=%d", path, owned);
	});
	dispatch_resume(source);
	SMSIPCLog(@"event=ipc_server_started path=%@ fd=%d", path, fd);
	return source;
}

static __attribute__((unused)) dispatch_source_t SMSIPCStartManagedServer(NSString *path, double clientTimeoutSeconds, double checkIntervalSeconds, SMSIPCHandler handler) {
	SMSIPCHandler retainedHandler = [handler copy];
	__block dispatch_source_t current = SMSIPCStartServer(path, clientTimeoutSeconds, retainedHandler);
	__block ino_t currentInode = SMSIPCSocketInode(path);
	__block NSUInteger restarts = 0;
	dispatch_queue_t queue = dispatch_queue_create("com.ianwelker.smserver.ipc.watchdog", DISPATCH_QUEUE_SERIAL);
	dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
	uint64_t interval = (uint64_t)(checkIntervalSeconds * (double)NSEC_PER_SEC);
	dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, (int64_t)interval), interval, interval / 4);
	dispatch_source_set_event_handler(timer, ^{
		ino_t onDisk = SMSIPCSocketInode(path);
		if (current && onDisk != 0 && onDisk == currentInode) return;
		if (current && onDisk != 0) {
			int probe = SMSIPCConnect(path, 1.0, NULL);
			if (probe >= 0) {
				close(probe);
				return;
			}
			SMSIPCLog(@"event=ipc_server_stale_socket path=%@ ours=%llu on_disk=%llu", path, (unsigned long long)currentInode, (unsigned long long)onDisk);
		}
		restarts++;
		if (restarts <= 3 || restarts % 30 == 0) {
			SMSIPCLog(@"event=ipc_server_restart path=%@ reason=%@ restarts=%lu", path, current ? @"socket_missing" : @"not_running", (unsigned long)restarts);
		}
		if (current) dispatch_source_cancel(current);
		current = SMSIPCStartServer(path, clientTimeoutSeconds, retainedHandler);
		currentInode = SMSIPCSocketInode(path);
	});
	dispatch_resume(timer);
	SMSIPCLog(@"event=ipc_managed_server path=%@ running=%d interval_s=%.0f", path, current != nil, checkIntervalSeconds);
	return timer;
}

#endif
