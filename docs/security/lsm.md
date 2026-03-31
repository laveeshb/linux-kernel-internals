# Linux Security Module (LSM) Framework

> The kernel's hook-based Mandatory Access Control infrastructure

## What LSM is

The Linux Security Module framework (introduced in 2.6) provides a set of hooks throughout the kernel where security modules can enforce additional access controls beyond standard DAC.

LSM hooks are called at security-critical points:
- File open/read/write/execute
- Network socket creation and connections
- Process creation and credential changes
- IPC operations
- Capability checks

Multiple LSMs can be active simultaneously (stacking, since 4.2). The kernel evaluates all of them: access is granted only if ALL LSMs allow it.

## LSM hook architecture

```c
/* security/security.c: the hook dispatch */

/* All LSM hook lists (one list per hook, not a pointer) */
static struct security_hook_heads security_hook_heads;

/* Example: file_open hook */
int security_file_open(struct file *file)
{
    return call_int_hook(file_open, 0, file);
    /* calls each registered LSM's file_open handler */
    /* returns the first non-zero result (denial) */
}
```

```c
/* A security module registers its hooks: */
static struct security_hook_list mymod_hooks[] __lsm_ro_after_init = {
    LSM_HOOK_INIT(file_open, mymod_file_open),
    LSM_HOOK_INIT(socket_connect, mymod_socket_connect),
    LSM_HOOK_INIT(inode_permission, mymod_inode_permission),
};

static int __init mymod_init(void)
{
    security_add_hooks(mymod_hooks, ARRAY_SIZE(mymod_hooks), "mymod");
    return 0;
}
DEFINE_LSM(mymod) = {
    .name    = "mymod",
    .init    = mymod_init,
    .enabled = &mymod_enabled,
};
```

## Complete list of LSM hook categories

```c
/* include/linux/lsm_hooks.h — over 200 hooks: */

/* File and inode operations */
file_open, file_permission, file_ioctl, file_mmap
inode_permission, inode_create, inode_link, inode_unlink
inode_mkdir, inode_rmdir, inode_rename, inode_readlink
inode_setattr, inode_getattr, inode_setxattr, inode_getxattr

/* Process credentials */
bprm_check_security, bprm_creds_for_exec
task_alloc, task_free, task_fix_setuid
cred_alloc_blank, cred_prepare, cred_transfer

/* Network */
socket_create, socket_bind, socket_connect
socket_listen, socket_accept, socket_recvmsg, socket_sendmsg
socket_sock_rcv_skb, socket_getpeersec_stream

/* IPC */
msg_queue_associate, msg_queue_msgctl
sem_associate, sem_semctl
shm_associate, shm_shmctl, shm_shmat

/* Capabilities */
capable, settime

/* System */
syslog, quotactl, sysctl, getprocattr, setprocattr

/* BPF */
bpf, bpf_map, bpf_prog
```

## SELinux

SELinux (Security-Enhanced Linux) implements Mandatory Access Control based on **labels** and **policies**.

### Labels

Every object (file, process, socket) has a security context:
```
user:role:type:level
system_u:system_r:httpd_t:s0
```

```bash
# See file context
ls -Z /etc/passwd
# system_u:object_r:passwd_file_t:s0 /etc/passwd

# See process context
ps -eZ | grep httpd
# system_u:system_r:httpd_t:s0 ... httpd

# See your context
id -Z
# unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023
```

### Policy

The policy defines which types can perform which operations on which other types:

```
# Allow httpd to read cert files
allow httpd_t cert_t:file { read getattr open };

# Allow httpd to bind to http ports
allow httpd_t http_port_t:tcp_socket name_bind;
```

```bash
# Check SELinux status
getenforce
# Enforcing | Permissive | Disabled

sestatus
# SELinux status:                 enabled
# SELinuxfs mount:                /sys/fs/selinux
# SELinux mount point:            /sys/fs/selinux
# SELinuxfs mount:                /sys/fs/selinux

# Set permissive (log but don't deny)
setenforce 0

# Check audit log for denials
ausearch -m AVC | tail -20
# type=AVC msg=audit(1234.567:890): avc:  denied  { read } for ...
# pid=1234 comm="nginx" name="secret.key" scontext=httpd_t tcontext=sysadm_home_t

# Fix: set correct label
chcon -t httpd_sys_content_t /var/www/html/myfile
restorecon /var/www/html/  # restore to policy default
```

### SELinux internals

```c
/* security/selinux/hooks.c: inode_permission hook */
static int selinux_inode_permission(struct inode *inode, int mask)
{
    const struct cred *cred = current_cred();
    struct inode_security_struct *isec;
    struct task_security_struct *tsec;
    u32 sid, newsid, perms;

    /* Get security labels */
    tsec = selinux_cred(cred);
    isec = selinux_inode(inode);

    /* Convert access mask to SELinux permission bits */
    perms = file_mask_to_av(inode->i_mode, mask);

    /* Call SELinux policy engine */
    rc = avc_has_perm(&selinux_state,
                      tsec->sid, isec->sid,
                      isec->sclass, perms, &ad);
    return rc;
}
```

## AppArmor

AppArmor uses **path-based** MAC — simpler than SELinux's label model. Profiles are plain text and specify what a program can do:

```
# /etc/apparmor.d/usr.bin.firefox
/usr/bin/firefox {
    # Allow reading these paths
    /etc/firefox/** r,
    /usr/share/firefox/** r,
    @{HOME}/.mozilla/** rw,

    # Deny everything else by default
    deny /etc/passwd r,

    # Network
    network inet stream,
    network inet6 stream,
}
```

```bash
# Load a profile
apparmor_parser -r /etc/apparmor.d/usr.bin.firefox

# Check status
aa-status
# profiles are loaded:
#   /usr/bin/firefox (enforce)
#   /usr/bin/evince (complain)

# Set profile to complain mode (log but don't deny)
aa-complain /usr/bin/firefox

# Check logs
journalctl -g "apparmor" | tail -20
# apparmor="DENIED" operation="open" profile="/usr/bin/firefox"
# name="/etc/shadow" pid=1234 comm="firefox"
```

### AppArmor internals

AppArmor stores profiles as finite automata (DFA/HFA) for efficient path matching:

```c
/* security/apparmor/lsm.c: file_open hook */
static int apparmor_file_open(struct file *file)
{
    struct aa_label *label = aa_current_raw_label();
    struct aa_profile *profile;

    /* match path against profile DFA */
    aa_str_perms(profile->file.dfa,
                 profile->file.start,
                 path_name,
                 &perms);

    if (!(perms.allow & requested_perm))
        return -EACCES;
    return 0;
}
```

## Further reading

- [Capabilities](capabilities.md) — Privilege splitting without full root
- [seccomp BPF](seccomp.md) — Syscall-level filtering
- [Cgroups & Namespaces: Container Isolation](../cgroups/container-isolation.md) — LSM in containers
- `Documentation/security/lsm.rst` — LSM developer guide
