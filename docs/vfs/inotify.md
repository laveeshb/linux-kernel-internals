# inotify and fanotify

> Filesystem event notification: watching files and directories for changes

## inotify: file/directory watch API

`inotify` provides notifications when files or directories change. It's used by file managers, build systems, editors, and container runtimes.

```c
#include <sys/inotify.h>

/* 1. Create an inotify instance */
int ifd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);

/* 2. Add a watch */
int wd = inotify_add_watch(ifd, "/etc/nginx/nginx.conf",
                            IN_MODIFY | IN_CREATE | IN_DELETE);

/* 3. Read events */
char buf[4096] __attribute__((aligned(__alignof__(struct inotify_event))));
ssize_t n = read(ifd, buf, sizeof(buf));

char *ptr = buf;
while (ptr < buf + n) {
    struct inotify_event *ev = (struct inotify_event *)ptr;

    printf("wd=%d mask=%x cookie=%u name=%s\n",
           ev->wd, ev->mask, ev->cookie,
           ev->len ? ev->name : "");

    ptr += sizeof(*ev) + ev->len;
}

/* 4. Remove a watch */
inotify_rm_watch(ifd, wd);
close(ifd);
```

### Event masks

```c
/* Watch events (what to watch for) */
IN_ACCESS        /* File was read */
IN_MODIFY        /* File was modified */
IN_ATTRIB        /* Metadata changed (chmod, chown, timestamps) */
IN_CLOSE_WRITE   /* File opened for writing was closed */
IN_CLOSE_NOWRITE /* File opened read-only was closed */
IN_OPEN          /* File was opened */
IN_MOVED_FROM    /* File moved out of watched directory */
IN_MOVED_TO      /* File moved into watched directory */
IN_CREATE        /* File/directory created in watched directory */
IN_DELETE        /* File/directory deleted from watched directory */
IN_DELETE_SELF   /* Watched file/directory itself deleted */
IN_MOVE_SELF     /* Watched file/directory itself moved */

/* Convenience combinations */
IN_CLOSE    /* IN_CLOSE_WRITE | IN_CLOSE_NOWRITE */
IN_MOVE     /* IN_MOVED_FROM | IN_MOVED_TO */
IN_ALL_EVENTS /* All of the above */

/* Event flags returned in mask (not used in add_watch) */
IN_UNMOUNT   /* Filesystem containing watched object was unmounted */
IN_Q_OVERFLOW /* Event queue overflowed (wd = -1) */
IN_IGNORED   /* Watch was removed (inotify_rm_watch or file deleted) */
IN_ISDIR     /* Subject of this event is a directory */

/* Watch flags (inotify_add_watch flags parameter) */
IN_DONT_FOLLOW  /* Don't dereference symlinks */
IN_EXCL_UNLINK  /* Don't generate events for unlinked files */
IN_ONESHOT      /* Remove watch after first event */
IN_ONLYDIR      /* Only watch if path is a directory */
```

### Rename detection with cookie

`IN_MOVED_FROM` and `IN_MOVED_TO` events for the same rename share a `cookie` value:

```c
/* Detect rename: /src/old → /dst/new */
int wd_src = inotify_add_watch(ifd, "/src", IN_MOVE);
int wd_dst = inotify_add_watch(ifd, "/dst", IN_MOVE);

/* Read events */
/* Event 1: wd=wd_src, mask=IN_MOVED_FROM, cookie=42, name="old" */
/* Event 2: wd=wd_dst, mask=IN_MOVED_TO,   cookie=42, name="new" */

/* Match by cookie to reconstruct the rename */
```

If only one side is watched, you get an `IN_MOVED_FROM` or `IN_MOVED_TO` without the matching pair — detect cross-directory renames that way.

### inotify limits

```bash
# Maximum number of inotify instances per user
cat /proc/sys/fs/inotify/max_user_instances  # default: 128

# Maximum number of watches per instance
cat /proc/sys/fs/inotify/max_user_watches    # default: 8192

# Maximum queue length (events before IN_Q_OVERFLOW)
cat /proc/sys/fs/inotify/max_queued_events   # default: 16384

# Increase for large codebases (e.g., webpack, VS Code):
echo 524288 | sudo tee /proc/sys/fs/inotify/max_user_watches
```

### inotify limitations

- **Recursive watching**: inotify does not watch subdirectories automatically — you must add a watch for each directory
- **No event for the watcher itself**: if the watched directory is deleted, you get `IN_DELETE_SELF` but cannot watch the replacement
- **Network filesystems**: inotify may not work on NFS, CIFS (depends on server support)
- **Overflow loses events**: `IN_Q_OVERFLOW` tells you events were dropped but not which ones

## fanotify: filesystem-wide event notification

`fanotify` is a superset of inotify with additional capabilities:
- Watch entire mount points, not just individual files/dirs
- Receive the file descriptor of the changed file (open for reading)
- **Permission events**: intercept access and deny it (used by AV scanners)
- Watch for filesystem-wide changes (all files on a mount)

```c
#include <sys/fanotify.h>
#include <fcntl.h>

/* Create fanotify instance: requires CAP_SYS_ADMIN for some flags */
int fan = fanotify_init(FAN_CLOEXEC | FAN_CLASS_NOTIF,
                         O_RDONLY | O_LARGEFILE);

/* Watch an entire mount point */
fanotify_mark(fan, FAN_MARK_ADD | FAN_MARK_MOUNT,
              FAN_OPEN | FAN_CLOSE_WRITE | FAN_MODIFY,
              AT_FDCWD, "/home");

/* Read events */
struct fanotify_event_metadata buf[10];
ssize_t n = read(fan, buf, sizeof(buf));

for (struct fanotify_event_metadata *m = buf;
     FAN_EVENT_OK(m, n);
     m = FAN_EVENT_NEXT(m, n)) {

    if (m->fd == FAN_NOFD)
        continue;  /* overflow or error event */

    /* m->fd is a readable fd to the changed file */
    /* Read /proc/self/fd/N to get the path: */
    char path[PATH_MAX];
    char fdpath[64];
    snprintf(fdpath, sizeof(fdpath), "/proc/self/fd/%d", m->fd);
    readlink(fdpath, path, sizeof(path));

    printf("pid=%d fd=%d mask=%llx path=%s\n",
           m->pid, m->fd, m->mask, path);

    close(m->fd);  /* MUST close each event fd */
}
```

### fanotify permission events

```c
/* Permission events: intercept and allow/deny access */
int fan = fanotify_init(FAN_CLOEXEC | FAN_CLASS_CONTENT,
                         O_RDONLY | O_LARGEFILE);

fanotify_mark(fan, FAN_MARK_ADD | FAN_MARK_MOUNT,
              FAN_OPEN_PERM | FAN_ACCESS_PERM,
              AT_FDCWD, "/restricted");

/* Read a permission event */
struct fanotify_event_metadata ev;
read(fan, &ev, sizeof(ev));

/* Inspect the file (ev.fd is open for reading) */
/* ... check if access should be allowed ... */

/* Respond: allow or deny */
struct fanotify_response resp = {
    .fd       = ev.fd,
    .response = FAN_ALLOW,  /* or FAN_DENY */
};
write(fan, &resp, sizeof(resp));
close(ev.fd);
```

`FAN_CLASS_CONTENT` (for `FAN_OPEN_PERM` etc.) requires `CAP_SYS_ADMIN`. This is how antivirus software (like ClamAV's `clamonacc`) implements on-access scanning on Linux.

### fanotify mark types (5.1+)

```c
/* Mark an individual filesystem object (5.1+) */
fanotify_mark(fan, FAN_MARK_ADD | FAN_MARK_FILESYSTEM,
              FAN_CREATE | FAN_DELETE | FAN_RENAME,
              AT_FDCWD, "/");
/* Watches all creates/deletes/renames on entire filesystem */

/* FAN_RENAME event includes both source and dest info (5.17+) */
/* FAN_REPORT_FID: report file ID instead of fd (avoids fd leak) */
int fan = fanotify_init(FAN_CLASS_NOTIF | FAN_REPORT_FID, 0);
```

## Kernel implementation: fsnotify

Both `inotify` and `fanotify` are built on top of `fsnotify`, a generic filesystem notification framework:

```c
/* include/linux/fsnotify_backend.h */
struct fsnotify_group {
    /* One per inotify/fanotify instance */
    struct list_head        marks_list;
    const struct fsnotify_ops *ops;
    struct mutex            notification_mutex;
    struct list_head        notification_list; /* pending events */
    wait_queue_head_t       notification_waitq;
    atomic_t                num_marks;
    u32                     mask;  /* aggregated event mask */
};

struct fsnotify_mark {
    /* Attached to: inode, mount point, or filesystem */
    __u32 mask;
    union {
        struct inode    *inode;
        struct mount    *mnt;
        struct super_block *sb;
    };
    struct fsnotify_group *group;
};
```

When a VFS operation occurs (e.g., `vfs_write`):

```c
/* fs/notify/fsnotify.c */
int fsnotify(struct inode *inode, __u32 mask, const void *data, int data_type,
             const struct qstr *file_name, u32 cookie)
{
    /* Called from VFS hooks after each operation */

    /* Walk marks on this inode */
    hlist_for_each_entry(mark, &inode->i_fsnotify_marks, obj_list) {
        if (mark->mask & mask) {
            /* Deliver event to this group (inotify or fanotify) */
            mark->group->ops->handle_event(mark->group, mark, inode,
                                            mask, data, ...);
        }
    }
}

/* Called from: */
/* vfs_write → file_update_time → fsnotify(IN_MODIFY) */
/* vfs_unlink → fsnotify_unlink → fsnotify(IN_DELETE) */
/* security_inode_rename → fsnotify_rename */
```

### VFS hook points

```c
/* fs/attr.c */
int notify_change(struct dentry *dentry, ...)
{
    /* ... */
    fsnotify_change(dentry, ia_valid);  /* → IN_ATTRIB */
}

/* fs/namei.c */
int vfs_unlink(...)
{
    /* ... */
    fsnotify_unlink(dir, dentry);  /* → IN_DELETE */
}

int vfs_rename(...)
{
    /* ... */
    fsnotify_move(old_dir, new_dir, old_name, new_name, ...);
    /* → IN_MOVED_FROM + IN_MOVED_TO with shared cookie */
}
```

## Practical patterns

### Watch a directory recursively (userspace workaround)

```c
/* inotify has no recursive mode — must add watches manually */
void watch_recursive(int ifd, const char *path) {
    int wd = inotify_add_watch(ifd, path, IN_ALL_EVENTS);

    DIR *dir = opendir(path);
    struct dirent *de;
    while ((de = readdir(dir))) {
        if (de->d_type == DT_DIR && strcmp(de->d_name, ".") != 0
                                 && strcmp(de->d_name, "..") != 0) {
            char subpath[PATH_MAX];
            snprintf(subpath, sizeof(subpath), "%s/%s", path, de->d_name);
            watch_recursive(ifd, subpath);
        }
    }
    closedir(dir);
}

/* When IN_CREATE | IN_ISDIR arrives: add a new watch for the new subdir */
```

### Using epoll with inotify

```c
/* inotify fd integrates with epoll */
int epfd = epoll_create1(0);
struct epoll_event ev = {
    .events  = EPOLLIN,
    .data.fd = ifd,
};
epoll_ctl(epfd, EPOLL_CTL_ADD, ifd, &ev);

/* Event loop */
struct epoll_event evs[16];
int n = epoll_wait(epfd, evs, 16, -1);
for (int i = 0; i < n; i++) {
    if (evs[i].data.fd == ifd) {
        /* Read inotify events */
    }
}
```

## inotify vs fanotify

| Feature | inotify | fanotify |
|---------|---------|---------|
| Watch granularity | File or directory | File, mount, filesystem |
| Recursive | No (userspace workaround) | Yes (FAN_MARK_MOUNT) |
| Event fd for changed file | No | Yes |
| Permission events | No | Yes (FAN_CLASS_CONTENT) |
| Network filesystems | Limited | Better support |
| Privileges required | None | CAP_SYS_ADMIN for some |
| Rename tracking | Cookie-based | FAN_RENAME (5.17+) |
| Typical use | Build systems, editors | AV scanning, audit |

## Further reading

- [VFS Objects](vfs-objects.md) — inodes and dentries that receive events
- [File Operations](file-ops.md) — VFS hooks that trigger fsnotify
- [IPC: Signals](../ipc/signals.md) — `SIGEV_SIGNAL` delivery for fanotify
- `fs/notify/` — fsnotify, inotify, and fanotify implementation
- `include/linux/fsnotify.h` — fsnotify hook declarations
