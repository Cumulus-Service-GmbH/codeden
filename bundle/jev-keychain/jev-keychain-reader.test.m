#include <curl/curl.h>
#include <libproc.h>
#include <mach-o/dyld.h>
#include <pwd.h>
#include <stdarg.h>
#undef curl_easy_setopt
#undef curl_easy_getinfo
static CURLcode fixture_setopt(CURL *curl, CURLoption option, ...);
static CURLcode fixture_getinfo(CURL *curl, CURLINFO info, ...);
static CURLcode fixture_perform(CURL *curl);
static const char *fixture_executable;
static const char *fixture_loader_path;
static struct passwd fixture_owner;
static unsigned keychain_step;
static struct passwd *fixture_getpwuid(uid_t uid) {
    (void)uid;
    return &fixture_owner;
}
static int fixture_proc_path(int pid, void *buffer, uint32_t size) {
    (void)pid;
    return snprintf(buffer, size, "%s", fixture_executable);
}
static int fixture_loader(char *buffer, uint32_t *size) {
    return snprintf(buffer, *size, "%s", fixture_loader_path) < *size ? 0 : -1;
}
#define proc_pidpath fixture_proc_path
#define _NSGetExecutablePath fixture_loader
#define getpwuid fixture_getpwuid
#define curl_easy_setopt fixture_setopt
#define curl_easy_getinfo fixture_getinfo
#define curl_easy_perform fixture_perform
#define main transport_main
#define SecKeychainSetUserInteractionAllowed unexpected_interaction
#define SecKeychainOpen unexpected_open
#define SecKeychainFindGenericPassword unexpected_lookup
#include "jev-keychain-reader.m"
#undef main

OSStatus unexpected_interaction(Boolean enabled) {
    if (enabled || keychain_step++ != 1) abort();
    return errSecSuccess;
}

OSStatus unexpected_open(const char *path, SecKeychainRef *keychain) {
    if (!strstr(path, "/.jev-native.") || keychain_step++ != 2) abort();
    *keychain = (SecKeychainRef)CFRetain(kCFBooleanTrue);
    return errSecSuccess;
}

OSStatus unexpected_lookup(CFTypeRef keychain, UInt32 serviceSize, const char *service,
                           UInt32 accountSize, const char *account, UInt32 *length,
                           void **data, SecKeychainItemRef *item) {
    (void)keychain; (void)serviceSize; (void)service; (void)accountSize; (void)account;
    if (length || data || item || keychain_step++ != 3) abort();
    return errSecSuccess;
}

static curl_write_callback response_sink;
static void *response_context;
static unsigned configured;
static const char *response_body;
static long response_status;

static CURLcode fixture_setopt(CURL *curl, CURLoption option, ...) {
    (void)curl;
    va_list value;
    va_start(value, option);
    switch (option) {
        case CURLOPT_URL:
            if (strcmp(va_arg(value, const char *), "https://api.typesafe.ai/v1/systemone") != 0) abort();
            configured |= 1;
            break;
        case CURLOPT_FOLLOWLOCATION:
            if (va_arg(value, long) != 0) abort();
            configured |= 2;
            break;
        case CURLOPT_SSL_VERIFYPEER:
            if (va_arg(value, long) != 1) abort();
            configured |= 4;
            break;
        case CURLOPT_SSL_VERIFYHOST:
            if (va_arg(value, long) != 2) abort();
            configured |= 8;
            break;
        case CURLOPT_PROXY:
            if (*va_arg(value, const char *)) abort();
            configured |= 16;
            break;
        case CURLOPT_WRITEFUNCTION: response_sink = va_arg(value, curl_write_callback); break;
        case CURLOPT_WRITEDATA: response_context = va_arg(value, void *); break;
        default: break;
    }
    va_end(value);
    return CURLE_OK;
}

static CURLcode fixture_perform(CURL *curl) {
    (void)curl;
    if (configured != 31 || !response_sink || !response_context) abort();
    size_t length = strlen(response_body);
    return response_sink((char *)response_body, 1, length, response_context) == length
        ? CURLE_OK : CURLE_WRITE_ERROR;
}

static CURLcode fixture_getinfo(CURL *curl, CURLINFO info, ...) {
    (void)curl;
    if (info != CURLINFO_RESPONSE_CODE) abort();
    va_list value;
    va_start(value, info);
    *va_arg(value, long *) = response_status;
    va_end(value);
    return CURLE_OK;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (!hardened_reader()) return 1;
        char *removed_mode[] = { "aliased-fixture", "read", NULL };
        if (run_reader(2, removed_mode) != 3) return 2;
        char *copied_mode[] = { "copied-fixture", "ready", NULL };
        if (run_reader(2, copied_mode) != 3) return 9;
        if (argc != 3) return 10;
        fixture_loader_path = fixture_executable = argv[2];
        if (!installed_reader(argv[1], argv[2])) return 11;
        fixture_executable = "/fixture/copied-reader";
        if (installed_reader(argv[1], argv[2])) return 12;
        fixture_executable = argv[2];
        if (installed_reader(argv[1], "/fixture/alias")) return 13;
        fixture_owner.pw_dir = argv[1];
        keychain_step = 1;
        char *metadata_mode[] = { argv[2], "present", NULL };
        if (run_reader(2, metadata_mode) != 0 || keychain_step != 4) return 14;
        const char token[] = "fixture/opaque";
        NSData *fixture = [NSData dataWithBytes:token length:sizeof(token) - 1];
        if (safe_response([@"{\"answers\":{\"x\":\"fixture\\/opaque\"}}" dataUsingEncoding:NSUTF8StringEncoding], fixture)) return 3;
        if (safe_response([@"{\"fixture\\u002fopaque\":true}" dataUsingEncoding:NSUTF8StringEncoding], fixture)) return 4;
        if (!safe_response([@"{\"answers\":{}}" dataUsingEncoding:NSUTF8StringEncoding], fixture)) return 5;
        if (safe_response([@"not-json" dataUsingEncoding:NSUTF8StringEncoding], fixture)) return 6;
        response_status = 200;
        response_body = "{\"answers\":{\"x\":\"fixture\\/opaque\"}}";
        NSData *request = [@"{}" dataUsingEncoding:NSUTF8StringEncoding];
        if (post_request(request, fixture) != 65) return 7;
        response_status = 302;
        if (post_request(request, fixture) != 0) return 8;
        puts("9.R2: removed mode refused without contacting Security.framework; reflected fixture and redirect body suppressed");
        return 0;
    }
}
