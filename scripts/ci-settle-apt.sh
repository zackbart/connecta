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
# Let the retry's own apt-get wait for a lock rather than fail on contact.
echo 'DPkg::Lock::Timeout "120";' | sudo tee /etc/apt/apt.conf.d/90connecta-lock-timeout > /dev/null
