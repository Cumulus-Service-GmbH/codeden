# Shared matching rules for prestart.sh and watchdog.sh.
# Input: lines "pid ppid %cpu command" (from: ps -axww -o pid=,ppid=,%cpu=,command=).
# Output: "pid<TAB>%cpu<TAB>command" for each process of the requested kind.
# Variables: kind=server|runner  mode=prod|test  app=/Applications/CodeDen.app
#            home=$HOME/.codeden  troot=<test root>  skip=" <pids to ignore> "
#
# Rules look at the argv STRUCTURE (the executable, then the script as the first argument),
# never at a substring anywhere in the command line, so a shell or grep whose command text
# merely mentions these paths can never match.
#
# prod runner:  "<app>/Contents/Frameworks/CodeDen Helper.app/Contents/MacOS/CodeDen Helper <app>/Contents/Resources/app/dist/runner.js ..."
#               or "node <...>/dist/runner.js --home <home>"           (npm-installed CLI)
# prod server:  "<app>/Contents/MacOS/CodeDen ..."                      (the app itself)
#               or "<helper> <app>/Contents/Resources/app/dist/server.js ..."
#               or "node <...>/dist/server.js --home <home>"
#               or "node <...>/codeden/dist/cli.js ..." / "node <...>/codeden ..."
# prod serverjs (watchdog's env check; only the server child, not the app):
#               "<helper> <app>/Contents/Resources/app/dist/server.js ..." or "node <...>/dist/server.js --home <home>"
# test runner:  "node|perl <troot>/.codeden/runner.js"  (troot is under /tmp; prod rules never see it)
# test serverjs: "node <troot>/.codeden/server.js"
function starts(s, t,   c) {
  if (index(s, t) != 1) return 0
  c = substr(s, length(t) + 1, 1)
  return c == "" || c == " "
}
function base(p) { sub(/.*\//, "", p); return p }
{
  pid = $1; cpu = $3
  cmd = $0; sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]+[0-9.,]+[ \t]+/, "", cmd)
  if (index(skip, " " pid " ")) next
  split(cmd, a, " ")
  isnode = (base(a[1]) == "node")
  helper = app "/Contents/Frameworks/CodeDen Helper.app/Contents/MacOS/CodeDen Helper"
  hit = 0
  if (mode == "test") {
    # perl is allowed here only, for fakes that make zombies or ignore SIGTERM (node always reaps)
    if (kind == "runner" && (isnode || base(a[1]) == "perl") && a[2] == troot "/.codeden/runner.js") hit = 1
    if (kind == "serverjs" && isnode && a[2] == troot "/.codeden/server.js") hit = 1
  } else if (kind == "serverjs") {
    if (starts(cmd, helper " " app "/Contents/Resources/app/dist/server.js")) hit = 1
    else if (isnode && a[2] ~ /\/dist\/server\.js$/ && a[3] == "--home" && a[4] == home) hit = 1
  } else if (kind == "runner") {
    if (starts(cmd, helper " " app "/Contents/Resources/app/dist/runner.js")) hit = 1
    else if (isnode && a[2] ~ /\/dist\/runner\.js$/ && a[3] == "--home" && a[4] == home) hit = 1
  } else if (kind == "server") {
    if (starts(cmd, app "/Contents/MacOS/CodeDen")) hit = 1
    else if (starts(cmd, helper " " app "/Contents/Resources/app/dist/server.js")) hit = 1
    else if (isnode && a[2] ~ /\/dist\/server\.js$/ && a[3] == "--home" && a[4] == home) hit = 1
    else if (isnode && (a[2] ~ /\/codeden\/dist\/cli\.js$/ || base(a[2]) == "codeden")) hit = 1
  }
  if (hit) { gsub(",", ".", cpu); printf "%s\t%s\t%s\n", pid, cpu, cmd }
}
