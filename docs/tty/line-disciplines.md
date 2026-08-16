# Line Disciplines, termios, and Pseudo-Terminals

> The interpreter that sits between a UART (or a pty) and a shell: turning raw bytes into edited lines, Ctrl-C into SIGINT, and background writes into SIGTTOU

## The problem: raw bytes are not what a shell wants to read

A serial port or a pty driver's only job is moving bytes: bytes arrive from the wire (or from the other half of a pty pair) and bytes go out. Nothing at that layer knows what a backspace means, whether Ctrl-C should kill the foreground program, or whether the process calling `read()` is even allowed to have this input right now because it's running in the background. If every terminal-using program had to reimplement line editing, signal generation, and job-control policy on top of raw device bytes, every shell and every `readline`-alike would duplicate the same few hundred lines of finicky code — and disagree on the details.

Linux's tty layer solves this by inserting a **line discipline** between the low-level driver and the reading/writing process. A line discipline is a pluggable protocol handler: the driver hands it raw bytes as they arrive, and it hands processed bytes to `read()` — and, going the other way, it can transform what a process `write()`s before handing it to the driver. The most heavily used one by a wide margin is **N_TTY**, the default discipline that implements ordinary interactive terminal behavior: canonical line editing, echo, and signal generation. This page is mostly about N_TTY, plus the two mechanisms that sit right next to it — `termios`, the structure a process uses to configure N_TTY's behavior, and job control, the process-group bookkeeping that decides who's allowed to read and write a given terminal at all. It closes with pseudo-terminals (ptys), the master/slave device pairs that make N_TTY and job control apply to network logins and terminal emulators, not just physical serial ports.

## Line disciplines: `struct tty_ldisc_ops`

A line discipline registers a `struct tty_ldisc_ops` (`include/linux/tty_ldisc.h`) with `tty_register_ldisc()`. The struct's own kernel-doc comment draws a line through the middle of the callback list: some hooks are called "from above" (the process doing `read()`/`write()`/`ioctl()` on the tty), others "from below" (the tty driver feeding in hardware-received bytes):

```c
// include/linux/tty_ldisc.h
struct tty_ldisc_ops {
	char	*name;
	int	num;

	/*
	 * The following routines are called from above.
	 */
	int	(*open)(struct tty_struct *tty);
	void	(*close)(struct tty_struct *tty);
	void	(*flush_buffer)(struct tty_struct *tty);
	ssize_t	(*read)(struct tty_struct *tty, struct file *file, u8 *buf,
			size_t nr, void **cookie, unsigned long offset);
	ssize_t	(*write)(struct tty_struct *tty, struct file *file,
			 const u8 *buf, size_t nr);
	int	(*ioctl)(struct tty_struct *tty, unsigned int cmd,
			unsigned long arg);
	int	(*compat_ioctl)(struct tty_struct *tty, unsigned int cmd,
			unsigned long arg);
	void	(*set_termios)(struct tty_struct *tty, const struct ktermios *old);
	__poll_t (*poll)(struct tty_struct *tty, struct file *file,
			     struct poll_table_struct *wait);
	void	(*hangup)(struct tty_struct *tty);

	/*
	 * The following routines are called from below.
	 */
	void	(*receive_buf)(struct tty_struct *tty, const u8 *cp,
			       const u8 *fp, size_t count);
	void	(*write_wakeup)(struct tty_struct *tty);
	void	(*dcd_change)(struct tty_struct *tty, bool active);
	size_t	(*receive_buf2)(struct tty_struct *tty, const u8 *cp,
				const u8 *fp, size_t count);
	void	(*lookahead_buf)(struct tty_struct *tty, const u8 *cp,
				 const u8 *fp, size_t count);

	struct  module *owner;
};
```

`read`/`write`/`ioctl`/`open`/`close` are the process-facing half: `read()` on a tty file descriptor ultimately calls the ldisc's `.read`, and `write()` calls `.write`. `receive_buf`/`receive_buf2` are the driver-facing half: whenever a UART's interrupt handler (or, for a pty, the other half of the pair) has new bytes, it calls into the current ldisc's `receive_buf`/`receive_buf2` rather than touching any read buffer directly. `.set_termios` is the notification hook fired after a `tcsetattr()`-driven termios change, so the ldisc can adjust internal state (N_TTY uses it to recompute derived flags like whether raw mode applies). `struct tty_ldisc` itself, the runtime object `tty->ldisc` points at, is just the ops pointer plus a back-reference to the owning tty:

```c
// include/linux/tty_ldisc.h
struct tty_ldisc {
	const struct tty_ldisc_ops *ops;
	struct tty_struct *tty;
};
```

N_TTY's registration shows which of these a real discipline actually fills in — no `.compat_ioctl`, no `.dcd_change` (that one's used exclusively by N_PPS), and `.lookahead_buf` pointed at a helper that scans for flow-control characters before the main receive path runs:

```c
// drivers/tty/n_tty.c
static struct tty_ldisc_ops n_tty_ops = {
	.owner		 = THIS_MODULE,
	.num		 = N_TTY,
	.name            = "n_tty",
	.open            = n_tty_open,
	.close           = n_tty_close,
	.flush_buffer    = n_tty_flush_buffer,
	.read            = n_tty_read,
	.write           = n_tty_write,
	.ioctl           = n_tty_ioctl,
	.set_termios     = n_tty_set_termios,
	.poll            = n_tty_poll,
	.receive_buf     = n_tty_receive_buf,
	.write_wakeup    = n_tty_write_wakeup,
	.receive_buf2	 = n_tty_receive_buf2,
	.lookahead_buf	 = n_tty_lookahead_flow_ctrl,
};
```

### It's not the only line discipline

`include/uapi/linux/tty.h` reserves 31 `N_*` numbers, and `ioctl(fd, TIOCSETD, &ldisc_num)` is how a process swaps a tty's discipline at runtime — that's exactly how old-school PPP and SLIP worked: a userspace daemon (`pppd`, `slattach`) opened a serial port as an ordinary tty, ran `TIOCSETD` to switch it from N_TTY to **N_PPP** or **N_SLIP**, and from that point every byte on the wire was framed PPP/SLIP traffic instead of terminal input — no more line editing, no more Ctrl-C, just a byte pipe with its own framing:

```c
// include/uapi/linux/tty.h
#define N_TTY		0
#define N_SLIP		1
#define N_MOUSE		2
#define N_PPP		3
...
#define N_HCI		15	/* Bluetooth HCI UART */
...
#define N_GSM0710	21	/* GSM 0710 Mux */
...
#define N_MCTP		28	/* MCTP-over-serial */
#define N_CAN327	30	/* ELM327 based OBD-II interfaces */
```

Most of the rest of that list is the same trick applied to other framed protocols riding on a UART: N_HCI decodes a Bluetooth controller's HCI packets, N_GSM0710 multiplexes a single serial port into multiple logical channels for a GSM modem, N_CAN327 talks to a cheap ELM327 OBD-II adapter. None of them are what a human types at — they're all "steal the tty's byte stream for a non-terminal protocol," and N_TTY is what's back in place the moment nothing more specialized has claimed the line. The rest of this page is entirely about N_TTY.

## Canonical vs. raw mode

N_TTY's most visible job is deciding how much editing happens before a `read()` returns data, and that's governed by a single bit: `ICANON` in `c_lflag`.

- **Canonical (cooked) mode** — `ICANON` set, the default. Input is buffered a line at a time. Before the line is handed to a reader, N_TTY performs editing in place: the erase character (default `DEL`/`Ctrl-?`) deletes the last character, the kill character (default `Ctrl-U`) erases the whole line back to the start, and (with `IEXTEN`) word-erase (`Ctrl-W`) deletes the last word. A `read()` in canonical mode doesn't return anything until a full line is available — terminated by newline, `EOF`, or an `EOL` character.
- **Raw (non-canonical) mode** — `ICANON` clear. No line buffering, no editing at all: bytes become available to `read()` essentially as they arrive (subject to the `VMIN`/`VTIME` timing controls below), untouched by any erase/kill logic. This is what full-screen programs — editors, pagers, `ssh` itself — put the terminal into, because they need to see every keystroke (including what would otherwise be an erase character) as data.

The editing logic for canonical mode lives in one function, `eraser()` in `drivers/tty/n_tty.c`, which switches on whether the triggering character is the erase, word-erase, or kill character:

```c
// drivers/tty/n_tty.c (eraser(), signature and dispatch)
static void eraser(u8 c, const struct tty_struct *tty)
{
	...
	enum { ERASE, WERASE, KILL } kill_type;
	...
	if (c == ERASE_CHAR(tty))
		kill_type = ERASE;
	else if (c == WERASE_CHAR(tty))
		kill_type = WERASE;
	...
}
```

`ERASE_CHAR(tty)` and friends are thin macros over `tty->termios.c_cc[]` — see below.

In non-canonical mode, two more `c_cc[]` slots change meaning entirely: `VMIN` and `VTIME` control how `read()` blocks. `VMIN` is the minimum number of bytes to satisfy a read; `VTIME` is a timeout in tenths of a second. The four combinations (both zero, only `VMIN`, only `VTIME`, both nonzero) give four distinct blocking behaviors, documented in full in `termios(3)`.

## `termios`: the configuration surface

Every open tty has a `struct ktermios` (`tty->termios`), and userspace reads/writes it via `tcgetattr(3)`/`tcsetattr(3)`, which are thin wrappers around the `TCGETS`/`TCSETS`-family ioctls. The kernel UAPI struct — `struct termios`, the one `tcgetattr()` actually fills — and the kernel-internal `struct ktermios` share the same field layout on modern Linux (`ktermios` additionally carries explicit `c_ispeed`/`c_ospeed` fields rather than packing speed into `c_cflag`):

```c
// include/uapi/asm-generic/termbits.h
#define NCCS 19
struct termios {
	tcflag_t c_iflag;		/* input mode flags */
	tcflag_t c_oflag;		/* output mode flags */
	tcflag_t c_cflag;		/* control mode flags */
	tcflag_t c_lflag;		/* local mode flags */
	cc_t c_line;			/* line discipline */
	cc_t c_cc[NCCS];		/* control characters */
};

struct ktermios {
	tcflag_t c_iflag;		/* input mode flags */
	tcflag_t c_oflag;		/* output mode flags */
	tcflag_t c_cflag;		/* control mode flags */
	tcflag_t c_lflag;		/* local mode flags */
	cc_t c_line;			/* line discipline */
	cc_t c_cc[NCCS];		/* control characters */
	speed_t c_ispeed;		/* input speed */
	speed_t c_ospeed;		/* output speed */
};
```

`c_line` is the ldisc number (one of the `N_*` values above) — the same field `TIOCSETD` reads and writes. The four flag words are independent bitmask namespaces, one per pipeline stage:

| Field | Governs | A few concrete flags |
|---|---|---|
| `c_iflag` | input processing, before the ldisc sees the byte as "line data" | `ICRNL` (map CR→NL on input), `IXON`/`IXOFF` (software flow control), `ISTRIP`, `BRKINT` |
| `c_oflag` | output processing, applied to what a process writes before it reaches the driver | `OPOST` (enable output processing at all — everything else in this word is a no-op if `OPOST` is clear), `ONLCR` (map NL→CR-NL on output) |
| `c_cflag` | the hardware line itself | `CS8` (8-bit character size, part of the `CSIZE` mask), `CREAD`, `PARENB`/`PARODD`, `CLOCAL`, baud-rate bits |
| `c_lflag` | "local" behavior — the ldisc-level policy knobs this page is mostly about | `ICANON`, `ISIG`, `ECHO`, `IEXTEN`, `TOSTOP` |

Confirmed straight from `include/uapi/asm-generic/termbits.h` and `include/uapi/asm-generic/termbits-common.h`, the bit values behind the flags most commonly referenced:

```c
// include/uapi/asm-generic/termbits-common.h
#define ICRNL	0x100			/* Map CR to NL on input */
#define OPOST	0x01			/* Perform output processing */

// include/uapi/asm-generic/termbits.h
#define CS8		0x00000030	/* part of the CSIZE mask */

/* c_lflag bits */
#define ISIG	0x00001
#define ICANON	0x00002
#define ECHO	0x00008
```

The `c_cc[]` array (`NCCS` = 19 slots) is where the special characters live — the bytes a process can rebind with `stty` or a direct `tcsetattr()` call. The array is indexed by symbolic constants, not fixed byte positions:

```c
// include/uapi/asm-generic/termbits.h
#define VINTR		 0
#define VQUIT		 1
#define VERASE		 2
#define VKILL		 3
#define VEOF		 4
#define VTIME		 5
#define VMIN		 6
#define VSWTC		 7
#define VSTART		 8
#define VSTOP		 9
#define VSUSP		10
#define VEOL		11
#define VREPRINT	12
#define VDISCARD	13
#define VWERASE		14
#define VLNEXT		15
#define VEOL2		16
```

`include/linux/tty.h` defines the macros the kernel itself uses to read these — `INTR_CHAR(tty)` expands to `tty->termios.c_cc[VINTR]`, and so on for every entry above. On Linux, `VMIN`/`VTIME` and `VEOF`/`VEOL` are four distinct, non-overlapping indices (4, 5, 6, 11, per the table above) — they only take on `VMIN`/`VTIME` *meaning* in non-canonical mode, but the slots themselves are never reused. (SPARC's `termbits.h` is a historical outlier that literally `#define`s `VMIN VEOF` and `VTIME VEOL`, inherited from older Unix layouts — that's a SPARC peculiarity, not a general Linux/glibc rule.)

## Signal generation: how Ctrl-C becomes SIGINT

When `ISIG` is set in `c_lflag` (the default), N_TTY watches every incoming byte for three special characters and turns each into a signal instead of passing it through as data. `n_tty_receive_char_special()` is where that dispatch happens, checked before any of the ordinary line-editing logic runs — though `n_tty_receive_char_special()` itself checks `I_IXON`-driven software flow control (`Ctrl-S`/`Ctrl-Q`) first, and only reaches the `ISIG` block below if that doesn't consume the byte:

```c
// drivers/tty/n_tty.c
if (L_ISIG(tty)) {
	if (c == INTR_CHAR(tty)) {
		n_tty_receive_signal_char(tty, SIGINT, c);
		return;
	} else if (c == QUIT_CHAR(tty)) {
		n_tty_receive_signal_char(tty, SIGQUIT, c);
		return;
	} else if (c == SUSP_CHAR(tty)) {
		n_tty_receive_signal_char(tty, SIGTSTP, c);
		return;
	}
}
```

Default bindings: `VINTR` is `Ctrl-C` → `SIGINT`, `VQUIT` is `Ctrl-\` → `SIGQUIT`, `VSUSP` is `Ctrl-Z` → `SIGTSTP`. Each of those goes through `isig()`, which resolves the process group to signal and, unless `NOFLSH` is set, flushes the ldisc's pending input/echo/output as part of delivering the signal (so a `SIGINT` doesn't leave stale typeahead sitting in the buffer for the next foreground program). The signal-delivery part — resolving `tty->ctrl.pgrp` and calling `kill_pgrp()` — is factored into an inner helper, `__isig()`, shown below; the `NOFLSH` check and the actual flush live in `isig()` itself, which calls `__isig()` first and then, unless `NOFLSH` is set, clears the echo/output/input buffers:

```c
// drivers/tty/n_tty.c
static void __isig(int sig, struct tty_struct *tty)
{
	struct pid *tty_pgrp = tty_get_pgrp(tty);
	if (tty_pgrp) {
		kill_pgrp(tty_pgrp, sig, 1);
		put_pid(tty_pgrp);
	}
}
```

`tty_get_pgrp()` returns a reference to `tty->ctrl.pgrp` — the tty's foreground process group, covered next — and `kill_pgrp()` delivers the signal to every process in that group, which is why Ctrl-C in a shell reaches the whole foreground pipeline (`sort | uniq | less`, say) and not just one process. This is entirely N_TTY's own logic — nothing about `ISIG` or signal generation lives in the generic tty core; a different line discipline is free to not do this at all (and PPP/SLIP-family disciplines don't, since `Ctrl-C` on a byte stream carrying framed network traffic would be nonsensical).

## Job control: who's allowed to read and write

`ISIG` explains how a foreground process gets signaled; job control is the layer above that decides *which* process group counts as foreground in the first place, and what happens to everyone else.

### `tty_struct`'s control fields

The relevant state lives in `struct tty_struct` under a small `ctrl` sub-struct, alongside its own spinlock:

```c
// include/linux/tty.h (struct tty_struct, ctrl fields)
struct {
	struct pid *pgrp;
	struct pid *session;
	spinlock_t lock;
	unsigned char pktstatus;
	bool packet;
} ctrl;
```

`ctrl.pgrp` is the terminal's current foreground process group; `ctrl.session` is the session this tty is the controlling terminal *for*. Both are `struct pid *`, not raw pids, and both are protected by `ctrl.lock` for writers (readers can get away with holding just one of `ctrl.lock` or the tty's broader `legacy_mutex`, per the struct's kernel-doc). `tty_get_pgrp(tty)` is the accessor `isig()` used above; `tty_jobctrl.c` has the corresponding setter path, `tiocspgrp()`, reached through the `TIOCSPGRP` ioctl.

### Becoming a controlling terminal

A tty becomes a session's controlling terminal one of two ways: implicitly, when a session leader with no controlling tty opens a tty device that doesn't already have a controlling session (handled in `tty_open_proc_set_tty()`, called from `tty_open()`); or explicitly, via the `TIOCSCTTY` ioctl, `tiocsctty()`:

```c
// drivers/tty/tty_jobctrl.c (tiocsctty(), core logic)
static int tiocsctty(struct tty_struct *tty, struct file *file, int arg)
{
	...
	/*
	 * The process must be a session leader and
	 * not have a controlling tty already.
	 */
	if (!current->signal->leader || current->signal->tty) {
		ret = -EPERM;
		goto unlock;
	}

	if (tty->ctrl.session) {
		/* already the controlling tty for another session group! */
		if (arg == 1 && capable(CAP_SYS_ADMIN)) {
			/* Steal it away */
			session_clear_tty(tty->ctrl.session);
		} else {
			ret = -EPERM;
			goto unlock;
		}
	}
	...
	proc_set_tty(tty);
	...
}
```

This is exactly the sequence `setsid()` + `open()` + `TIOCSCTTY` performs — it's the standard idiom terminal emulators, `sshd`, and `screen`/`tmux` all use when handing a freshly opened pty slave to a new session: `setsid()` first, to detach from any inherited controlling terminal and become a session leader with none, then open the slave and issue `TIOCSCTTY` to claim it. `proc_set_tty()` records the tty's new pgrp/session as the caller's current process group and session (via `task_pgrp(current)`/`task_session(current)`), and separately sets `current->signal->tty` — the process's own pointer back to its controlling terminal.

### SIGTTIN and SIGTTOU

Once a session has a controlling tty with a foreground `ctrl.pgrp`, any process in a *background* group that tries to `read()` from — or, depending on `TOSTOP`, `write()` to — that terminal gets stopped rather than allowed to proceed. The mechanism is `__tty_check_change()`, whose doc comment states the policy directly:

```c
// drivers/tty/tty_jobctrl.c
/**
 *	__tty_check_change	-	check for POSIX terminal changes
 *	@tty: tty to check
 *	@sig: signal to send
 *
 *	If we try to write to, or set the state of, a terminal and we're
 *	not in the foreground, send a SIGTTOU.  If the signal is blocked or
 *	ignored, go ahead and perform the operation.  (POSIX 7.2)
 */
int __tty_check_change(struct tty_struct *tty, int sig)
{
	...
	if (tty_pgrp && pgrp != tty_pgrp) {
		if (is_ignored(sig)) {
			if (sig == SIGTTIN)
				ret = -EIO;
		} else if (is_current_pgrp_orphaned())
			ret = -EIO;
		else {
			kill_pgrp(pgrp, sig, 1);
			set_thread_flag(TIF_SIGPENDING);
			ret = -ERESTARTSYS;
		}
	}
	...
}
```

Two call sites wire this into the read and write paths respectively. `job_control()` in `drivers/tty/n_tty.c` runs at the top of `n_tty_read()` and requests `SIGTTIN` if the caller isn't in the foreground group:

```c
// drivers/tty/n_tty.c
static int job_control(struct tty_struct *tty, struct file *file)
{
	/* Job control check -- must be done at start and after
	   every sleep (POSIX.1 7.1.1.4). */
	...
	/* don't stop on /dev/console */
	if (file->f_op->write_iter == redirected_tty_write)
		return 0;

	return __tty_check_change(tty, SIGTTIN);
}
```

and the exported `tty_check_change()` — always `SIGTTOU` — is what the write path and a handful of tty-state-changing ioctls (`TIOCSETD`, break-related ioctls, `TIOCSPGRP`) call before proceeding. The upshot: a background job's `read()` blocks its whole process group with `SIGTTIN` (which, by default, stops the group — that's what makes a backgrounded `cat` freeze instead of erroring out the moment it tries to read stdin), and — only if `TOSTOP` is set in `c_lflag` — the same happens to `write()` via `SIGTTOU`. Without `TOSTOP`, background writes are allowed through, which is the usual reason a backgrounded build's stray log lines can still interleave with your shell prompt.

## Pseudo-terminals: ptys

Everything above assumes a process is talking to a real terminal device. Almost nothing running today actually is — an SSH session, a terminal emulator window, `tmux`, `expect` scripts, and container runtimes' `-t` flag are all built on **pseudo-terminals**, where "the hardware" on one end is just another process.

### Master and slave, sharing one link

A pty is a *pair* of `tty_struct`s that reference each other directly through the `link` field already visible in `struct tty_struct` above (`struct tty_struct *link;` — "link to another pty (master → slave and vice versa)"). `pty_common_install()` in `drivers/tty/pty.c` is where that pairing is actually built, on first open of the master:

```c
// drivers/tty/pty.c (pty_common_install(), abridged)
static int pty_common_install(struct tty_driver *driver, struct tty_struct *tty,
		bool legacy)
{
	struct tty_struct *o_tty;
	...
	o_tty = alloc_tty_struct(driver->other, idx);
	...
	/* Establish the links in both directions */
	tty->link   = o_tty;
	o_tty->link = tty;
	tty_port_init(ports[0]);
	tty_port_init(ports[1]);
	...
	o_tty->port = ports[0];
	tty->port = ports[1];
	...
}
```

Two `tty_struct`s, two `tty_port`s, one `link` pointer each way. Data written to one side doesn't go to any driver hardware — `pty_write()` just stuffs the bytes straight into the other side's input buffer:

```c
// drivers/tty/pty.c
static ssize_t pty_write(struct tty_struct *tty, const u8 *buf, size_t c)
{
	struct tty_struct *to = tty->link;

	if (tty->flow.stopped || !c)
		return 0;

	return tty_insert_flip_string_and_push_buffer(to->port, buf, c);
}
```

The slave side runs a normal line discipline (N_TTY by default) exactly as if it were a physical terminal — canonical editing, `ISIG`, job control, all of it apply unchanged. The master side is what the *other* program — the terminal emulator, `sshd`, `tmux`'s server — reads and writes; it has no line discipline processing of its own to speak of, because from the master's point of view it's just piping bytes to and from whatever the slave's ldisc produces.

This is also where signal delivery for a pty gets an extra path: `TIOCSIG`, an ioctl only the master can issue, lets the controlling process on the master side inject `SIGINT`/`SIGQUIT`/`SIGTSTP` directly into the slave's foreground group without going through the ldisc's character-matching at all — useful for a terminal emulator or `sshd` that receives a signal request out-of-band (an SSH `~C`-style escape, or a GUI "send break" action) rather than as literal bytes in the stream:

```c
// drivers/tty/pty.c
static int pty_signal(struct tty_struct *tty, int sig)
{
	struct pid *pgrp;

	if (sig != SIGINT && sig != SIGQUIT && sig != SIGTSTP)
		return -EINVAL;

	if (tty->link) {
		pgrp = tty_get_pgrp(tty->link);
		if (pgrp)
			kill_pgrp(pgrp, sig, 1);
		put_pid(pgrp);
	}
	return 0;
}
```

### `/dev/ptmx` and `/dev/pts/N`: the Unix98 interface

The interface every modern program uses is the Unix98 pty model: a single multiplexing device, `/dev/ptmx`, plus a `devpts` virtual filesystem that exposes each allocated slave as `/dev/pts/N`. Opening `/dev/ptmx` (`ptmx_open()` in `drivers/tty/pty.c`) allocates a fresh master/slave pair, picks an unused index via `devpts_new_index()`, and creates the matching `/dev/pts/N` entry through `devpts_pty_new()` — no pre-existing device node to search for, unlike the legacy BSD-style `/dev/ptyXX`/`/dev/ttyXX` pairs this replaced.

From userspace, the canonical sequence is four calls, and glibc's `openpty()` is a convenience wrapper that does all four for you:

1. **`posix_openpt(O_RDWR | O_NOCTTY)`** — opens `/dev/ptmx`, returning a master file descriptor.
2. **`grantpt(fd)`** — fixes up ownership/permissions on the corresponding slave device (traditionally by running a setuid helper; on Linux this is largely handled by `devpts` mount options like `ptmxmode`/`gid=tty` instead).
3. **`unlockpt(fd)`** — clears the pty's lock flag (`TIOCSPTLCK`) so the slave can actually be opened; every new pty starts locked (`ptmx_open()` sets `TTY_PTY_LOCK` unconditionally on the *master*'s flags — `tty` in `ptmx_open()` is the master, from `tty = tty_init_dev(ptm_driver, index)` — via `set_bit(TTY_PTY_LOCK, &tty->flags); /* LOCK THE SLAVE */`; the comment describes the practical effect, since `pty_open()`, the slave-open path, checks the bit through `tty->link->flags`).
4. **`ptsname(fd)`** (or the race-free in-kernel `TIOCGPTPEER`/`ptm_open_peer()` path) — resolves the `/dev/pts/N` path, or a direct fd, for the slave.

Once unlocked, opening the returned slave path gives an ordinary tty file descriptor with N_TTY running on it. From there, the process that opened the slave typically `setsid()`s and issues `TIOCSCTTY` on it — which is exactly how every terminal emulator (`xterm`, a GUI terminal, `tmux`) and every `sshd` session sets up its child shell: the shell's controlling terminal is a pty *slave*, and the emulator or `sshd` process holds the *master* end, translating between "what the user's mouse/keyboard/network socket produces" and "what a real terminal would have sent."

## Diagrams

Keystroke to foreground `read()`, on a real serial line:

```
 keyboard keystroke
        │
        ▼
 UART hardware / interrupt handler
        │  driver calls tty_insert_flip_char() + tty_flip_buffer_push()
        ▼
 tty_struct->ldisc  (N_TTY, the default)
        │
        │  .receive_buf() / .receive_buf2()
        ▼
 n_tty_receive_buf() → n_tty_receive_char_special() / n_tty_receive_char()
        │
        ├─ ISIG match (Ctrl-C/Ctrl-\/Ctrl-Z) ──► isig() ──► kill_pgrp(tty->ctrl.pgrp, SIG*)
        │                                                    delivered to every process in
        │                                                    the terminal's foreground group
        │
        ├─ ICANON editing (erase/kill/werase via eraser())
        │
        ├─ ECHO (echo_char(), if L_ECHO(tty))
        │
        ▼
 read buffer (struct n_tty_data.read_buf)
        │
        │  process calls read(fd, ...)
        ▼
 job_control(): __tty_check_change(tty, SIGTTIN)
   - caller in tty->ctrl.pgrp?  → proceed, n_tty_read() returns data
   - caller in a background pgrp? → SIGTTIN to that pgrp, read() blocks/restarts
```

Pty master/slave pair, terminal emulator + shell:

```
 ┌───────────────────────┐                    ┌───────────────────────┐
 │   Terminal emulator     │                    │   Shell (bash, etc.)   │
 │   (or sshd)             │                    │                       │
 │   holds the MASTER fd   │                    │   controlling terminal │
 └───────────┬─────────────┘                    │   is the SLAVE         │
             │                                  └───────────┬─────────────┘
             │ open("/dev/ptmx")                            │ open("/dev/pts/N")
             ▼                                               ▼
   ┌─────────────────────┐   tty->link  /  o_tty->link  ┌─────────────────────┐
   │  master tty_struct    │◄────────────────────────────►│  slave tty_struct     │
   │  (no ldisc processing;│                              │  ldisc = N_TTY         │
   │   pty_write() just     │   pty_write(): bytes written  │  (canonical editing,   │
   │   pushes bytes to      │   on one side land straight   │   ISIG, job control    │
   │   the other side's     │   in the other side's flip    │   all apply here)      │
   │   flip buffer)          │   buffer, no wire involved    │                        │
   └─────────────────────┘                              └─────────────────────┘
             ▲                                                     │
             │ user types in the emulator window /                 │ shell's stdin/stdout/
             │ bytes arrive over the SSH network connection        │ stderr are all fds on
             │                                                     │ the slave
             └─────────────── userspace I/O ──────────────────────┘
```

## Further reading

### Kernel source

- [`include/linux/tty.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/tty.h) — `struct tty_struct` (including `ctrl.pgrp`/`ctrl.session`), the `c_cc[]` accessor macros (`INTR_CHAR()`, `ERASE_CHAR()`, ...), the `L_*`/`I_*`/`O_*`/`C_*` flag-test macros
- [`include/linux/tty_ldisc.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/tty_ldisc.h) — `struct tty_ldisc_ops`, `struct tty_ldisc`
- [`include/uapi/linux/tty.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/tty.h) — the full `N_*` line discipline number list
- [`include/uapi/asm-generic/termbits.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/asm-generic/termbits.h), [`termbits-common.h`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/asm-generic/termbits-common.h) — `struct termios`/`struct ktermios`, `c_cc[]` `V*` indices, the `c_iflag`/`c_oflag`/`c_cflag`/`c_lflag` bit definitions
- [`drivers/tty/n_tty.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/tty/n_tty.c) — the N_TTY line discipline: `eraser()`, `isig()`, `n_tty_receive_char_special()`, `job_control()`
- [`drivers/tty/pty.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/tty/pty.c) — `pty_common_install()`, `pty_write()`, `pty_signal()`, `ptmx_open()`, the legacy-BSD vs. Unix98 driver setup
- [`drivers/tty/tty_jobctrl.c`](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/tty/tty_jobctrl.c) — `tiocsctty()`, `__tty_check_change()`, `tiocgpgrp()`/`tiocspgrp()`, `disassociate_ctty()`

### Man pages

- [`termios(3)`](https://man7.org/linux/man-pages/man3/termios.3.html) — the full `struct termios` field reference, every `c_cc[]` special character, canonical/non-canonical `VMIN`/`VTIME` semantics
- [`ioctl_tty(2)`](https://man7.org/linux/man-pages/man2/ioctl_tty.2.html) — the terminal/job-control ioctls (`TIOCSCTTY`, `TIOCGPGRP`/`TIOCSPGRP`, `TIOCGSID`, `TIOCSIG`); this page superseded the older `tty_ioctl(4)` name in the man-pages project
- [`pty(7)`](https://man7.org/linux/man-pages/man7/pty.7.html) — the master/slave model, `/dev/ptmx` + `/dev/pts/N`, `posix_openpt()`/`grantpt()`/`unlockpt()`, and the legacy BSD-style interface

### Related pages

- [TTY and Serial Subsystem](README.md) — the driver/`tty_struct`/`tty_port` layers this page's line discipline and job-control machinery sit on top of
- [Serial Drivers and UARTs](serial.md) — the hardware-facing side that feeds bytes into the line discipline this page describes
- [TTY/Serial War Stories](war-stories.md) — incidents from the line discipline, job control, and pty code covered here

### LWN articles

- [Containers, pseudo TTYs, and backward compatibility](https://lwn.net/Articles/688809/) — the legacy BSD `/dev/ptyXX`/`/dev/ttyXX` pty model versus the Unix98 `/dev/ptmx`+`devpts` replacement, and why the old singleton assumptions still cause trouble in containers
