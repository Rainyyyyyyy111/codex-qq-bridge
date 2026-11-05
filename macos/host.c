#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <unistd.h>

// The launcher changes cwd to the private profile before entering this process.
// Hold the lock through native shutdown, including abnormal termination.
int main(int argc, char **argv) {
    if (argc < 3 || strcmp(argv[2], "probe") != 0) {
        int lock = open("kernel.lock", O_CREAT | O_RDWR, 0600);
        if (lock < 0 || flock(lock, LOCK_EX | LOCK_NB) != 0) {
            fprintf(stderr, "QQ kernel already running or profile lock unavailable\n");
            return 3;
        }
    }
    const char *framework = "/Applications/QQ.app/Contents/Frameworks/QQNT.framework/QQNT";
    void *handle = dlopen(framework, RTLD_NOW | RTLD_GLOBAL);
    if (!handle) {
        fprintf(stderr, "Loading QQNT failed: %s\n", dlerror());
        return 1;
    }
    int (*start)(int, char **) = dlsym(handle, "ElectronInitializeICUandStartNode");
    if (!start) {
        fprintf(stderr, "QQNT Node entry point unavailable: %s\n", dlerror());
        return 2;
    }
    return start(argc, argv);
}
