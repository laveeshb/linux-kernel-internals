# SELinux: Mandatory Access Control

> Security contexts, AVC cache, type enforcement policy, and audit2allow

## What is SELinux?

SELinux (Security-Enhanced Linux) implements **Mandatory Access Control (MAC)**: access decisions are made by a central security policy, not by object owners. Even root cannot override the policy without explicit permission.

```
Traditional DAC (Discretionary Access Control):
  owner of file → decides who can access it
  root → overrides everything

SELinux MAC:
  Central policy → decides every access
  root → still restricted by policy
  Even compromised root process → bounded by its security context
```

SELinux was developed by the NSA, open-sourced in December 2000, and merged into Linux 2.6.0-test3 (August 2003). It is built on the **LSM (Linux Security Module)** framework. Every security-sensitive kernel operation calls an LSM hook which SELinux intercepts.

## Security contexts

Every process and file has a **security context** (also called label):

```
Format: user:role:type:level
         ↑     ↑    ↑    ↑
         SELinux user  sensitivity:categories (MLS/MCS)

Examples:
  Process: system_u:system_r:httpd_t:s0
  File:    system_u:object_r:httpd_var_run_t:s0
  Port 80: system_u:object_r:http_port_t:s0
```

```bash
# View process context:
ps -eZ | grep httpd
# system_u:system_r:httpd_t:s0     1234 httpd

# View file context:
ls -Z /var/www/html/index.html
# system_u:object_r:httpd_content_t:s0 /var/www/html/index.html

# Your current context:
id -Z
# unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023

# Change context temporarily:
runcon -t httpd_t /bin/bash    # run shell as httpd_t

# View all contexts:
seinfo -t | grep httpd    # all httpd types
```

## Access Vector Cache (AVC)

Every access check goes through the **AVC** (Access Vector Cache). The AVC is a hash table that caches recent allow/deny decisions:

```c
/* security/selinux/avc.c */

struct avc_entry {
    u32             ssid;       /* source security ID */
    u32             tsid;       /* target security ID */
    u16             tclass;     /* target class (file, process, socket...) */
    struct av_decision avd;     /* allow/audit/etc bitmask */
};

/* Cache lookup: */
static inline int avc_lookup(struct selinux_avc *avc,
                              u32 ssid, u32 tsid, u16 tclass,
                              struct av_decision *avd)
{
    struct avc_node *node;
    unsigned long flags;

    node = avc_cache_lookup(avc, ssid, tsid, tclass);
    if (node) {
        *avd = node->ae.avd;
        /* cache hit: no need to consult policy */
        return 0;
    }
    /* cache miss: slow path → consult policy database */
    return avc_compute_av(ssid, tsid, tclass, avd);
}
```

```bash
# AVC statistics:
cat /sys/fs/selinux/avc/cache_stats
# lookups hits misses allocations reclaims frees
# 1234567 1200000 34567 34567 0 0
# ~97% hit rate typical

# AVC cache size:
cat /sys/fs/selinux/avc/cache_threshold
# 512 (entries)
```

## Type Enforcement (TE) policy

The most important policy mechanism. Rules grant access between types:

```
allow <source_type> <target_type>:<class> { <permissions> };

Examples:
# httpd can read httpd_content_t files:
allow httpd_t httpd_content_t:file { read getattr open };

# httpd cannot write to /etc (etc_t):
# (no allow rule → denied)

# httpd can bind to http_port_t ports:
allow httpd_t http_port_t:tcp_socket { name_bind };

# Allow httpd to connect to mysql:
allow httpd_t mysqld_port_t:tcp_socket name_connect;
```

### Policy source files

```bash
# Policy is compiled from .te (type enforcement) files:
ls /usr/share/selinux/targeted/*.pp    # compiled policy modules

# View policy for httpd:
sesearch --allow -s httpd_t /etc/selinux/targeted/policy/policy.33
# allow httpd_t httpd_config_t:file { read getattr open };
# allow httpd_t httpd_log_t:file { append create write ioctl lock };
# ...

# Check what a type can do:
sesearch --allow -s httpd_t -c file /etc/selinux/targeted/policy/policy.33

# What types can access a file type:
sesearch --allow -t httpd_content_t /etc/selinux/targeted/policy/policy.33
```

## File context labeling

```bash
# Default contexts come from file_contexts files:
cat /etc/selinux/targeted/contexts/files/file_contexts | grep www
# /var/www(/.*)?       system_u:object_r:httpd_content_t:s0
# /var/www/cgi-bin(/.*)? system_u:object_r:httpd_exec_t:s0

# Restore context to policy default:
restorecon -Rv /var/www/html/

# Set context manually:
chcon -t httpd_content_t /tmp/webpage.html
semanage fcontext -a -t httpd_content_t "/custom/web(/.*)?"
restorecon -Rv /custom/web/

# Check what the policy says a file's context should be:
matchpathcon /var/www/html/index.html
# /var/www/html/index.html system_u:object_r:httpd_content_t:s0
```

## Audit and audit2allow

When SELinux denies an access, it logs to the audit log:

```bash
# View recent denials:
audit2allow -w -a 2>/dev/null | head -30
# type=AVC msg=audit(1234567890.123:456): avc: denied { name_connect }
#     for pid=1234 comm="httpd" dest=3306
#     scontext=system_u:system_r:httpd_t:s0
#     tcontext=system_u:object_r:mysqld_port_t:s0
#     tclass=tcp_socket permissive=0

# Raw audit log:
ausearch -m AVC,USER_AVC -ts recent | audit2allow

# Generate policy to allow a denial:
audit2allow -a -M myhttpd    # creates myhttpd.pp module
semodule -i myhttpd.pp       # install the module

# Or interactively suggest what to add:
audit2allow -a
# allow httpd_t mysqld_port_t:tcp_socket name_connect;
```

## Boolean switches

Booleans allow tunable policy without recompiling:

```bash
# List all booleans:
getsebool -a | grep httpd | head -10
# httpd_can_network_connect --> off
# httpd_can_network_connect_db --> off
# httpd_can_send_mail --> off
# httpd_enable_cgi --> on

# Enable httpd → database connections:
setsebool -P httpd_can_network_connect_db on
# -P = persistent (survives reboot)

# Common web application booleans:
setsebool -P httpd_unified on          # allow httpd to read any httpd type
setsebool -P httpd_enable_homedirs on  # allow ~user/public_html
```

## SELinux modes

```bash
# Check current mode:
getenforce
# Enforcing

# Modes:
# Enforcing:  policy enforced, violations denied + audited
# Permissive: policy not enforced, but violations audited (AVC denials logged)
# Disabled:   SELinux completely off (requires reboot to re-enable)

# Temporarily switch to permissive (for debugging):
setenforce 0   # permissive
setenforce 1   # enforcing

# Per-domain permissive (process type runs permissive, others enforcing):
semanage permissive -a httpd_t   # httpd_t in permissive mode
semanage permissive -d httpd_t   # remove permissive
```

## selinuxfs: kernel interface

```bash
# SELinux exposes its interface via selinuxfs:
ls /sys/fs/selinux/
# access  avc  booleans  class  commit_pending_bools  context
# create  deny_unknown  disable  enforce  load  mls  null  policy
# policyvers  relabel  status  user

# Check SELinux is enabled:
cat /sys/fs/selinux/enforce
# 1 = enforcing

# Load a new policy:
cat /etc/selinux/targeted/policy/policy.33 > /sys/fs/selinux/load

# Check policy version:
cat /sys/fs/selinux/policyvers
# 33
```

## Kernel implementation

```c
/* security/selinux/hooks.c */

/* SELinux hooks into every security-sensitive VFS operation: */
static int selinux_inode_permission(struct inode *inode, int mask)
{
    const struct cred *cred = current_cred();
    u32 perms;
    int rc;

    /* Get security IDs for current process and target inode */
    u32 ssid = selinux_cred(cred)->sid;
    u32 tsid = selinux_inode(inode)->sid;
    u16 sclass = inode_mode_to_security_class(inode->i_mode);

    perms = file_mask_to_av(inode->i_mode, mask);

    /* AVC check: is ssid allowed perms on tsid:sclass? */
    rc = avc_has_perm(ssid, tsid, sclass, perms, &ad);
    return rc;  /* 0 = allowed, -EACCES = denied */
}
```

## Further reading

- [LSM Framework](lsm.md) — the security hook infrastructure SELinux uses
- [Capabilities](capabilities.md) — SELinux and capabilities interact
- [Linux Audit](audit.md) — SELinux denials go to audit log
- [Credentials](credentials.md) — process SIDs derived from credentials
- `security/selinux/` — SELinux implementation
- `man semanage, restorecon, audit2allow` — policy management tools
- Red Hat SELinux Guide — comprehensive policy writing documentation
