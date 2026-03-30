# IPC: Inter-Process Communication

> Mechanisms for processes to exchange data and coordinate

## IPC mechanisms overview

| Mechanism | Communication | Direction | Data size | Persistence |
|-----------|--------------|-----------|-----------|-------------|
| Signals | Event notification | One-way | Signal number only | Until delivered |
| Pipe (anonymous) | Byte stream | Unidirectional | Buffered (~64KB) | Until both ends close |
| FIFO (named pipe) | Byte stream | Unidirectional | Buffered | While file exists |
| Unix socket | Stream or datagram | Bidirectional | Flexible | While fd open |
| POSIX shared memory | Raw memory | Both | Arbitrary | Until shm_unlink |
| POSIX message queue | Typed messages | Both | max_msg_size | Until mq_unlink |
| eventfd | Counter + notification | Both | 8-byte counter | Until all fds closed |
| signalfd | Signal as fd | One-way | siginfo_t | While fd open |

## Pages in this section

| Page | What it covers |
|------|----------------|
| [Signals](signals.md) | Signal delivery, sigaction, masks, real-time signals |
| [Pipes and FIFOs](pipes.md) | Pipe internals, splice, vmsplice |
| [Shared Memory and Semaphores](shared-memory.md) | POSIX shm, SysV shm, semaphores, eventfd |
