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

| Page | What it covers |
|------|----------------|
| [LSM Framework](lsm.md) | LSM hooks, SELinux, AppArmor architecture |
| [Capabilities](capabilities.md) | Linux capability model, privilege dropping |
| [seccomp BPF](seccomp.md) | Syscall filtering, libseccomp, container profiles |
