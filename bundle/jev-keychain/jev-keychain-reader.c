#include <Security/Security.h>
#include <limits.h>
#include <pwd.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 2) return 3;
    const int read_value = strcmp(argv[1], "read") == 0;
    if (!read_value && strcmp(argv[1], "present") != 0) return 3;
    if (read_value) {
        struct stat output;
        if (fstat(STDOUT_FILENO, &output) || (!S_ISFIFO(output.st_mode) && !S_ISSOCK(output.st_mode))) return 3;
    }

    const struct passwd *owner = getpwuid(getuid());
    char path[PATH_MAX];
    if (!owner) return 3;
    const int size = snprintf(path, sizeof(path), "%s/Library/Keychains/login.keychain-db", owner->pw_dir);
    if (size < 0 || (size_t)size >= sizeof(path)) return 3;

    if (SecKeychainSetUserInteractionAllowed(false) != errSecSuccess) return 3;
    SecKeychainRef keychain = NULL;
    OSStatus status = SecKeychainOpen(path, &keychain);
    if (status != errSecSuccess || !keychain) return 3;

    const char service[] = "codeden", account[] = "typesafe.apiKey";
    UInt32 length = 0;
    void *data = NULL;
    status = SecKeychainFindGenericPassword(keychain, sizeof(service) - 1, service,
        sizeof(account) - 1, account, read_value ? &length : NULL, read_value ? &data : NULL, NULL);
    if (read_value && status == errSecSuccess) {
        if (!length || length > 8192 || fwrite(data, 1, length, stdout) != length || fflush(stdout)) status = errSecIO;
    }
    if (data) SecKeychainItemFreeContent(NULL, data);
    CFRelease(keychain);
    return status == errSecSuccess ? 0 : status == errSecItemNotFound ? 44 : 3;
}
