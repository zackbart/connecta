#!/usr/bin/env bash
set -euo pipefail

# A timed-out Playwright --with-deps install can leave apt-get or dpkg running
# and holding /var/lib/dpkg/lock-frontend. Wait for it rather than kill it
# mid-install, then finish any interrupted configuration. If apt is still busy
# after the bound, fail with the processes named instead of racing them.
limit=${APT_SETTLE_SECONDS:-180}
deadline=$((SECONDS + limit))
while pgrep -x 'apt|apt-get|dpkg' > /dev/null; do
  if (( SECONDS >= deadline )); then
    echo "apt or dpkg is still running after ${limit}s:" >&2
    pgrep -ax 'apt|apt-get|dpkg' >&2 || true
    exit 1
  fi
  echo "Waiting for a previous apt or dpkg process to exit"
  sleep 5
done
sudo dpkg --configure -a
# Playwright invokes apt-get itself, so configure the equivalent of
# -o Acquire::Retries=3 for both its update and install commands.
cat <<'APT' | sudo tee /etc/apt/apt.conf.d/90connecta-install > /dev/null
DPkg::Lock::Timeout "60";
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
APT

# The hosted runner's Azure HTTP mirror can take minutes per font package.
# Use Ubuntu's HTTPS archive in both direct sources and the runner mirror list.
# Keep apt-get update: the observed delay was package downloads, not indexes.
for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources /etc/apt/apt-mirrors.txt; do
  if [[ -f "$source" ]]; then
    sudo sed -i 's|http://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' "$source"
  fi
done
