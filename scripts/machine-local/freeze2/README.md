# CodeDen launcher reconnect fix

The machine-local launcher calls `~/.config/codeden-launcher/prestart.sh` before opening CodeDen. This candidate leaves detached runners running so CodeDen can check ownership and health within its reconnect window. The periodic launcher watchdog and CodeDen application are outside the installation scope.

Run the five launcher regression cases from this directory with `python3 test_prestart.py prestart.sh`. The tests use simulated process listings and a fake reaper. `match.awk` is the machine-local matcher's fixture for these tests.

For the terminal-free install, stage `arm.sh` and `prestart.sh` together in a private directory. Run the one-shot job only after review and approval. It verifies the original and candidate hashes, preserves the executable mode, atomically replaces the target, and records the backup and result in its staging directory.
