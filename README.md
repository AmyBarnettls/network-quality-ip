# Network Quality & IP

A GNOME Shell 50 extension for Ubuntu 26.04 that shows a rolling
60-second ICMP latency graph, the current public IPv4 country, and a simple
IP reputation classification in the top panel.

## What the panel shows

- 60 bars, oldest on the left and newest on the right; one ICMP sample per
  second.
- Bar height represents latency and is capped at 300 ms.
- Green is at most 80 ms, amber is 81–150 ms, red is above 150 ms, and gray
  means timeout or packet loss. Thresholds can be changed in Settings.
- The two text fields are the public IPv4 country code and one of `Clean`,
  `Attention`, `Risk`, or `Unknown`.

Click the indicator to see current RTT, median, P95, jitter, packet loss,
IPv4 location, ISP/ASN, individual reputation flags, and update time.

## Requirements

- Ubuntu 26.04 with GNOME Shell 50
- `/usr/bin/ping` from `iputils-ping`
- `gnome-extensions`, `glib-compile-schemas`, `gjs`, `eslint`, and `make`

## Build and test

```sh
make check
make pack
```

Run the extension inside an isolated, headless GNOME Shell 50 session with:

```sh
make smoke
```

The installable bundle is written to:

```text
dist/network-quality-ip@local.shell-extension.zip
```

Install and enable it for the current user with:

```sh
make install
```

On the first installation, the running Wayland session may not discover the
new extension immediately. If `make install` prints a notice, log out and back
in once, then run:

```sh
gnome-extensions enable network-quality-ip@local
```

Open its preferences with:

```sh
gnome-extensions prefs network-quality-ip@local
```

View runtime errors with:

```sh
journalctl --user -f -o cat /usr/bin/gnome-shell
```

## Network and privacy behavior

- `/usr/bin/ping` sends one ICMP echo per second to `1.1.1.1` by default.
  The target can be changed in Settings.
- `https://api.ipify.org?format=json` receives a request every 60 seconds to
  detect the current public IPv4.
- `https://api.ipapi.is/?q=<IPv4>` is queried on first use and whenever the
  public IPv4 changes. It supplies location, ASN, hosting, VPN, proxy, Tor,
  and abuse indicators.

These services necessarily receive the public IPv4 used for the request.
Reputation data is probabilistic and must not be treated as proof that an IP
address is safe or malicious.

## Reputation mapping

- `Risk`: abuse or Tor is reported.
- `Attention`: proxy, VPN, datacenter, crawler, or managed egress is reported.
- `Clean`: none of those flags is reported.
- `Unknown`: data is unavailable or invalid.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
