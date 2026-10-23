# Run b0a6c063 interrupted by an unattended nginx upgrade, 2026-10-23

Run `b0a6c063-56b7-4b5c-91f7-8f1a0228f803` (project Attica, execution target
customer-device `9bafcb10`, revision 4f706772) ended `failed` at 06:05:34 UTC
with "Compute execution interrupted; workload stop confirmed. No cancellation
was requested." after 36 minutes, while the molecule Adrenaline was retrying a
genuinely failed parent suite.

## Cause

Debian `unattended-upgrades` on atoma.run upgraded `nginx` and `nginx-common`
from 1.26.3-3+deb13u9 to +deb13u10 and the package maintainer script restarted
the service (systemd stop/start, not a reload):

| UTC | source | event |
|---|---|---|
| 06:05:14 | systemd | `apt-daily-upgrade.service` starts; unattended-upgrades lists bind9-*, nginx, nginx-common |
| 06:05:20 | dpkg.log | `upgrade nginx 1.26.3-3+deb13u9 → +deb13u10` |
| 06:05:21 | systemd | `Stopping nginx.service` |
| 06:05:26.845 | server compute log | `socket-close`, closeCode 1006, lastReceive 4.7 s, one tool invocation pending 17.5 s, connection age 2209 s |
| 06:05:26.859 | Mac `~/.atoma/compute/connection.log` | the same close, code 1006, same session a1ca2589 |
| 06:05:26 | systemd | `Stopped nginx.service` then `Started nginx.service` |
| 06:05:27 | nginx error.log | `using inherited sockets from "6;7;8;9;"` |
| 06:05:27.565 | Mac | `stop-confirmed` |
| 06:05:33 | both | device reconnected, new session b7e2e809, generation 104 |
| 06:05:34 | ProjectService | run failed, checkpoint unavailable |

Every proxied WebSocket died with the nginx master, both ends seeing the close in
the same millisecond with no close frame. The Mac showed no WiFi link change, roam
or sleep at that time (rssi −68 dBm steady, `airportd`/`powerd` quiet), unlike the
2026-10-22 interruption of 1622e44b, which was a local network transition.

Atoma's own deployments did not cause it: the compute socket is served by the
executor generation unit over `/home/atoma/compute/active.sock`, and the two
deployments during the run (05:39, 05:51, peer pushes) left the connection up.

## Consequence

The executor transport is not resumable (recorded limit of the 2026-10-22 record),
so a reconnected device starts a new session and the run is failed with no
checkpoint. The orchestration measurement the run was started for stands:
root plan approved in two rounds, the SieveElement cell ladder bounded at its
third plan, first implementation tool call at minute 22.

## Options

1. Keep `nginx` out of unattended upgrades (`Unattended-Upgrade::Package-Blacklist`)
   and upgrade it by hand between runs; a security upgrade of the edge proxy then
   waits for an operator.
2. Make the executor transport resumable across a proxy restart (a lease that
   survives reconnection with the same session), the structural fix.

Neither was applied in this record.
