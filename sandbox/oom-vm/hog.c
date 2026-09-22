/* Allocates and touches N megabytes of memory, then holds it forever.
 * Simulates a real process competing for RAM inside the sandbox VM. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    int mb = argc > 1 ? atoi(argv[1]) : 10;
    size_t bytes = (size_t)mb * 1024 * 1024;

    char *buf = malloc(bytes);
    if (!buf) {
        fprintf(stderr, "allocation of %d MB failed\n", mb);
        return 1;
    }

    /* Touch every page individually so it's actually resident, not just
     * reserved virtual address space — a page-stride loop rather than
     * memset() so nothing about the write pattern is left to a library
     * implementation to decide. */
    size_t page = 4096;
    for (size_t off = 0; off < bytes; off += page) {
        buf[off] = 1;
    }
    buf[bytes - 1] = 1;

    printf("holding %d MB, pid=%d\n", mb, getpid());
    fflush(stdout);

    while (1) {
        sleep(3600);
    }
    return 0;
}
