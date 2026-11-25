import Darwin
import Foundation
import Security

// Inspect a static bundle and its embedded signature. No identities or keychains are opened.
func signer(_ path: String) -> SecCertificate? {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess,
          let code else { return nil }
    let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode)
    guard SecStaticCodeCheckValidity(code, flags, nil) == errSecSuccess else { return nil }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
          let values = information as? [String: Any],
          let chain = values[kSecCodeInfoCertificates as String] as? [SecCertificate] else { return nil }
    return chain.first
}

if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--swap" {
    let result = renameatx_np(AT_FDCWD, CommandLine.arguments[2],
                              AT_FDCWD, CommandLine.arguments[3], UInt32(RENAME_SWAP))
    if result != 0 { perror("Bundle swap failed") }
    exit(result == 0 ? 0 : 1)
}

guard CommandLine.arguments.count == 2, let certificate = signer(CommandLine.arguments[1]) else {
    fputs("Bundle signature validation failed\n", stderr)
    exit(1)
}
FileHandle.standardOutput.write(SecCertificateCopyData(certificate) as Data)
