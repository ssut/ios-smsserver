#include <TargetConditionals.h>

#if TARGET_OS_IPHONE
#import <Foundation/Foundation.h>
#import "PrivateHeaders.h"
#import "../ios/Sender.h"
#else
#import "../mac/Sender.m"
#endif
