# The TTY Subsystem: One Model for Every Terminal, Real or Virtual

> Linux still uses the decades-old teletypewriter model — a line discipline sitting between a low-level driver and userspace — to unify physical serial ports, pseudo-terminals, and the system console under one `tty_struct`/`tty_driver` object model

## Getting Started

Every terminal session — a physical serial console on an embedded board, an `ssh` login, a GUI terminal emulator window, even the kernel's own boot messages scrolling past — is, from the kernel's point of view, a **TTY**. The name is inherited from real hardware: a *teletypewriter*, an electromechanical device that printed characters sent to it and sent back whatever a human typed. Linux (like every Unix before it) still uses that decades-old model today as the shape for all character-oriented, line-buffered terminal I/O, even though almost nobody has plugged an actual teletype into a computer in this century. The kernel's own documentation puts it plainly: "Teletypewriter (TTY) layer takes care of all those serial devices. Including the virtual ones like pseudoterminal (PTY)."

`drivers/tty/` is also one of the oldest and, by the admission of the people who maintain it, one of the trickiest corners of the kernel. An LWN retrospective on a TTY regression opened with "there are dark areas of the kernel where only the bravest hackers dare to tread... arguably, no part of the kernel is darker and scarier than the serial terminal (TTY) code." That reputation is a useful piece of context for a page like this one: the object model below is stable and well-documented, but the code that implements it has accreted for decades and rewards caution.

### The problem the TTY subsystem solves

Three very different things all need to look like "a terminal" to userspace:

- **Physical serial ports** — a real RS-232 line behind a UART chip, still common on servers (for out-of-band management) and embedded boards.
- **Pseudo-terminals (ptys)** — a purely software master/slave pair with no hardware behind it at all. This is what *every* terminal emulator (xterm, GNOME Terminal, VS Code's integrated terminal), every `ssh` session, and every `screen`/`tmux` pane runs on.
- **The system console** — the device the kernel's own text output (boot messages, `printk()`, an interactive shell if you have one) is currently pointed at, which can itself be a physical serial line, a virtual console on the screen, or a pty.

Without a shared model, each of these would need its own reimplementation of things every terminal has to handle: turning a stream of raw bytes into editable lines (backspace deletes the last character), deciding whether input is buffered a line at a time or delivered byte-by-byte, echoing typed characters back to the user, generating a signal when the user presses an interrupt key, and negotiating window size. Linux's TTY layer, rooted at `drivers/tty/` with its data structures in `include/linux/tty.h`, `include/linux/tty_driver.h`, and `include/linux/tty_ldisc.h`, factors this into three layers so that only the bottom one — moving bytes to and from an actual UART, pty peer, or screen — has to be written per device family. Everything above that is shared.

### The three-layer stack

1. **The low-level driver.** This is the layer that actually moves bytes: a UART driver for real serial hardware (`drivers/tty/serial/`), the pty master/slave implementation (`drivers/tty/pty.c`), or the virtual-console/framebuffer console driver (`drivers/tty/vt/`) for the screen. Each of these registers a `struct tty_driver` and implements a `struct tty_operations` — the vtable the tty core calls into for `open()`, `write()`, `ioctl()`, and so on.
2. **The line discipline.** Sitting between the driver and the character-device interface userspace sees, a line discipline (`struct tty_ldisc_ops`) interprets the raw byte stream. The default, and the one almost every interactive terminal uses, is **N_TTY** (`N_TTY` is `0`, defined in `include/uapi/linux/tty.h`) — it implements canonical ("cooked") vs. raw mode, character echo, and signal generation from control characters, most famously turning Ctrl-C into `SIGINT`. Every newly opened tty gets N_TTY automatically: `tty_ldisc_init()` in `drivers/tty/tty_ldisc.c` calls `tty_ldisc_get(tty, N_TTY)` unconditionally, and it's also the fallback a tty reverts to if something goes wrong switching to another one. A process can swap in a different line discipline with the `TIOCSETD` ioctl — the kernel ships around two dozen others (`N_PPP`, `N_HDLC`, `N_SLIP`, `N_HCI` for Bluetooth UART, `N_GSM0710`, and more) that repurpose a serial line as a protocol framer rather than a human-facing terminal.
3. **`tty_struct` and `tty_driver`.** These are the core kernel objects that tie the other two together: `struct tty_driver` represents a driver family (e.g., "the serial driver" or "the pty slave driver"), and `struct tty_struct` represents one open tty instance, holding the pointer to its current line discipline (`ldisc`), its driver (`driver`, `ops`), its terminal settings (`termios`), and the rest of its live state.

### Core structures

**`struct tty_struct`** (`include/linux/tty.h`) is allocated per open tty and lives (reference-counted via an embedded `kref`) until the last reference drops. Key fields:

```c
struct tty_struct {
	struct kref kref;
	int index;
	struct device *dev;
	struct tty_driver *driver;
	struct tty_port *port;
	const struct tty_operations *ops;

	struct tty_ldisc *ldisc;
	struct ld_semaphore ldisc_sem;
	/* ... locking: atomic_write_lock, legacy_mutex, throttle_mutex,
	 *              termios_rwsem, winsize_mutex ... */

	struct ktermios termios, termios_locked;
	char name[64];
	unsigned long flags;
	int count;
	unsigned int receive_room;
	struct winsize winsize;

	struct {
		spinlock_t lock;
		bool stopped;
		bool tco_stopped;
	} flow;

	struct {
		struct pid *pgrp;
		struct pid *session;
		spinlock_t lock;
		unsigned char pktstatus;
		bool packet;
	} ctrl;

	/* ... hw_stopped, closing, flow_change ... */
	struct tty_struct *link;
	void *disc_data;
	void *driver_data;
	/* ... */
};
```

A few of these are worth calling out: `name` is built by `tty_line_name()` (e.g. `ttyS3`); `flags` is a bitmask of states like `TTY_THROTTLED`, `TTY_IO_ERROR`, `TTY_OTHER_CLOSED` (set on a pty whose other end has closed), and `TTY_HUPPED`; `receive_room` is how many bytes the current line discipline is willing to accept from the driver in one `receive_buf()` call, set by the ldisc's own `open()`; `ctrl.pgrp`/`ctrl.session` are the process group and session that make this the *controlling* terminal for job control (`setpgrp(2)`, `setsid(2)`); and `link` connects a pty's two `tty_struct`s (master and slave) to each other.

**`struct tty_driver`** (`include/linux/tty_driver.h`) represents a driver, not an individual open tty:

```c
struct tty_driver {
	struct kref kref;
	struct cdev **cdevs;
	struct module *owner;
	const char *driver_name;
	const char *name;
	int name_base;
	int major;
	int minor_start;
	unsigned int num;
	enum tty_driver_type type;
	enum tty_driver_subtype subtype;
	struct ktermios init_termios;
	unsigned long flags;
	/* ... proc_entry, other, flip_wq ... */

	struct tty_struct **ttys;
	struct tty_port **ports;
	struct ktermios **termios;
	void *driver_state;

	const struct tty_operations *ops;
	/* ... */
};
```

`name` is what's used to build the `/dev` node (`"ttyS"`, `"pty"`, `"pts"`); `type`/`subtype` (`enum tty_driver_type`: `TTY_DRIVER_TYPE_SYSTEM`, `_CONSOLE`, `_SERIAL`, `_PTY`, `_SCC`, `_SYSCONS`) tell the core roughly what kind of driver this is; and `ttys`/`ports`/`termios` are the per-line arrays the standard `tty_standard_install()` path uses to look up an existing tty by minor number. A driver is set up with `tty_alloc_driver()`, has `ops` attached via `tty_set_operations()`, and goes live with `tty_register_driver()`.

**`struct tty_operations`** (also `tty_driver.h`) is the vtable connecting the tty core to a specific driver. The kernel doc comment marks both `open()` and `close()` "Required method"; in practice only `open()`'s absence is enforced at runtime (the doc comment: "if this routine is not filled in, the attempted open will fail with `ENODEV`"). The rest are optional but most drivers implement the load-bearing ones: `write()`/`write_room()`/`chars_in_buffer()` for output, `set_termios()` to react to changed terminal settings, `throttle()`/`unthrottle()` and `stop()`/`start()` for flow control, `hangup()`, `ioctl()`, `break_ctl()` for sending a BREAK, and `install()`/`lookup()`/`remove()` for drivers (like the pty and console drivers) that don't use the standard `ttys[]` array lookup.

**`struct tty_ldisc_ops`** (`include/linux/tty_ldisc.h`) is the line discipline's vtable, and the kernel doc comment splits its hooks into two directions: hooks marked `[TTY]` are called from the tty core downward — `open()`, `close()`, `read()`, `write()`, `ioctl()`, `set_termios()`, `poll()`, `hangup()` — and hooks marked `[DRV]` are called from the low-level driver upward, feeding received data in: `receive_buf()` and its newer variant `receive_buf2()` (preferred when present, since it can report back how many bytes it consumed for automatic flow control), `write_wakeup()` (the driver has room for more output), `dcd_change()` (used by the `N_PPS` Pulse-Per-Second discipline), and `lookahead_buf()` (a fast path for characters — like software flow-control bytes — that need handling before the regular `receive_buf()` call gets to them). N_TTY's implementation of `receive_buf()`/`receive_buf2()` is where canonical-mode line editing, echo, and `ISIG` signal generation actually happen: when the input flag `ISIG` is set and the incoming character matches `INTR_CHAR(tty)` (the terminal's configured interrupt character, normally Ctrl-C), `drivers/tty/n_tty.c` calls `n_tty_receive_signal_char(tty, SIGINT, c)` to raise `SIGINT` on the tty's foreground process group.

### The console: printk, boot messages, and the tty layer

The kernel's own text output — early boot messages, `printk()`, everything you see on a serial console or the screen before and often after a shell starts — goes through a related but distinct mechanism: `struct console` (`include/linux/console.h`), registered console drivers, flags like `CON_BOOT` (an early console, replaced once the real one registers) and `CON_PRINTBUFFER` (replay buffered messages so nothing is lost during the handoff). This isn't the tty core itself, but the two are deliberately linked: `struct console` has a `device` callback,

```c
struct tty_driver *(*device)(struct console *co, int *index);
```

whose job is to say which `tty_driver` backs a given console. This is exactly the mechanism `/dev/console` uses when it's opened: `tty_lookup_driver()` in `drivers/tty/tty_io.c` calls `console_device()` to find the `tty_driver` currently registered as the system console, then opens a tty through it like any other. The virtual-console driver that drives the text screen (`drivers/tty/vt/`, backing `/dev/tty1`–`/dev/tty63` and the currently-active-VT alias `/dev/tty0`) is itself an ordinary `struct tty_driver` with `type == TTY_DRIVER_TYPE_CONSOLE`; a headless system with a serial console instead points the same `device` callback at whichever `tty_driver` backs that serial port. The `struct console`/printk-routing side of this (the NBCON non-blocking console rework, multiple simultaneous console drivers, etc.) is its own subsystem and out of scope for this page — the point here is just that "the console" is, underneath, one more consumer of the same `tty_driver`/`tty_struct` model everything else uses.

### Device node naming

- **`/dev/ttyS0`, `/dev/ttyS1`, ...** — real serial ports, one per UART line a driver enumerates (the 8250/16550-family driver under `drivers/tty/serial/8250/`, for the most common case). The `ttyS(4)` man page puts it simply: "ttyS[0-3] are character devices for the serial terminal lines."
- **`/dev/pts/N`** — UNIX 98 pseudo-terminal slaves. Userspace opens `/dev/ptmx`, a clone device handled by `ptmx_open()` in `drivers/tty/pty.c`, to allocate a fresh pty master; the `devpts` filesystem then creates the matching `/dev/pts/N` slave node. Every terminal emulator, every `ssh` session, and every `tmux`/`screen` pane is one of these pairs. On the kernel side this is two separate `struct tty_driver`s — `ptm_driver` (`driver_name = "pty_master"`, `name = "ptm"`, master side) and `pts_driver` (`driver_name = "pty_slave"`, `name = "pts"`, slave side) — cross-linked through `tty_driver.other`; `ptmx_open()` allocates the master via `tty_init_dev(ptm_driver, index)`. This is distinct from the legacy BSD-style `pty_driver` (`name = "pty"`), set up separately by `legacy_pty_init()` under `CONFIG_LEGACY_PTYS`, which backs the old `/dev/ptyXX`/`/dev/ttyXX` pairs rather than `/dev/ptmx`.
- **`/dev/tty`** — not a distinct device family but a fixed alias, minor `MKDEV(TTYAUX_MAJOR, 0)` (`TTYAUX_MAJOR` is `5`, per the `tty(4)` man page: "a character file with major number 5 and minor number 0... a synonym for the controlling terminal of a process, if any"). Opening it calls `tty_open_current_tty()`, which looks up the calling process's controlling tty via `get_current_tty()` and reopens that.
- **`/dev/console`** — the system console alias, minor `MKDEV(TTYAUX_MAJOR, 1)`, resolved the same way via `console_device()` as described above — it can point at a serial port, a virtual console, or (less commonly) a pty, depending on how the system was booted (`console=` kernel parameter) and what's currently registered.

### Architecture: from hardware to userspace

```
  Hardware / peer object
  UART chip (8250/16550, ...)   pty peer (other half     VT/fbcon screen, or a
                                 of the master/slave       serial line acting as
                                 pair)                     the system console
          │                             │                            │
          ▼                             ▼                            ▼
  drivers/tty/serial/*          drivers/tty/pty.c            drivers/tty/vt/*
  struct tty_driver "ttyS"      tty_driver "ptm"/"pts"       console_driver
  + struct tty_operations       + struct tty_operations      + struct tty_operations
          │                             │                            │
          └─────────────────────────────┼────────────────────────────┘
                                         ▼
                 Line discipline: struct tty_ldisc_ops
                 N_TTY (default) — canonical/raw mode, echo,
                 signal generation (INTR_CHAR -> SIGINT), ...
                 swappable per-tty via TIOCSETD (N_PPP, N_HDLC, N_SLIP, ...)
                                         │
                                         ▼
                              struct tty_struct
                ldisc, termios, ops, driver, port, receive_room,
                flow{stopped}, ctrl{pgrp,session}, link (pty pairing)
                                         │
                                         ▼
            character device: open()/read()/write()/ioctl()/poll()
                                         │
          ┌──────────────────────────────┼──────────────────────────────┐
          ▼                              ▼                              ▼
    /dev/ttyS0                     /dev/pts/N                    /dev/tty1..ttyN
    real serial hw                 ptmx-cloned pty; every         virtual consoles
                                    terminal emulator/SSH          (VT layer)
                                    session runs on one

  Two more names are resolved at open() time to whichever tty above is
  currently appropriate, rather than being separate device families:

    /dev/tty      -> the calling process's controlling terminal
                     (tty_open_current_tty(), MKDEV(TTYAUX_MAJOR, 0))
    /dev/console  -> whichever tty_driver is the registered system console
                     (console_device(), MKDEV(TTYAUX_MAJOR, 1))
```

### The rest of this section

- **[Serial: the UART Driver and tty_port](serial.md)** — how a real UART chip driver plugs into `tty_driver`/`tty_port`, and the low-level serial ioctls.
- **[Line Disciplines: N_TTY and Beyond](line-disciplines.md)** — canonical vs. raw mode, `termios`, and the non-N_TTY line disciplines in detail.
- **[War Stories](war-stories.md)** — real incidents from the TTY/serial subsystem.

### Prerequisites and neighbors

Every `/dev/tty*`, `/dev/pts/*`, and `/dev/ttyS*` node is an ordinary [character device](../drivers/chardev.md) underneath, registered through the same `cdev`/`file_operations` machinery as any other driver — the tty layer's `struct tty_operations` sits one level above that as a terminal-specific vtable. Serial and console drivers are ordinary [Linux device-model](../drivers/device-model.md) citizens (platform devices for on-SoC UARTs, PCI devices for add-in serial cards). Reading order: this page, then [Serial](serial.md) if you're working with real UART hardware, or [Line Disciplines](line-disciplines.md) if you want the N_TTY internals.

## Further reading

### Kernel source

- [include/linux/tty.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/tty.h) — `struct tty_struct`, the `TTY_*` flag bits, and the termios accessor macros
- [include/linux/tty_driver.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/tty_driver.h) — `struct tty_driver`, `struct tty_operations`, `tty_alloc_driver()`/`tty_register_driver()`
- [include/linux/tty_ldisc.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/tty_ldisc.h) — `struct tty_ldisc_ops`, `struct tty_ldisc`, `tty_register_ldisc()`/`tty_set_ldisc()`
- [include/uapi/linux/tty.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/uapi/linux/tty.h) — the `N_*` line discipline numbers (`N_TTY`, `N_PPP`, `N_HDLC`, ...)
- [include/linux/console.h](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/include/linux/console.h) — `struct console`, `CON_BOOT`/`CON_PRINTBUFFER`, the `device` callback linking a console to its `tty_driver`
- [drivers/tty/tty_io.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/tty/tty_io.c) — the tty core: `tty_open()`, `tty_lookup_driver()`, `/dev/tty` and `/dev/console` handling
- [drivers/tty/tty_ldisc.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/tty/tty_ldisc.c) — line discipline attach/detach/reinit, the N_TTY fallback logic
- [drivers/tty/n_tty.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/tty/n_tty.c) — the default N_TTY line discipline: canonical mode, echo, signal generation
- [drivers/tty/pty.c](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/drivers/tty/pty.c) — the pty master/slave drivers, `/dev/ptmx`, UNIX 98 pty allocation

### Man pages

- [`tty(4)`](https://man7.org/linux/man-pages/man4/tty.4.html) — `/dev/tty`, the controlling-terminal alias
- [`ttyS(4)`](https://man7.org/linux/man-pages/man4/ttyS.4.html) — the serial terminal line devices
- [`pty(7)`](https://man7.org/linux/man-pages/man7/pty.7.html) — pseudoterminal master/slave pairs, UNIX 98 vs. BSD ptys, `/dev/ptmx` and `/dev/pts/*`
- [`termios(3)`](https://man7.org/linux/man-pages/man3/termios.3.html) — canonical vs. noncanonical mode, the `c_iflag`/`c_oflag`/`c_cflag`/`c_lflag` fields, and the `ISIG` special characters

### Related pages

- [Serial: the UART Driver and tty_port](serial.md) · [Line Disciplines: N_TTY and Beyond](line-disciplines.md) · [War Stories](war-stories.md) — the rest of this section
- [Character and Misc Devices](../drivers/chardev.md) · [Linux Device Model](../drivers/device-model.md) — the driver-core layers the TTY subsystem sits on

### LWN articles

- [A tempest in a tty pot](https://lwn.net/Articles/343828/) — on the TTY code's reputation for complexity, and the maintenance dispute that briefly left it without a maintainer

### External

- [Kernel docs: TTY driver-api index](https://docs.kernel.org/driver-api/tty/index.html) — the kernel's own overview of `tty_driver`, `tty_port`, `tty_struct`, line disciplines, and the console
- [Kernel docs: TTY Line Discipline](https://docs.kernel.org/driver-api/tty/tty_ldisc.html) — `tty_ldisc_ops`, the N_TTY default, and the N_NULL fallback when a discipline fails
- [Kernel docs: TTY Driver and TTY Operations](https://docs.kernel.org/driver-api/tty/tty_driver.html) — the full `tty_driver`/`tty_operations` reference
- [Kernel docs: Console](https://docs.kernel.org/driver-api/tty/console.html) — `struct console`, boot-to-runtime console handoff, and how a console maps to a `tty_driver`
