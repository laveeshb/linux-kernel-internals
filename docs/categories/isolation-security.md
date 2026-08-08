# Isolation & Security

The mechanisms that separate, confine, and protect workloads — from containers to access control to running whole guests.

- [Cgroups (cgroups/)](../cgroups/README.md) — accounting for and limiting resources per group of processes; the basis of containers
- [Security (security/)](../security/README.md) — LSMs, capabilities, seccomp, and the kernel's access-control machinery
- [Virtualization (virtualization/)](../virtualization/README.md) — KVM and how the kernel runs guest machines
- [Crypto (crypto/)](../crypto/README.md) — the kernel's cryptographic API and hardware acceleration
- [Livepatch (livepatch/)](../livepatch/README.md) — patching a running kernel without rebooting
