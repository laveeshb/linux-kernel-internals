#!/usr/bin/env bash
# Boots the OOM-killer sandbox VM. Builds the kernel + initramfs from
# source on first run (via Docker), then boots them under QEMU on the
# host. Nothing here touches your real system — it's a fully isolated VM.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE_TAG="kernel-internals-oom-vm-builder"
ARTIFACT_DIR="build"

command -v docker >/dev/null || { echo "docker is required to build the sandbox image." >&2; exit 1; }
command -v qemu-system-x86_64 >/dev/null || { echo "qemu-system-x86_64 is required to run it." >&2; exit 1; }

if [ ! -f "$ARTIFACT_DIR/bzImage" ] || [ ! -f "$ARTIFACT_DIR/initramfs.cpio.gz" ]; then
  echo "Building the kernel and initramfs from source — one-time, can take several minutes..."
  docker build -t "$IMAGE_TAG" .
  mkdir -p "$ARTIFACT_DIR"
  cid=$(docker create "$IMAGE_TAG")
  docker cp "$cid:/out/bzImage" "$ARTIFACT_DIR/bzImage"
  docker cp "$cid:/out/initramfs.cpio.gz" "$ARTIFACT_DIR/initramfs.cpio.gz"
  docker rm "$cid" >/dev/null
fi

echo "Booting the sandbox (256MB RAM, most of it deliberately eaten by the"
echo "spawned processes). It powers itself off when done."
echo ""
exec qemu-system-x86_64 \
  -kernel "$ARTIFACT_DIR/bzImage" \
  -initrd "$ARTIFACT_DIR/initramfs.cpio.gz" \
  -append "console=ttyS0 panic=1 loglevel=4 cma=1M" \
  -m 256M \
  -nographic \
  -no-reboot
