# Builds a minimal x86_64 kernel + busybox initramfs from source. Nothing
# here is a prebuilt binary pulled from anywhere but kernel.org and
# busybox.net — this image only exists to produce the two boot artifacts
# under /out, which run.sh extracts and hands to QEMU on the host.

FROM debian:bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential bc bison flex libssl-dev libelf-dev \
    wget xz-utils bzip2 cpio ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN mkdir -p /out

# --- Kernel ---
ENV KERNEL_VERSION=7.1.8
RUN wget -q https://cdn.kernel.org/pub/linux/kernel/v7.x/linux-${KERNEL_VERSION}.tar.xz \
    && tar xf linux-${KERNEL_VERSION}.tar.xz \
    && rm linux-${KERNEL_VERSION}.tar.xz

WORKDIR /build/linux-7.1.8
RUN make defconfig \
    && ./scripts/config \
         --enable CONFIG_BLK_DEV_INITRD \
         --enable CONFIG_SERIAL_8250 \
         --enable CONFIG_SERIAL_8250_CONSOLE \
         --enable CONFIG_DEVTMPFS \
         --enable CONFIG_DEVTMPFS_MOUNT \
    && make olddefconfig \
    && make -j"$(nproc)" bzImage \
    && cp arch/x86/boot/bzImage /out/bzImage

# --- BusyBox (statically linked) ---
WORKDIR /build
ENV BUSYBOX_VERSION=1.38.0
RUN wget -q https://busybox.net/downloads/busybox-${BUSYBOX_VERSION}.tar.bz2 \
    && tar xf busybox-${BUSYBOX_VERSION}.tar.bz2 \
    && rm busybox-${BUSYBOX_VERSION}.tar.bz2

WORKDIR /build/busybox-1.38.0
# defconfig's "tc" applet needs kernel qdisc structs (CBQ) that no longer
# exist in modern headers — we don't use networking at all, so drop it
# rather than fight header compatibility.
RUN make defconfig \
    && sed -i \
         -e 's/# CONFIG_STATIC is not set/CONFIG_STATIC=y/' \
         -e 's/^CONFIG_TC=y/# CONFIG_TC is not set/' \
         .config \
    && yes "" | make oldconfig \
    && make -j"$(nproc)" \
    && make install CONFIG_PREFIX=/build/rootfs

# --- hog: the memory-allocating demo program ---
COPY hog.c /build/hog.c
RUN gcc -static -O2 -o /build/rootfs/hog /build/hog.c

# --- init script ---
COPY init /build/rootfs/init
RUN chmod +x /build/rootfs/init /build/rootfs/hog

# --- assemble the initramfs ---
WORKDIR /build/rootfs
RUN mkdir -p proc sys dev \
    && find . | cpio -o -H newc | gzip -9 > /out/initramfs.cpio.gz
