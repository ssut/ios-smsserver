#import <Foundation/Foundation.h>
#import "../SMSIPC.h"

static int SMSCtlUsage(void) {
	fprintf(stderr, "usage: smsctl ping | pinned | call <method> [json-args] [--app]\n");
	return 64;
}

static void SMSCtlPrint(id object) {
	if (!object) {
		printf("null\n");
		return;
	}
	if ([NSJSONSerialization isValidJSONObject:object]) {
		NSData *data = [NSJSONSerialization dataWithJSONObject:object options:NSJSONWritingPrettyPrinted error:nil];
		printf("%s\n", [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] UTF8String]);
	} else {
		printf("%s\n", [[object description] UTF8String]);
	}
}

int main(int argc, char *argv[]) {
	@autoreleasepool {
		if (argc < 2) return SMSCtlUsage();
		NSString *command = @(argv[1]);
		NSString *path = SMSIPC_SPRINGBOARD_SOCKET;
		NSMutableArray<NSString *> *rest = [NSMutableArray array];
		for (int idx = 2; idx < argc; idx++) {
			NSString *arg = @(argv[idx]);
			if ([arg isEqualToString:@"--app"]) path = SMSIPC_APP_SOCKET;
			else [rest addObject:arg];
		}
		NSString *method = nil;
		id args = nil;
		if ([command isEqualToString:@"ping"]) {
			method = @"ping";
		} else if ([command isEqualToString:@"pinned"]) {
			method = @"getPinnedChats";
		} else if ([command isEqualToString:@"call"] && rest.count >= 1) {
			method = rest[0];
			if (rest.count >= 2) {
				NSData *json = [rest[1] dataUsingEncoding:NSUTF8StringEncoding];
				NSError *error = nil;
				args = [NSJSONSerialization JSONObjectWithData:json options:NSJSONReadingFragmentsAllowed error:&error];
				if (!args) {
					fprintf(stderr, "invalid json: %s\n", error.localizedDescription.UTF8String);
					return 65;
				}
			}
		} else {
			return SMSCtlUsage();
		}
		NSError *error = nil;
		CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
		id result = SMSIPCCall(path, method, args, 90.0, &error);
		fprintf(stderr, "method=%s path=%s elapsed_ms=%.1f error=%s\n", method.UTF8String, path.UTF8String, (CFAbsoluteTimeGetCurrent() - started) * 1000.0, error ? error.localizedDescription.UTF8String : "none");
		if (error) return 1;
		SMSCtlPrint(result);
		return 0;
	}
}
