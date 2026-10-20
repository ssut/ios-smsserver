ARCHS = arm64 arm64e
TARGET := iphone:clang:latest:15.0
THEOS_PACKAGE_SCHEME ?= rootless
INSTALL_TARGET_PROCESSES = SpringBoard

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = libsmserver

libsmserver_FILES = Tweak.xm
libsmserver_CFLAGS = -fobjc-arc -Wno-unused-function -Wno-deprecated-declarations
libsmserver_FRAMEWORKS = Foundation UIKit

include $(THEOS_MAKE_PATH)/tweak.mk

before-stage::
	find . -name ".DS_Store" -delete
