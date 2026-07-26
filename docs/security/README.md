# Linux Security

> Privilege model, mandatory access control, and syscall filtering

## Security layers

Linux uses a layered security model:

```
Application
    │
    ▼
Syscall entry
    │
    ├── DAC (Discretionary Access Control): uid/gid/permissions ─── always
    │
    ├── Capabilities: fine-grained privilege splitting ──────────── always
    │
    ├── LSM hooks (SELinux / AppArmor / TOMOYO) ──────────────────── if enabled
    │
    └── seccomp BPF: syscall whitelist/blacklist ─────────────────── if installed
```

**DAC** (file permissions, uid/gid) is always enforced. **LSM** adds Mandatory Access Control policies on top. **Capabilities** split "root privilege" into 40 discrete permissions. **seccomp** restricts which syscalls a process can make.

## Pages in this section

### Access control

| Page | What it covers |
|------|----------------|
| [LSM Framework](lsm.md) | LSM hooks, SELinux, AppArmor architecture |
| [SELinux](selinux.md) | Labels, policy, AVC — how MAC decisions are made |
| [Landlock](landlock.md) | Unprivileged sandboxing from userspace |
| [Capabilities](capabilities.md) | Linux capability model, privilege dropping |
| [Credentials](credentials.md) | struct cred, uid/euid/fsuid, credential lifecycle |
| [User Namespaces](user-namespaces.md) | Unprivileged containers and their attack surface |

### Syscall & kernel hardening

| Page | What it covers |
|------|----------------|
| [seccomp BPF](seccomp.md) | Syscall filtering, libseccomp, container profiles |
| [Kernel Hardening](kernel-hardening.md) | Stack protector, CFI, mitigations landscape |
| [Audit](audit.md) | The audit subsystem, rules, and its cost |

### Storage encryption

| Page | What it covers |
|------|----------------|
| [fscrypt](fscrypt.md) | Filesystem-level encryption (ext4/f2fs) |
| [dm-crypt](dm-crypt.md) | Block-level encryption, LUKS |
