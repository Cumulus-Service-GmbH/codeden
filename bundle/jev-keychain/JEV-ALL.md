## jev-reader build-c fixes

Source references use paths relative to `bundle/jev-keychain/` at the confirming heads. Rows 5 and 6 refer to `98fef02e`, and rows 9 and 10 refer to `d65ad88fe`. The fixture column uses candidate paths.

| ID | Source | Correction or review evidence | Fixture |
|---|---|---|---|
| 5.R1 | `hooks/codeden-guard-secrets.mjs:15,42` | Recognize extended patterns and conservatively check their possible path matches. | `hooks/jev-paths.test.mjs:30–31` |
| 5.R2 | `hooks/codeden-guard-secrets.mjs:342–343` | Recognize an attached tar directory operand after clustered flags. | `hooks/jev-paths.test.mjs:32` |
| 5.R3 | `hooks/codeden-guard-secrets.mjs:328–330` | Expand the home reference on option operands before resolving the path. | `hooks/jev-paths.test.mjs:33` |
| 5.R4 | `hooks/codeden-guard-secrets.mjs:345–352` | Check the root ancestor and preserve wildcard traversal before resolving parent segments. | `hooks/jev-paths.test.mjs:34–35` |
| 5.R5 | `hooks/codeden-guard-secrets.mjs:31–32,348–352` | Apply bounded wildcard traversal to redirection targets independently from command metadata exceptions. | `hooks/jev-paths.test.mjs:36,44–46` |
| 5.R6 | `hooks/codeden-guard-secrets.mjs:16,328–330` | Exercise the home expansion and canonical ancestor paths on a synthetic home. | `hooks/jev-paths.test.mjs:33–35` |
| 5.R7 | `hooks/codeden-guard-secrets.mjs:1` | Provide the staged guard source and an isolated importable fixture to build-c. | `hooks/jev-paths.test.mjs:22–27` |
| 6.R1 | `hooks/codeden-guard-secrets.mjs:15` | Match extended shell patterns conservatively. | `hooks/jev-paths.test.mjs:30` |
| 6.R2 | `hooks/codeden-guard-secrets.mjs:33` | Check possible matches for brace sequences beyond the Node glob dialect. | `hooks/jev-paths.test.mjs:31` |
| 6.R3 | `hooks/codeden-guard-secrets.mjs:342–343` | Check the attached tar directory operand. | `hooks/jev-paths.test.mjs:32` |
| 6.R4 | `hooks/codeden-guard-secrets.mjs:328–330` | Check home-expanded directory operands. | `hooks/jev-paths.test.mjs:33` |
| 6.R5 | `hooks/codeden-guard-secrets.mjs:22,27,32,35,348–352` | Bound path traversal and check lexical and canonical ancestors, including root. | `hooks/jev-paths.test.mjs:34–35,46` |
| 6.R6 | `hooks/codeden-guard-secrets.mjs:334–335,348–352` | Keep benign directory predicates while checking redirection paths as file operands. | `hooks/jev-paths.test.mjs:36,44–45` |
| 9.R1 | `hooks/codeden-guard-secrets.mjs:233` | Resolve indirect operands and require the exact literal installed command or script path for trust. | `hooks/jev-paths.test.mjs:30–43` |
| 9.R2 | `jev-keychain-reader.c:11,33` | Compare the invocation, loader and kernel paths to the installed path. Reject linked or writable executable files. The JS preflight also rejects a symlinked parent. | `jev-keychain-reader.test.m:123–132`, `jev.test.mjs:21` |
| 9.R3 | `hooks/codeden-guard-secrets.mjs:24–26,645–646` | Verify the existing order-independent reader-reference check and narrow the trusted script exception. | `hooks/jev-paths.test.mjs:42–47` |
| 9.R4 | `INSTALL.md:4–5` | Include the full build and hardened signing instructions in the review scope. | `jev-keychain-reader.test.m:117` |
| 9.R5 | `jev-keychain-reader.c:37` | Verify that interaction is disabled before open and that presence supplies no value outputs. | `jev-keychain-reader.test.m:42–56,130–132` |
| 9.R6 | `hooks/codeden-guard-secrets.mjs:233–234` | Include the exact-path caller, guard and native lookup together in the review scope. | `hooks/jev-paths.test.mjs:37–47`, `jev-keychain-reader.test.m:123–132` |
| 10.R1 | `hooks/codeden-guard-secrets.mjs:287,645–646` | Verify the existing order-independent source check against the reader name after an unrelated assignment. | `hooks/jev-paths.test.mjs:47` |
| 10.R2 | `hooks/codeden-guard-secrets.mjs:233` | Check protected ancestor operands, including through a synthetic directory symlink. | `hooks/jev-paths.test.mjs:32–39` |
| 10.R3 | `INSTALL.md:4–5` | Include the hardened-runtime signing proof in the review scope. | `jev-keychain-reader.test.m:117` |
| 10.R4 | `jev-keychain-reader.c:33,37` | Include the exact-path caller and the metadata-only native interaction fixture in the review scope. | `jev.test.mjs:21`, `jev-keychain-reader.test.m:123–132` |

Disposition: Candidate fixes and evidence are pending build-c's shared cross-vendor review. Jev suspended (owner standing rule), receipt n/a.

The fixture run passed nine JavaScript tests and one hardened-signed native fixture. JavaScript dependencies absent from the staged overlay were stubbed for the fixture run. The assembled guard suite and owner install smoke were reserved for build-c and the owner.
