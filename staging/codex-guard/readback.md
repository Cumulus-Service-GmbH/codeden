# CodeDen value-safe readback

A Codex session, including an Investigator, can request `names` or one fixed
`equality issuer|environment|storageAccount` check from a Supervised Claude
CodeDen session with the existing `codeden-guard` Bash hook enabled. The request
carries only the mode and, for equality, the pair name. The Claude operator
follows the applicable owner authorization before reading production. The
guard's projection exception is a safety check and does not issue an approval
card.

The trusted source is the registered `erpureai-webchat` Container App.
App Service app-settings lists, secret-store reads, other targets, arbitrary
expected literals, and caller-supplied commands or queries are outside this
route. Codex execpolicy matches argument prefixes and accepts trailing arguments
after a match. The generated forbidden rules remain in force.

## Operator steps

1. Confirm that the installed guard supports these exact projections and that
   its owner-managed target registry has one location for the app. Substitute the
   registered resource group and subscription for `PINNED_GROUP` and
   `PINNED_SUBSCRIPTION`. The guard checks both tokens.
2. Run exactly one of the following as a standalone Bash tool command in that
   Claude session, without pipes, substitution, redirects, extra flags, or
   alternate queries. Use the first command for names and the second for any
   equality pair.

```sh
az containerapp show -n erpureai-webchat -g PINNED_GROUP --subscription PINNED_SUBSCRIPTION --query 'properties.template.containers[].env[].{name:name,set:!!(value||secretRef),on:value==`"true"`}' -o json
az containerapp show -n erpureai-webchat -g PINNED_GROUP --subscription PINNED_SUBSCRIPTION --query '(properties.template.containers[].env[] || `[]`) | {issuer:((@[?name==`"ReportAttachments__AudienceMappings__0__Actor__Issuer"`] | [0]).secretRef != `null` || (@[?name==`"ReportAttachments__ApprovedDeployment__Issuer"`] | [0]).secretRef != `null`) && `{"equal":null,"reason":"secretref"}` || (type((@[?name==`"ReportAttachments__AudienceMappings__0__Actor__Issuer"`] | [0]).value) != `"string"` || type((@[?name==`"ReportAttachments__ApprovedDeployment__Issuer"`] | [0]).value) != `"string"`) && `{"equal":null,"reason":"missing"}` || {equal:(@[?name==`"ReportAttachments__AudienceMappings__0__Actor__Issuer"`] | [0]).value == (@[?name==`"ReportAttachments__ApprovedDeployment__Issuer"`] | [0]).value},environment:((@[?name==`"ReportAttachments__AudienceMappings__0__Environment"`] | [0]).secretRef != `null` || (@[?name==`"ReportAttachments__ApprovedDeployment__Environment"`] | [0]).secretRef != `null`) && `{"equal":null,"reason":"secretref"}` || (type((@[?name==`"ReportAttachments__AudienceMappings__0__Environment"`] | [0]).value) != `"string"` || type((@[?name==`"ReportAttachments__ApprovedDeployment__Environment"`] | [0]).value) != `"string"`) && `{"equal":null,"reason":"missing"}` || {equal:(@[?name==`"ReportAttachments__AudienceMappings__0__Environment"`] | [0]).value == (@[?name==`"ReportAttachments__ApprovedDeployment__Environment"`] | [0]).value},storageAccount:((@[?name==`"ReportAttachments__AudienceMappings__0__StorageAccount"`] | [0]).secretRef != `null` || (@[?name==`"ReportAttachments__ApprovedDeployment__StorageAccount"`] | [0]).secretRef != `null`) && `{"equal":null,"reason":"secretref"}` || (type((@[?name==`"ReportAttachments__AudienceMappings__0__StorageAccount"`] | [0]).value) != `"string"` || type((@[?name==`"ReportAttachments__ApprovedDeployment__StorageAccount"`] | [0]).value) != `"string"`) && `{"equal":null,"reason":"missing"}` || {equal:(@[?name==`"ReportAttachments__AudienceMappings__0__StorageAccount"`] | [0]).value == (@[?name==`"ReportAttachments__ApprovedDeployment__StorageAccount"`] | [0]).value}}' -o json
```

3. After a successful command, pass only its projected JSON as data to a
   separate formatter invocation. Use a single-quoted heredoc delimiter on a
   line that does not occur in the JSON. The installed formatter reads stdin
   and has no Azure or credential access.

```sh
node ~/.codex/bin/codeden-guard-readback.mjs names <<'READBACK_JSON'
[{"name":"EXAMPLE","set":true,"on":false}]
READBACK_JSON
```

   For equality, use `equality issuer`, `equality environment`, or
   `equality storageAccount` in place of `names`. Each compares the configured
   audience mapping field with the corresponding approved deployment field.
   Return only the formatter's successful stdout to Codex. It emits a JSON
   array of names or a single `match` or `no-match`. If the command or formatter
   fails, report only `readback denied`. The formatter denies malformed output
   and missing or secret-backed operands for the selected pair.
