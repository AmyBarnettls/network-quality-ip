# Network Quality & IP

A small GNOME Shell 50 extension for Ubuntu 26.04. It shows a rolling
60-second latency graph, the current public IP country, and a simple IP
reputation label in the top panel.

## Display

The panel contains 60 bars, a two-letter country code, and one of `Clean`,
`Attention`, `Risk`, `Unknown`, or `Offline`.

- Green: at most 80 ms
- Amber: 81–150 ms
- Red: above 150 ms
- Gray: timeout or packet loss

The menu shows current RTT, packet loss, public IP, country, ISP / ASN, and
the reason for the reputation label.

## Behavior

- One long-running `/usr/bin/ping` process probes `1.1.1.1` once per second.
- `https://api.ipapi.is` is queried on startup, after reconnecting, and every
  15 minutes while online.
- `Risk` means Tor or abuse was reported.
- `Attention` means VPN, proxy, or datacenter use was reported.
- `Clean` means none of those flags was reported.
- `Unknown` means the response was unavailable or invalid.

The extension has no settings and writes no IP data to disk.

## Privacy

The IP lookup sends the public IPv4 or IPv6 address used for the HTTPS request
to `ipapi.is`. Reputation data is probabilistic and is not proof that an IP
address is safe or malicious.

## Install from GitHub Release

Ubuntu 26.04 with GNOME Shell 50 is required. Install `curl`, `unzip`, and
`iputils-ping`, then run this single command:

```sh
release_dir="$(mktemp -d)" && curl -fL "https://github.com/AmyBarnettls/network-quality-ip/releases/download/v1.0.0/network-quality-ip-gnome-shell-50.zip" -o "$release_dir/release.zip" && unzip -q "$release_dir/release.zip" -d "$release_dir" && gnome-extensions install --force "$release_dir/network-quality-ip@amybarnettls.github.io.shell-extension.zip"
```

Log out and back in once, then enable the extension:

```sh
gnome-extensions enable network-quality-ip@amybarnettls.github.io
```

## Build

Requires GNOME Shell 50, GJS, ESLint, `gnome-extensions`, `make`, and
`/usr/bin/ping` from `iputils-ping`.

```sh
make check
make pack
make install
```

The package is written to:

```text
dist/network-quality-ip@amybarnettls.github.io.shell-extension.zip
```

Runtime errors are available with:

```sh
journalctl --user -f -o cat /usr/bin/gnome-shell
```

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
