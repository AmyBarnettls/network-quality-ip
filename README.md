# Network Quality & IP

A small GNOME Shell 50 extension for Ubuntu 26.04. It shows a rolling
3-minute HTTPS quality graph, the current public IP country, and a simple IP
reputation label in the top panel.

## Display

The panel contains 60 bars sampled every 3 seconds, a two-letter country code,
and one of `Clean`, `Attention`, `Risk`, `Unknown`, or `Offline`.

- Green: HTTPS request completed in at most 300 ms
- Amber: HTTPS request completed in 301–800 ms
- Red: HTTPS request completed in 801–2999 ms
- Gray: DNS, TCP, TLS, HTTP validation, or 3-second timeout failure

The menu shows current HTTPS time, the 60-sample failure rate, active probe
target, public IP, country, ISP / ASN, and the reason for the reputation label.

## Behavior

- A fresh HTTPS connection is tested every 3 seconds. Google is used first;
  after three consecutive failures the extension switches to Cloudflare, then
  Apple, and finally loops back to Google. A working fallback remains active
  until it also fails three consecutive times.
- Probe responses are validated exactly and redirects are rejected. Each
  request has a 3-second timeout and requests never overlap.
- `https://api.ipapi.is` is queried on startup, after reconnecting, and every
  15 minutes while online.
- `Risk` means Tor or abuse was reported.
- `Attention` means VPN, proxy, or datacenter use was reported.
- `Clean` means none of those flags was reported.
- `Unknown` means the response was unavailable or invalid.

The extension has no settings and writes no IP data to disk.

## Privacy

The HTTPS quality probes expose the public IPv4 or IPv6 address used for each
request to the active provider (Google, Cloudflare, or Apple). The IP lookup
also sends the address used for that request to `ipapi.is`. Reputation data is
probabilistic and is not proof that an IP address is safe or malicious.

## Install from GitHub Release

Ubuntu 26.04 with GNOME Shell 50 is required. Install `curl` and `unzip`, then
run this single command:

```sh
release_dir="$(mktemp -d)" && curl -fL "https://github.com/AmyBarnettls/network-quality-ip/releases/download/v1.0.0/network-quality-ip-gnome-shell-50.zip" -o "$release_dir/release.zip" && unzip -q "$release_dir/release.zip" -d "$release_dir" && gnome-extensions install --force "$release_dir/network-quality-ip@amybarnettls.github.io.shell-extension.zip"
```

Log out and back in once, then enable the extension:

```sh
gnome-extensions enable network-quality-ip@amybarnettls.github.io
```

## Build

Requires GNOME Shell 50, GJS, ESLint, `gnome-extensions`, and `make`.

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
