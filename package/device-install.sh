#!/var/jb/bin/sh
set -eu
export PATH=/var/jb/usr/bin:/var/jb/bin:/var/jb/usr/sbin:/var/jb/sbin:/usr/bin:/bin:/usr/sbin:/sbin
export DEBIAN_FRONTEND=noninteractive

log() { echo "[device-install] $*"; }

[ "$(id -u)" = "0" ] || { log "event=not_root"; exit 1; }
[ "$#" -ge 1 ] || { log "event=usage msg=\"device-install.sh <deb>...\""; exit 64; }

packages=""
for deb in "$@"; do
	[ -f "$deb" ] || { log "event=missing_deb path=$deb"; exit 1; }
	name=$(dpkg-deb -f "$deb" Package)
	version=$(dpkg-deb -f "$deb" Version)
	log "event=unpack package=$name version=$version"
	dpkg --unpack "$deb"
	packages="$packages $name"
done

trusted=$(jbctl trustcache info 2>/dev/null | tr 'a-f' 'A-F')
added=0
present=0
for pkg in $packages; do
	for f in $(dpkg -L "$pkg"); do
		[ -f "$f" ] || continue
		hashes=$(ldid -h "$f" 2>/dev/null | sed -n 's/^CDHash=//p' | tr 'a-f' 'A-F')
		for h in $hashes; do
			if echo "$trusted" | grep -q "$h"; then
				present=$((present + 1))
			else
				jbctl trustcache add "$h" >/dev/null
				added=$((added + 1))
				log "event=trustcache_added package=$pkg file=$f cdhash=$h"
			fi
		done
	done
done
log "event=trustcache_checked added=$added already_present=$present"

for marker in /var/mobile/.eksafemode /var/mobile/Library/.eksafemode; do
	if [ -e "$marker" ]; then
		rm -f "$marker"
		log "event=safe_mode_marker_removed path=$marker"
	fi
done

dpkg --configure -a
for pkg in $packages; do
	log "event=installed package=$pkg status=\"$(dpkg-query -W -f='${Status} ${Version}' "$pkg")\""
done
