# Live Patching and kexec

> Updating a running kernel without rebooting

## Pages in this section

| Page | What it covers |
|------|----------------|
| [Kernel Live Patching](klp.md) | KLP, struct klp_patch, ftrace redirection, consistency model |
| [KLP Consistency Model](klp-consistency.md) | Per-task patch state, stack checking, transition workqueue, forced transitions |
| [Cumulative Patches and Atomic Replace](klp-cumulative.md) | Patch stacking, .replace=true, struct klp_ops, disabling and removing patches |
| [KLP State: Custom Consistency Checks](klp-state.md) | klp_state API, transition callbacks, pre/post patch hooks, cumulative state inheritance |
| [kexec](kexec.md) | kexec_load, machine_kexec, kdump integration, fast reboot |
| [War Stories](war-stories.md) | Stuck transitions, shadow variable leaks, compat syscall misses, inline functions |

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
