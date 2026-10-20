#!/usr/bin/env python3
import argparse
import io
import json
import lzma
import os
import sys
import tarfile
import time


def log(event, **fields):
    payload = {"event": event, **fields}
    print("[mkdeb] " + " ".join(f"{k}={json.dumps(v) if isinstance(v, str) and ' ' in v else v}" for k, v in payload.items()), file=sys.stderr)


def read_control(debian_dir):
    with open(os.path.join(debian_dir, "control"), "r", encoding="utf-8") as fh:
        fields = {}
        for line in fh:
            if ":" in line and not line.startswith((" ", "\t")):
                key, value = line.split(":", 1)
                fields[key.strip()] = value.strip()
        return fields


def tar_filter(info):
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "wheel"
    info.mtime = int(time.time())
    if info.isdir():
        info.mode = 0o755
    elif info.isfile():
        info.mode = 0o755 if info.mode & 0o111 else 0o644
    return info


def build_tar(root, entries):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for arcname, path in entries:
            info = tar.gettarinfo(path, arcname=arcname)
            info = tar_filter(info)
            if info.isfile():
                with open(path, "rb") as fh:
                    tar.addfile(info, fh)
            else:
                tar.addfile(info)
    return buffer.getvalue()


def collect(root):
    entries = [("./", root)]
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        filenames.sort()
        rel_dir = os.path.relpath(dirpath, root)
        for name in dirnames:
            rel = os.path.normpath(os.path.join(rel_dir, name))
            entries.append(("./" + rel + "/", os.path.join(dirpath, name)))
        for name in filenames:
            if name == ".DS_Store":
                continue
            rel = os.path.normpath(os.path.join(rel_dir, name))
            entries.append(("./" + rel, os.path.join(dirpath, name)))
    return entries


def ar_member(name, data):
    header = f"{name:<16}{int(time.time()):<12}{0:<6}{0:<6}{'100644':<8}{len(data):<10}`\n".encode("ascii")
    assert len(header) == 60
    return header + data + (b"\n" if len(data) % 2 else b"")


def installed_size_kb(root):
    total = 0
    for dirpath, _, filenames in os.walk(root):
        for name in filenames:
            total += os.path.getsize(os.path.join(dirpath, name))
    return max(1, total // 1024)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--debian", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()

    control = read_control(args.debian)
    for key in ("Package", "Version", "Architecture"):
        if key not in control:
            log("control_invalid", missing=key)
            return 2

    control_text = open(os.path.join(args.debian, "control"), "r", encoding="utf-8").read().rstrip("\n")
    if "Installed-Size" not in control:
        control_text += f"\nInstalled-Size: {installed_size_kb(args.root)}"
    control_text += "\n"

    control_buffer = io.BytesIO()
    with tarfile.open(fileobj=control_buffer, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        dir_info = tarfile.TarInfo("./")
        dir_info.type = tarfile.DIRTYPE
        tar.addfile(tar_filter(dir_info))
        data = control_text.encode("utf-8")
        info = tarfile.TarInfo("./control")
        info.size = len(data)
        tar.addfile(tar_filter(info), io.BytesIO(data))
        for script in ("preinst", "postinst", "prerm", "postrm", "extrainst_"):
            path = os.path.join(args.debian, script)
            if os.path.isfile(path):
                info = tar.gettarinfo(path, arcname="./" + script)
                info = tar_filter(info)
                info.mode = 0o755
                with open(path, "rb") as fh:
                    tar.addfile(info, fh)

    data_tar = build_tar(args.root, collect(args.root))
    control_xz = lzma.compress(control_buffer.getvalue(), format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC32)
    data_xz = lzma.compress(data_tar, format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC32)

    os.makedirs(args.out_dir, exist_ok=True)
    out_path = os.path.join(args.out_dir, f"{control['Package']}_{control['Version']}_{control['Architecture']}.deb")
    with open(out_path, "wb") as fh:
        fh.write(b"!<arch>\n")
        fh.write(ar_member("debian-binary", b"2.0\n"))
        fh.write(ar_member("control.tar.xz", control_xz))
        fh.write(ar_member("data.tar.xz", data_xz))
    log("deb_built", path=out_path, bytes=os.path.getsize(out_path), package=control["Package"], version=control["Version"])
    print(out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
