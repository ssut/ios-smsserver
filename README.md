<p align="center"><img src="assets/icon_small.png" /></p>
<h1 align="center">SMServer (rootless iOS 15/16)</h1>
<p align="center"><a href="https://github.com/ssut/ios-smsserver/blob/main/LICENSE"><img src="https://img.shields.io/github/license/ssut/ios-smsserver.svg?style=flat"></a></p>

**SMServer is a jailbreak iPhone app that lets you read and send SMS, MMS and iMessages from a web browser or over a JSON API.**

This repository is a maintained fork of [itsjunetime/smserver](https://github.com/itsjunetime/smserver) (by way of [jsupa/smserver-fork](https://github.com/jsupa/smserver-fork)). The upstream project stopped development before rootless jailbreaks and iOS 16. This fork targets **rootless jailbreaks (Dopamine, palera1n) on iOS 15 and 16**. It was tested on an iPhone X running iOS 16.7.16 with Dopamine and ElleKit.

## What changed from upstream

- **No libMRYIPC.** The app and the SpringBoard tweak talk over two Unix domain sockets in `/var/mobile/Library/SMServer/`. The sockets are owned by `mobile`, use mode `0600`, and the peer uid is checked. Every call has a timeout, and an IPC failure never throws into SpringBoard or the app. Upstream MRYIPC needs a helper tweak injected into MobileGestaltHelper and aborts the calling process whenever a lookup fails.
- **iOS 16 IMCore support.**
  - `-[IMDaemonController _capabilities]` is gone on iOS 16. The tweak hooks `processCapabilities` instead and connects with `connectToDaemonWithLaunch:capabilities:blockUntilConnected:`. This fixes the send that stalls at 90% ([upstream #149](https://github.com/itsjunetime/smserver/issues/149)).
  - Tapbacks and deletes use the iOS 16 selectors, with the old ones as fallback.
  - Accounts are chosen by whether they are usable. When a conversation's iMessage account is not registered, the message falls back to SMS/MMS.
- **No more safe-mode crashes.** Upstream ran `/bin/sh -c "ps aux | grep …"` from SpringBoard on every message change. That path does not exist on rootless, so SpringBoard crashed into safe mode.
- **iOS 16 message bodies.** About 40% of iOS 16 messages store their text only in `attributedBody`. The app decodes it, so chat previews, threads and search are no longer blank.
- **Entitlements for rootless.**
  - `platform-application`, `no-sandbox` and `no-container`.
  - The Messages and Photos storage classes, without which `sms.db` cannot be opened when the app is launched from the home screen.
  - The IOKit GPU user clients that Metal needs.
- **New web UI.** It is responsive, works offline (no CDN), and supports dark, light and nord themes. It shows a conversation list and thread with tapbacks, attachments, a camera-roll picker, search, notifications and typing indicators, and it reconnects the WebSocket automatically.
- **New native app screen** in SwiftUI. It shows server status, addresses with a QR code, and the Messages tweak connection state, plus an API token and settings.
- **REST API v1** under `/api/v1`, with bearer tokens, sessions, CORS, pagination, attachment Range requests and a WebSocket event stream. Failed sends return the real reason.
- **Rootless build and install scripts**, plus file logs for both processes.

## Requirements

- iPhone on iOS 15 or 16 with a rootless jailbreak (Dopamine or palera1n) and ElleKit (or another `mobilesubstrate` provider)
- `openssl` from Procursus (the package `postinst` uses it to create the TLS certificate)
- To build: macOS with Xcode, [Theos](https://theos.dev) in `~/theos`, and `ldid` and `cocoapods` from Homebrew

libMRYIPC is **not** needed.

## Build

```bash
git clone --recursive --depth 1 https://github.com/theos/theos.git ~/theos
brew install ldid cocoapods
./package/build-rootless.sh
```

The script builds the tweak with Theos and archives the app with `xcodebuild`, without code signing. It then signs the app with `ldid -Ssrc/app.entitlements` and writes two rootless debs to `package/out/`:

- `com.janshai.libsmserver_<version>_iphoneos-arm64.deb`: the SpringBoard tweak
- `com.ianwelker.smserver_<version>_iphoneos-arm64.deb`: the app

The app deb is written with `package/mkdeb.py`. It produces ustar tar members, because some rootless `dpkg` builds reject PAX headers.

## Install

Copy the two debs and `package/device-install.sh` to the phone, then run the script as root:

```bash
scp package/out/*.deb package/device-install.sh mobile@<iphone-ip>:/var/mobile/Media/
```

```bash
ssh mobile@<iphone-ip> "sudo /var/jb/bin/sh /var/mobile/Media/device-install.sh /var/mobile/Media/com.janshai.libsmserver_*.deb /var/mobile/Media/com.ianwelker.smserver_*.deb"
```

`device-install.sh` does the following:

1. Unpacks both packages.
2. Adds every new Mach-O CDHash to the Dopamine trust cache.
3. Removes a leftover ElleKit safe-mode marker.
4. Configures the packages. The tweak resprings SpringBoard. The app `postinst` creates the TLS identity (it keeps an existing valid one) and the IPC folder.

When upgrading from upstream or 0.9.1, the old `postrm` deletes the app during the upgrade. Run `device-install.sh` with the app deb a second time.

## Run

1. Open SMServer and start the server.
2. Open the address shown in the app in a browser. The default password is `toor`. Change it in Settings.
3. The status card should show **Messages tweak: connected**. If it does not, reading works but sending does not (see Troubleshooting).

## API

Copy the API token from Settings → API, then:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://<iphone-ip>:8741/api/v1/chats?limit=20"
```

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"text":"Hello"}' "http://<iphone-ip>:8741/api/v1/chats/%2B15551234567/messages"
```

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -F "text=Photo" -F "attachments=@a.jpg" "http://<iphone-ip>:8741/api/v1/chats/%2B15551234567/messages"
```

Main endpoints, all under `/api/v1`:

- `GET /health` (no auth), `GET /server`, `GET /server/tweak`
- `POST /auth/login` (`{"password": …}` returns a session token), `POST /auth/logout`, `GET /auth/session`
- `GET /chats?limit&offset`, `GET /chats/pinned`, `GET|DELETE /chats/{chat_id}`
- `GET /chats/{chat_id}/messages?limit&before&after&mark_read`, `POST /chats/{chat_id}/messages` (JSON or multipart with files)
- `POST /messages` (new conversation, `chat_id` in the body), `GET|DELETE /messages/{guid}`, `POST|DELETE /messages/{guid}/tapback`
- `POST /chats/{chat_id}/read`, `POST /chats/{chat_id}/typing`
- `GET /search?q`, `GET /contacts/match?q`, `GET /contacts/{chat_id}/photo`
- `GET /attachments/{path}` (supports Range requests), `GET /photos`, `GET /photos/{path}`

Encode `+` as `%2B` and `@` as `%40` in `chat_id`. Errors use `{"error": {"code": …, "message": …}}`. A send returns `202` once Messages has accepted it.

Real-time events (`new-message`, `typing`, `read-message`, `battery-status`) come from `ws://<iphone-ip>:8740/?token=$TOKEN`. Use `https`/`wss` and `curl -k` when TLS is on. The legacy `/requests`, `/data` and `/send` endpoints still work.

## Troubleshooting

- **Logs.** The app writes `/var/mobile/Library/SMServer/smserver.log` and the tweak writes `springboard.log` in the same folder (both rotate at 2 MB). Turn on debug logging in the app settings. Live system logs are available with `oslog` from Procursus.
- **Tweak IPC check.** Build `libsmserver/tools/smsctl.m`, then copy it to `/var/jb/usr/bin`, sign it with `ldid -S` and add it to the trust cache. `smsctl ping` should print `"connected" : true` and `"capabilities" : 4485895`.
- **"Messages tweak unreachable".** Respring. If `springboard.sock` is missing, reinstall the tweak deb.
- **"failed to start".** Something else holds port 8741, for example a headless copy started over SSH (`SMServer --background`). Run `killall SMServer` and start again.
- **Sends never leave the phone.** Check that iMessage is registered (Settings → Messages). Without it, sends go out as SMS/MMS.
- **Images or email recipients fail over SMS.** They need MMS, and MMS needs cellular data.
- **Remote relay.** A configured relay that cannot be reached no longer blocks the local server. The app shows the relay error instead.

## Disclaimer

This software comes with **no warranty** and is provided **as is**. It hooks SpringBoard and talks to private Apple frameworks. Use it at your own risk.

## Credits and license

- [itsjunetime/smserver](https://github.com/itsjunetime/smserver) and [libsmserver](https://github.com/iandwelker/libsmserver) by June Welker: the original app and tweak
- [jsupa/smserver-fork](https://github.com/jsupa/smserver-fork): first rootless packaging and CI
- Licensed under the [GNU General Public License v3.0](LICENSE)
