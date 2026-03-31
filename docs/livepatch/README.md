# Live Patching and kexec

> Updating a running kernel without rebooting

## Pages in this section

| Page | What it covers |
|------|----------------|
| [Kernel Live Patching](klp.md) | KLP, struct klp_patch, ftrace redirection, consistency model |
| [kexec](kexec.md) | kexec_load, machine_kexec, kdump integration, fast reboot |

## Quick reference

```bash
# Check if live patching is supported
grep CONFIG_LIVEPATCH /boot/config-$(uname -r)
# CONFIG_LIVEPATCH=y

# List active live patches
cat /sys/kernel/livepatch/*/enabled

# Apply a live patch (kernel module)
insmod mypatch.ko
cat /sys/kernel/livepatch/mypatch/enabled
# 1 = active and consistent

# Disable a live patch
echo 0 > /sys/kernel/livepatch/mypatch/enabled

# kexec: load a new kernel
kexec -l /boot/vmlinuz --initrd=/boot/initrd.img --reuse-cmdline

# Execute the loaded kernel (immediate, no POST)
kexec -e
```
