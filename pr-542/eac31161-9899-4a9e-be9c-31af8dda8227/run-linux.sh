#!/usr/bin/env bash
# Copies the probe to a Linux temp dir, starts the stand-in server and runs the probe.
SRC=/mnt/c/Users/leon/AppData/Local/Temp/curl-pipe-probe
D=$(mktemp -d)
cp "$SRC/server.py" "$SRC/probe.sh" "$SRC/index.html" "$D/"
cd "$D"
python3 server.py 4791 & S=$!
for i in $(seq 1 20); do curl -s -o /dev/null http://127.0.0.1:4791/ && break; sleep 0.3; done
echo "$(. /etc/os-release; echo "$PRETTY_NAME") | bash $BASH_VERSION | $(curl --version | head -n1 | awk '{print $1, $2}') | $(grep --version | head -n1)"
bash probe.sh "${1:-20}"
kill $S
rm -rf "$D"
