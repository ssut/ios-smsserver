#!/usr/bin/env bash
set -euo pipefail

ROOTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-${ROOTDIR}/package/out}"
WORK_DIR="${WORK_DIR:-${ROOTDIR}/package/.work}"
THEOS="${THEOS:-${HOME}/theos}"
export THEOS

log() { printf '[build-rootless] %s\n' "$*" >&2; }

require() {
	command -v "$1" >/dev/null 2>&1 || { log "event=missing_tool tool=$1"; exit 1; }
}

require xcodebuild
require ldid
require pod
require openssl
require python3
[ -d "${THEOS}/makefiles" ] || { log "event=missing_theos path=${THEOS}"; exit 1; }

rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}" "${OUT_DIR}"

log "event=tweak_build_start"
/usr/bin/make -C "${ROOTDIR}/libsmserver" clean >/dev/null
/usr/bin/make -C "${ROOTDIR}/libsmserver" package FINALPACKAGE=1 THEOS_PACKAGE_SCHEME=rootless
TWEAK_DEB="$(ls -t "${ROOTDIR}"/libsmserver/packages/com.janshai.libsmserver_*_iphoneos-arm64.deb | head -n 1)"
cp -f "${TWEAK_DEB}" "${OUT_DIR}/"
log "event=tweak_build_done deb=${TWEAK_DEB}"

if [ ! -f "${ROOTDIR}/src/SMServer/identity.pfx" ] || [ ! -f "${ROOTDIR}/src/SMServer/shared/IdentityPass.swift" ]; then
	log "event=identity_generate"
	pass="$(openssl rand -hex 16)"
	tmp="$(mktemp -d)"
	openssl req -x509 -newkey rsa:4096 -keyout "${tmp}/key.pem" -out "${tmp}/cert.pem" -days 9999 -nodes -subj "/C=ZZ/ST=./L=./O=./CN=smserver.com" >/dev/null 2>&1
	[ -f "${ROOTDIR}/src/SMServer/cert.der" ] || openssl x509 -outform der -in "${tmp}/cert.pem" -out "${ROOTDIR}/src/SMServer/cert.der"
	openssl pkcs12 -export -out "${ROOTDIR}/src/SMServer/identity.pfx" -inkey "${tmp}/key.pem" -in "${tmp}/cert.pem" -password pass:"${pass}" -legacy 2>/dev/null || \
		openssl pkcs12 -export -out "${ROOTDIR}/src/SMServer/identity.pfx" -inkey "${tmp}/key.pem" -in "${tmp}/cert.pem" -password pass:"${pass}"
	rm -rf "${tmp}"
	printf 'class PKCS12Identity {\n\tstatic let pass: String = "%s"\n}\n' "${pass}" > "${ROOTDIR}/src/SMServer/shared/IdentityPass.swift"
fi

if [ ! -d "${ROOTDIR}/src/Pods" ]; then
	log "event=pod_install"
	(cd "${ROOTDIR}/src" && pod install)
fi

ARCHIVE="${WORK_DIR}/SMServer.xcarchive"
log "event=app_build_start archive=${ARCHIVE}"
(cd "${ROOTDIR}/src" && xcodebuild archive \
	-workspace SMServer.xcworkspace \
	-scheme SMServer \
	-configuration Release \
	-archivePath "${ARCHIVE}" \
	-destination "generic/platform=iOS" \
	ARCHS="arm64" \
	EXCLUDED_ARCHS="arm64e" \
	ONLY_ACTIVE_ARCH=NO \
	IPHONEOS_DEPLOYMENT_TARGET=15.0 \
	CODE_SIGN_IDENTITY="" \
	CODE_SIGNING_REQUIRED=NO \
	CODE_SIGNING_ALLOWED=NO \
	-quiet)
APP_SRC="${ARCHIVE}/Products/Applications/SMServer.app"
[ -d "${APP_SRC}" ] || { log "event=app_missing path=${APP_SRC}"; exit 1; }
log "event=app_build_done"

STAGE="${WORK_DIR}/stage"
APP="${STAGE}/var/jb/Applications/SMServer.app"
mkdir -p "$(dirname "${APP}")"
cp -R "${APP_SRC}" "${APP}"
rm -f "${APP}/Frameworks/libmryipc.dylib" "${APP}/libmryipc.dylib"
rm -rf "${APP}/_CodeSignature" "${APP}/embedded.mobileprovision"
rm -f "${APP}/smserver_cert_pass.txt" "${APP}/identity.pfx" "${APP}/cert.der"

if otool -L "${APP}/SMServer" | grep -q libmryipc; then
	log "event=unexpected_dependency lib=libmryipc"
	exit 1
fi

for fw in "${APP}"/Frameworks/*.framework; do
	[ -d "${fw}" ] || continue
	bin="${fw}/$(basename "${fw}" .framework)"
	[ -f "${bin}" ] && ldid -S "${bin}" && log "event=signed path=${bin#${STAGE}}"
done
for dylib in "${APP}"/Frameworks/*.dylib; do
	[ -f "${dylib}" ] && ldid -S "${dylib}" && log "event=signed path=${dylib#${STAGE}}"
done
ldid -S"${ROOTDIR}/src/app.entitlements" "${APP}/SMServer"
log "event=signed path=${APP#${STAGE}}/SMServer entitlements=app.entitlements"

APP_DEB="$(python3 -I "${ROOTDIR}/package/mkdeb.py" --root "${STAGE}" --debian "${ROOTDIR}/package/DEBIAN" --out-dir "${OUT_DIR}")"
log "event=done tweak_deb=${OUT_DIR}/$(basename "${TWEAK_DEB}") app_deb=${APP_DEB}"
