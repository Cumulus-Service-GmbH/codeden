import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(sys.argv.pop(1)).resolve()
MATCH = Path(__file__).with_name("match.awk")


class PrestartTest(unittest.TestCase):
    def run_prestart(self, *, server="none", runner=True, args=()):
        with tempfile.TemporaryDirectory(prefix="freeze2-prestart-", dir="/tmp") as directory:
            root = Path(directory)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            home = root / "home"
            home.mkdir()
            shutil.copyfile(MATCH, root / MATCH.name)
            fixture = re.sub(r"^HERE=.*$", 'HERE="$FREEZE2_FIXTURE"', SOURCE.read_text(), count=1, flags=re.M)
            # Isolate external dependencies and the script's self-timeout. No signals or GUI calls.
            fixture = re.sub(r"^# Hard cap:.*?^trap .* EXIT\n", "SELF=$$\n", fixture, count=1, flags=re.M | re.S)
            fixture = fixture.replace("/usr/bin/osascript", "/usr/bin/true")
            (root / "prestart.sh").write_text(fixture)
            (bin_dir / "ps").write_text("""#!/bin/bash
case "$*" in
  '-axww -o pid=,ppid=,%cpu=,command=')
    if [ "$FREEZE2_RUNNER" = yes ]; then
      printf '55000 1 97.6 node %s/.codeden/runner.js\n' "$FREEZE2_FIXTURE"
    fi
    ;;
  '-o pid=,lstart= -p 55000') printf '55000 Wed Nov 25 01:01:02 2026\n' ;;
  '-axo pid=,stat=,lstart=')
    for unused in 1 2 3 4 5 6 7 8 9 10; do
      [ -e "$FREEZE2_FIXTURE/reap.called" ] && break
      /bin/sleep 0.02
    done
    printf '1 Ss Wed Nov 25 00:01:02 2026\n'
    ;;
esac
""")
            (bin_dir / "ps").chmod(0o700)
            (root / "reap.sh").write_text('printf "%s\\n" "$*" > "$FREEZE2_FIXTURE/reap.called"\n')
            env = {
                "HOME": str(home),
                "PATH": f"{bin_dir}:/usr/bin:/bin",
                "CDL_TEST_ROOT": str(root),
                "CDL_FAKE_SERVER": server,
                "FREEZE2_FIXTURE": str(root),
                "FREEZE2_RUNNER": "yes" if runner else "no",
            }
            completed = subprocess.run(
                ["/bin/bash", str(root / "prestart.sh"), *args],
                env=env, capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertFalse((root / "reap.called").exists(), "Prestart invoked the reaper for a detached runner.")
            return completed.stdout

    def test_recently_detached_busy_runner_is_left_for_reconnect(self):
        self.run_prestart()

    def test_already_running_server_skips_prestart(self):
        self.assertIn("CodeDen already running", self.run_prestart(server="running"))

    def test_no_runner_enters_normal_startup(self):
        self.assertIn("no leftover runner found", self.run_prestart(runner=False))

    def test_list_still_reports_the_detached_runner(self):
        self.assertIn("55000", self.run_prestart(args=("--list",)))

    def test_dry_run_preserves_the_runner(self):
        self.assertIn("DRY-RUN", self.run_prestart(args=("--dry-run",)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
