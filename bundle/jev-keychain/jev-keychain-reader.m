#import <Foundation/Foundation.h>
#include <Security/Security.h>
#include <crt_externs.h>
#include <curl/curl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <pwd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static NSString *const endpoint = @"https://api.typesafe.ai/v1/systemone";
static const size_t response_limit = 1024 * 1024;

static BOOL hardened_reader(void) {
    SecCodeRef code = NULL;
    CFDictionaryRef signing = NULL;
    BOOL hardened = NO;
    if (SecCodeCopySelf(kSecCSDefaultFlags, &code) == errSecSuccess &&
        SecCodeCopySigningInformation(code, kSecCSSigningInformation, &signing) == errSecSuccess) {
        NSDictionary *info = (__bridge NSDictionary *)signing;
        NSNumber *flags = info[(__bridge NSString *)kSecCodeInfoFlags];
        NSDictionary *entitlements = info[(__bridge NSString *)kSecCodeInfoEntitlementsDict];
        hardened = (flags.unsignedIntValue & kSecCodeSignatureRuntime) != 0 && entitlements.count == 0;
    }
    if (signing) CFRelease(signing);
    if (code) CFRelease(code);
    return hardened;
}

static void wipe(void *data, size_t length) {
    volatile unsigned char *bytes = data;
    while (length--) *bytes++ = 0;
}

static BOOL valid_credential(const unsigned char *value, UInt32 length) {
    static const char allowed[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~+/=";
    if (!value || length == 0 || length > 8192) return NO;
    for (UInt32 i = 0; i < length; i++) {
        if (!value[i] || !strchr(allowed, value[i])) return NO;
    }
    return YES;
}

static NSData *safe_response(NSData *body, NSData *credential) {
    id json = [NSJSONSerialization JSONObjectWithData:body options:0 error:NULL];
    if (![json isKindOfClass:[NSDictionary class]]) return nil;
    NSData *normalized = [NSJSONSerialization dataWithJSONObject:json
        options:NSJSONWritingWithoutEscapingSlashes error:NULL];
    if (!normalized || normalized.length > response_limit ||
        [normalized rangeOfData:credential options:0 range:NSMakeRange(0, normalized.length)].location != NSNotFound) {
        return nil;
    }
    return normalized;
}

static size_t collect_response(char *data, size_t size, size_t count, void *context) {
    NSMutableData *body = (__bridge NSMutableData *)context;
    if (size && count > (response_limit - body.length) / size) return 0;
    size_t length = size * count;
    [body appendBytes:data length:length];
    return length;
}

static int post_request(NSData *request, NSData *credential) {
    CURL *curl = curl_easy_init();
    if (!curl) return 69;
    char auth[sizeof("Authorization: Bearer ") + 8192];
    snprintf(auth, sizeof(auth), "Authorization: Bearer %.*s", (int)credential.length, (const char *)credential.bytes);
    struct curl_slist *headers = curl_slist_append(NULL, "Content-Type: application/json");
    struct curl_slist *with_auth = headers ? curl_slist_append(headers, auth) : NULL;
    wipe(auth, sizeof(auth));
    NSMutableData *body = [NSMutableData data];
    long status = 0;
    BOOL ok = with_auth != NULL &&
        curl_easy_setopt(curl, CURLOPT_URL, endpoint.UTF8String) == CURLE_OK &&
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, with_auth) == CURLE_OK &&
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, request.bytes) == CURLE_OK &&
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)request.length) == CURLE_OK &&
        curl_easy_setopt(curl, CURLOPT_PROXY, "") == CURLE_OK &&
        curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L) == CURLE_OK &&
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L) == CURLE_OK &&
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L) == CURLE_OK &&
        curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L) == CURLE_OK &&
        curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 3000L) == CURLE_OK &&
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 20000L) == CURLE_OK &&
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, collect_response) == CURLE_OK &&
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, (__bridge void *)body) == CURLE_OK &&
        curl_easy_perform(curl) == CURLE_OK &&
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status) == CURLE_OK;
    curl_easy_cleanup(curl);
    for (struct curl_slist *header = with_auth; header; header = header->next) {
        wipe(header->data, strlen(header->data));
    }
    curl_slist_free_all(with_auth ? with_auth : headers);
    if (!ok || status < 100 || status > 599) return 69;

    NSData *response = nil;
    if (status >= 200 && status < 300) {
        response = safe_response(body, credential);
        if (!response) return 65;
    }
    if (printf("%ld\n", status) < 0) return 69;
    if (response && fwrite(response.bytes, 1, response.length, stdout) != response.length) return 69;
    return fflush(stdout) == 0 ? 0 : 69;
}

static NSData *request_body(void) {
    unsigned char buffer[128 * 1024];
    size_t length = fread(buffer, 1, sizeof(buffer), stdin);
    if (!length || length == sizeof(buffer) || ferror(stdin)) return nil;
    NSData *body = [NSData dataWithBytes:buffer length:length];
    id json = [NSJSONSerialization JSONObjectWithData:body options:0 error:NULL];
    if (![json isKindOfClass:[NSDictionary class]] || [json count] != 3 ||
        ![json[@"model"] isEqual:@"jev-latest"] ||
        ![json[@"state"] isKindOfClass:[NSDictionary class]] ||
        ![json[@"questions"] isKindOfClass:[NSDictionary class]]) return nil;
    return body;
}

static BOOL installed_reader(const char *home, const char *invocation) {
    char actual[PATH_MAX], expected[PATH_MAX];
    uint32_t length = sizeof(actual);
    int size = snprintf(expected, sizeof(expected),
        "%s/.config/trioharness/jev-keyring-runtime/bin/jev-keychain-reader", home);
    return size > 0 && (size_t)size < sizeof(expected) && strcmp(invocation, expected) == 0 &&
        _NSGetExecutablePath(actual, &length) == 0 && strcmp(actual, expected) == 0;
}

static int run_reader(int argc, char **argv) {
    if (argc != 2) return 3;
    BOOL present = strcmp(argv[1], "present") == 0;
    BOOL ready = strcmp(argv[1], "ready") == 0;
    BOOL request = strcmp(argv[1], "request") == 0;
    if ((!present && !ready && !request) || !hardened_reader()) return 3;

    static char *empty_environment[] = { NULL };
    *_NSGetEnviron() = empty_environment;
    NSData *body = request ? request_body() : nil;
    if (request && !body) return 65;
    const struct passwd *owner = getpwuid(getuid());
    char path[PATH_MAX];
    if (!owner || !installed_reader(owner->pw_dir, argv[0])) return 3;
    int size = snprintf(path, sizeof(path), "%s/Library/Keychains/login.keychain-db", owner->pw_dir);
    if (size < 0 || (size_t)size >= sizeof(path)) return 3;

    sigset_t deadline;
    if (sigemptyset(&deadline) || sigaddset(&deadline, SIGALRM) ||
        signal(SIGALRM, SIG_DFL) == SIG_ERR || sigprocmask(SIG_UNBLOCK, &deadline, NULL)) return 3;
    alarm(2);
    if (SecKeychainSetUserInteractionAllowed(false) != errSecSuccess) return 3;
    SecKeychainRef keychain = NULL;
    if (SecKeychainOpen(path, &keychain) != errSecSuccess || !keychain) return 3;
    const char service[] = "codeden", account[] = "typesafe.apiKey";
    UInt32 length = 0;
    void *data = NULL;
    OSStatus status = SecKeychainFindGenericPassword(keychain, sizeof(service) - 1, service,
        sizeof(account) - 1, account, present ? NULL : &length, present ? NULL : &data, NULL);
    CFRelease(keychain);
    alarm(0);
    int result = status == errSecItemNotFound ? 44 : 3;
    if (status == errSecSuccess && (present || valid_credential(data, length))) {
        NSData *credential = request ? [NSData dataWithBytesNoCopy:data length:length freeWhenDone:NO] : nil;
        result = request ? post_request(body, credential) : 0;
    }
    if (data) {
        wipe(data, length);
        SecKeychainItemFreeContent(NULL, data);
    }
    return result;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        return run_reader(argc, argv);
    }
}
