#include <Security/Security.h>
#include <limits.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int check_home(void) {
    const struct passwd *account = getpwuid(getuid());
    const char *home = getenv("HOME");
    char env_path[PATH_MAX], account_path[PATH_MAX];
    return account && home && realpath(home, env_path) &&
        realpath(account->pw_dir, account_path) && strcmp(env_path, account_path) == 0;
}

int main(int argc, char **argv) {
    if (!check_home()) return 3;
    if (argc == 2 && strcmp(argv[1], "check-home") == 0) return 0;
    if (argc != 6) return 2;

    const char *op = argv[1], *path = argv[2], *testPassphrase = argv[3];
    const char *service = argv[4], *account = argv[5];
    if (strcmp(op, "get") && strcmp(op, "info") && strcmp(op, "set") && strcmp(op, "delete")) return 2;
    struct stat file;
    char actual[PATH_MAX];
    if (path[0] != '/' || lstat(path, &file) || !S_ISREG(file.st_mode) ||
        file.st_uid != getuid() || file.st_nlink != 1 || !realpath(path, actual) ||
        strcmp(path, actual) != 0 || strcmp(strrchr(actual, '/'), "/selftest.keychain-db") != 0) return 3;

    // Fail before opening any Keychain if Security.framework cannot disable prompts.
    if (SecKeychainSetUserInteractionAllowed(false) != errSecSuccess) return 3;
    SecKeychainRef keychain = NULL;
    OSStatus status = SecKeychainOpen(path, &keychain);
    if (status != errSecSuccess || !keychain) return 3;

    SecKeychainItemRef item = NULL;
    void *data = NULL;
    UInt32 length = 0;
    status = SecKeychainUnlock(keychain, (UInt32)strlen(testPassphrase), testPassphrase, true);
    if (status != errSecSuccess) goto done;

    const int read_value = strcmp(op, "get") == 0;
    status = SecKeychainFindGenericPassword(keychain, (UInt32)strlen(service), service,
        (UInt32)strlen(account), account, read_value ? &length : NULL, read_value ? &data : NULL, &item);
    if (strcmp(op, "set") == 0 && (status == errSecSuccess || status == errSecItemNotFound)) {
        char value[4096];
        size_t size = fread(value, 1, sizeof(value), stdin);
        if (ferror(stdin) || size == sizeof(value) || !size) status = errSecParam;
        else if (item) status = SecKeychainItemModifyAttributesAndData(item, NULL, (UInt32)size, value);
        else status = SecKeychainAddGenericPassword(keychain, (UInt32)strlen(service), service,
            (UInt32)strlen(account), account, (UInt32)size, value, NULL);
    } else if (status == errSecSuccess && strcmp(op, "delete") == 0) {
        status = item ? SecKeychainItemDelete(item) : errSecInternalComponent;
    } else if (status == errSecSuccess && read_value && length && fwrite(data, 1, length, stdout) != length) {
        status = errSecIO;
    }

done:
    if (data) SecKeychainItemFreeContent(NULL, data);
    if (item) CFRelease(item);
    CFRelease(keychain);
    return status == errSecSuccess ? 0 : status == errSecItemNotFound ? 44 : 3;
}
