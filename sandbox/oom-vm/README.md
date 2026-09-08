# OOM killer sandbox

Boots a real, minimal Linux kernel under QEMU with just enough memory that
spawning a handful of processes triggers the actual kernel OOM killer — and
streams the real kernel log the whole time, so you see the genuine
`Out of memory: Killed process ...` message, not a simulation of it.

This is the "prove it's real" companion to the
[in-browser OOM killer demo](../../docs/playground/oom-killer.md). That page
teaches the concept in your browser with no setup; this runs the real thing
in a disposable VM on your own machine.

## What it does

Everything here builds from source — the kernel, BusyBox, and a tiny
memory-allocating demo program (`hog.c`) — there's no prebuilt binary to
trust blindly. `run.sh` builds it once with Docker (reproducible, doesn't
touch your host beyond that), then boots the result directly with QEMU.

Inside the VM, `init` spawns a handful of processes (named `browser_tab`,
`video_call`, etc.) that each allocate an increasing amount of memory,
against a VM deliberately sized so the later ones don't fit. Once that
happens, the real kernel picks the biggest resident process and kills it —
which you'll see live in the console output, in the kernel's own words
(`Out of memory: Killed process ...`). The VM powers itself off a few
seconds after.

## Setup

Two tools are needed: **Docker**, used once to build the kernel and
initramfs from source, and **QEMU**, used every time to boot the VM.
Neither ever touches your host beyond that — Docker's job ends the moment
it produces the two output files under `build/`, and QEMU only ever creates
an isolated virtual machine with no access to your real filesystem,
network, or memory. Nothing here installs anything system-wide, modifies
your actual kernel, or persists beyond the `build/` directory in this repo.

### Linux

```sh
# Docker
sudo apt install docker.io          # Debian/Ubuntu
sudo dnf install docker             # Fedora
sudo pacman -S docker               # Arch
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"     # then log out and back in

# QEMU
sudo apt install qemu-system-x86    # Debian/Ubuntu
sudo dnf install qemu-system-x86    # Fedora
sudo pacman -S qemu-system-x86      # Arch
```

### macOS

```sh
brew install --cask docker   # Docker Desktop — or `brew install colima docker`
                              # for a lighter, CLI-only alternative
brew install qemu
```

Start Docker once before running `./run.sh` (open Docker Desktop, or
`colima start` if you used colima instead).

### Windows

The simplest path is inside WSL2, which Docker Desktop for Windows already
sets up for you:

1. Install [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/).
2. Open a WSL2 terminal (e.g. "Ubuntu" from the Start menu) and install QEMU
   the same way as the Linux instructions above: `sudo apt install qemu-system-x86`.
3. Run `./run.sh` from *inside that WSL2 terminal* — not PowerShell or cmd.

Everything then runs inside WSL2's own Linux environment. Your actual
Windows installation is never touched.

## Running it

```sh
./run.sh
```

First run builds the kernel and BusyBox from source, which can take several
minutes. Every run after that reuses the build output in `build/` and boots
in a few seconds — Docker isn't needed again unless you delete `build/` or
change the source.
