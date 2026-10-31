# Remote domain mode

Remote domain mode is an opt-in mode for running umbrelOS on a server behind a TLS-terminating reverse proxy, for example Caddy or Traefik on the same host, or a tunnel. It is **off by default**. While it is off, umbrelOS behaves exactly as before.

With the mode on and the default naming (`<base domain>` = `example.com`):

| What | URL |
| --- | --- |
| Dashboard | `https://umbrel.example.com` |
| App login | `https://umbrel-auth.example.com` |
| Each app | `https://<appId>-umbrel.example.com` (e.g. `https://nextcloud-umbrel.example.com`) |

IP, LAN (`umbrel.local`), Tor and Tailscale access is unchanged. Those still use `http://<host>:<app port>` and the login page on port 2000.

## Turning it on

After first boot, sign in as the owner and open **Settings → Advanced → Remote domain**:

1. Enter your base domain, for example `example.com`. If no base domain has been saved and you opened the dashboard on a domain name, the field is pre-filled with a suggestion (`umbrel.example.com` → `example.com`). Check it before saving. The suggestion never turns the mode on. The dashboard subdomain (`umbrel`), auth subdomain (`umbrel-auth`), app subdomain template (`{app}-umbrel`), the Host and Origin rewrite opt-out, the trusted proxies and the client IP header are under **Advanced**. The defaults are fine for most setups.
2. Turn on **Enable remote domain** and save.
3. Optional: allow individual apps that have Umbrel login turned off, or allow an app's public paths remotely (see below).

Saving applies immediately. umbreld rebuilds its routing and no restart is needed. The same setting is available over tRPC as `lanIngress.setRemoteDomain` (owner only), for example `{enabled: true, baseDomain: "example.com"}`. `lanIngress.getRemoteDomain` can be read by any account. Only the owner also sees the per-app allow list and app status.

The settings are stored in `umbrel.yaml` under `settings.remoteDomain`.

## How routing works

- umbreld's existing HTTPS listener on **port 443** looks at the `Host` header and **matches it exactly**:
  - the dashboard host serves the dashboard;
  - the auth host serves the app login page;
  - `<template>.<base domain>` serves that app through its app gateway.
- Any **other host under the base domain gets 404**. Hosts outside the base domain (IPs, `umbrel.local`, Tailscale names) go to the dashboard exactly as before.
- Auth and app hosts are only served over HTTPS (port 443). On port 80 they return `421`. This keeps the secure `__Host-` session cookies working.
- Login redirects, the post-login handoff URL and the login page's CSP `form-action` are built from the **configured domain** as exact `https://` origins. They are never taken from the request's `Host` header.
- Redirect paths are sanitised to same-origin paths. Schemes, `//host` and backslash tricks fall back to `/`.
- **Apps with Umbrel login turned off are blocked (403)** on the remote domain by default, because anyone on the internet could reach them. The owner can allow each such app in the settings panel.
- Only apps served through Umbrel's app gateway (normal web apps) get a remote host. Apps without a gateway and non-HTTP services (for example a Bitcoin node's P2P/RPC ports, or SMB) stay on LAN/Tailscale and return 404 on the remote domain.

## Reverse proxy requirements

Any reverse proxy or tunnel works if it:

1. **Terminates TLS** for `umbrel.<domain>`, `umbrel-auth.<domain>` and `*-umbrel.<domain>`. The default names are all one level below the base domain, so a single wildcard certificate for `*.<domain>` covers them.
2. **Forwards to umbreld's port 443 over HTTPS** and **skips upstream certificate verification**. umbreld presents its own local-CA certificate, which does not match the public name.
3. **Passes the original `Host` header through.** Caddy and Traefik do this by default.
4. Supports WebSockets (the dashboard and many apps use them).
5. **Forwards only hosts under the base domain** to umbreld. Restrict the proxy rule to the hosts above if other services share the domain.

DNS: a public wildcard record `*.<domain>` pointing at the proxy covers the dashboard host, the auth host and every app host. You can instead create `umbrel`, `umbrel-auth` and one record per app. Unknown hosts under the base domain get a 404 from umbreld, so a wildcard record is safe.

## Self-hosted proxy (no CDN or tunnel needed)

You do not need a CDN or a tunnel service. A server with a public IP, a domain whose DNS provider has an API, and Caddy or Traefik is enough.

### DNS

At your DNS provider, point these records at the server's public IP:

| Record | Type | Value |
| --- | --- | --- |
| `*.example.com` | `A` (and `AAAA` for IPv6) | the server's public IP |

The wildcard already covers `umbrel.example.com`, `umbrel-auth.example.com` and `<app>-umbrel.example.com`. If you prefer explicit records, add `umbrel` and `umbrel-auth` plus one per app.

A wildcard certificate from Let's Encrypt needs the **DNS-01 challenge**, so the proxy needs an API token for your DNS provider. The examples below use Hetzner DNS. Any provider with a Caddy DNS module or a Traefik (lego) DNS provider works the same way; only the provider name and credential variable change.

### Caddy

Caddy needs a build that includes your DNS provider's module, for example `xcaddy build --with github.com/caddy-dns/hetzner/v2`, or the matching package from the Caddy download page. Then:

```caddyfile
*.example.com {
	tls {
		dns hetzner {env.HETZNER_API_TOKEN}
	}

	reverse_proxy https://umbrel:443 {
		transport http {
			tls_insecure_skip_verify
		}
	}
}
```

- `umbrel:443` is umbreld's HTTPS listener. Use the container name when Caddy shares a Docker network with umbrelOS, or `127.0.0.1:443` / a private IP otherwise.
- Every host under `example.com` goes to umbreld, which answers 404 for names it does not serve. If other services share the domain, give them their own site blocks (`foo.example.com { ... }`); since Caddy 2.10 they reuse the wildcard certificate.
- Caddy keeps the original `Host` header. It ignores `X-Forwarded-For` values sent by clients and sets its own with the real client address, so no header settings are needed.
- `tls_insecure_skip_verify` only affects the Caddy → umbreld hop, where umbreld uses its own local CA.

### Traefik (v3)

Static configuration (`traefik.yml`):

```yaml
entryPoints:
  websecure:
    address: ":443"

providers:
  file:
    filename: /etc/traefik/dynamic.yml

certificatesResolvers:
  letsencrypt:
    acme:
      email: admin@example.com
      storage: /letsencrypt/acme.json
      dnsChallenge:
        provider: hetzner # reads HETZNER_API_TOKEN from the environment
```

Dynamic configuration (`dynamic.yml`):

```yaml
http:
  routers:
    umbrel:
      rule: "Host(`umbrel.example.com`) || Host(`umbrel-auth.example.com`) || HostRegexp(`^[a-z0-9-]+-umbrel\\.example\\.com$`)"
      entryPoints: [websecure]
      service: umbrel
      tls:
        certResolver: letsencrypt
        domains:
          - main: "*.example.com"

  services:
    umbrel:
      loadBalancer:
        serversTransport: umbrel-local-ca
        servers:
          - url: "https://umbrel:443"

  serversTransports:
    umbrel-local-ca:
      insecureSkipVerify: true # umbreld uses its own local CA on :443
```

Traefik passes the original `Host` header by default (`passHostHeader` defaults to `true`) and sets `X-Forwarded-For` to include the client address. On Traefik v2, write the app rule as ``HostRegexp(`{app:[a-z0-9-]+}-umbrel.example.com`)``.

### Firewall

- **Only 443 should be public.** Allow inbound TCP 443 (and 80 only if you redirect HTTP to HTTPS at the proxy). Nothing else needs to be reachable from the internet. DNS-01 does not need port 80.
- **Do not publish umbreld's or the apps' ports.** Docker-published ports (`ports:` in Compose, `-p` on the command line) are inserted into iptables ahead of `ufw`'s rules, so `ufw deny` does **not** block them. Keep umbrelOS on a private Docker network that only the proxy joins, or bind any published port to `127.0.0.1`. If you must publish a port, filter it in the `DOCKER-USER` chain or your hosting provider's firewall.
- Use LAN or Tailscale for port-based app access (`http://<host>:<app port>`).

### Login protection

umbreld throttles password logins itself (see "Login backoff" below), so it is protected even when the proxy has no rate limiting configured. Proxy rate limits are still a good extra layer.

For a second login wall in front of everything, you can put [Authelia](https://www.authelia.com/) or [Authentik](https://goauthentik.io/) in front of the proxy route as forward auth. This is optional. Some apps' API clients (mobile and desktop sync apps) cannot pass such a wall, so exempt their paths or hosts if they break.

## Behind Cloudflare (optional)

Cloudflare is one option, not a requirement. If you use it:

**Cloudflare Tunnel** (`cloudflared` on the same host or Docker network):

```yaml
ingress:
  - hostname: "*.example.com"
    service: https://umbrel:443
    originRequest:
      noTLSVerify: true
  - service: http_status:404
```

`cloudflared` connects from a private address, which umbreld trusts by default, and the visitor address arrives in `X-Forwarded-For`, so client IPs work without extra settings. You can also set **Client IP header** to `CF-Connecting-IP`; that is safe here because the origin is only reachable through the tunnel.

**Cloudflare proxy in front of Caddy or Traefik:** umbreld would see Cloudflare edge addresses as clients. Either add [Cloudflare's IP ranges](https://www.cloudflare.com/ips/) to **Trusted proxies** together with your proxy's address, or set **Client IP header** to `CF-Connecting-IP`. Only do the latter if your firewall lets nothing but Cloudflare reach port 443; otherwise anyone can send that header. Cloudflare's Universal SSL covers `*.example.com`, and WAF rate limiting or Cloudflare Access can be added as extra layers.

## Security on the remote domain

The remote domain is reachable from the whole internet, so some behaviour there is stricter than on the LAN. LAN, IP, Tor and Tailscale requests keep their usual behaviour unless noted.

### Login backoff

Password logins are throttled with exponential backoff, on every host:

- **Per account:** 5 failed attempts are free, then the account is locked for 2 s, doubling with each further failure up to 15 minutes.
- **Per client IP:** 10 failed attempts across any accounts are free, then the IP is locked for 2 s, doubling up to 1 hour. This stops one address from spraying passwords over many accounts.
- It covers the dashboard login, including the 2FA step, and the app login on the auth host. A wrong password or a wrong 2FA code counts as a failure. A correct password sent without a 2FA code (the step that makes the 2FA prompt appear) does not.
- Attempts are counted when they start, so parallel guesses cannot race past the limit. A locked login gets HTTP `429` with `Retry-After` and no password check runs.
- Remote-domain and LAN failures for the same account are counted separately, so an internet attacker cannot lock the owner out of the LAN.
- A successful login clears the counters for that account and IP. Counters reset after 24 hours without failures and are kept in memory only.

Batched tRPC requests that contain a login, registration or other auth procedure are rejected with `400`, so a single HTTP request cannot carry many password guesses. Batching still works for everything else.

### Client IP and trusted proxies

The per-IP limit needs the real client address. umbreld works it out like this:

1. Start from the TCP peer that connected to port 443, skipping umbreld's own internal ingress hop.
2. On the LAN, or if that peer is not a trusted proxy, the peer is the client. `X-Forwarded-For` is ignored, so a client that reaches umbreld directly cannot choose its own address.
3. On the remote domain, if the peer is a trusted proxy, umbreld walks `X-Forwarded-For` from the right and skips trusted proxies. The first untrusted address is the client. Entries a client prepends cannot override what the proxy appended.

**Trusted proxies** default to loopback and private networks (`127.0.0.0/8`, `::1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`). That fits a proxy on the same host or Docker network. Change the list under **Advanced → Trusted proxies** (comma separated IPs or CIDR ranges).

If a CDN or another proxy sits in front of your own proxy, its edge addresses arrive in `X-Forwarded-For` too. Either add the CDN's published IP ranges to the trusted proxies, or set **Advanced → Client IP header** to the header your CDN sets with the visitor address. umbreld only reads that header when the request came through a trusted proxy. Only use it if the origin is reachable through the CDN alone; otherwise anyone can set that header.

If this is set up wrong, every remote visitor appears to come from the proxy's address. Then they all share one IP counter, and a few wrong passwords lock everyone out for up to an hour. After setup, check that failed logins from two different networks are counted separately.

### No account enumeration

On the remote domain, unauthenticated callers cannot tell which accounts exist:

- the account list on the login pages is empty, and the login form has an **account name** field instead of an account picker (leave it empty for the owner; names are matched case-insensitively);
- `user.exists` always answers `true`, and `user.is2faEnabled` always answers `false` (the 2FA prompt appears after a correct password);
- registering a new account is refused (`403`), so create accounts from the LAN or while signed in;
- an unknown username takes as long as a wrong password, because a dummy hash is checked;
- the app login API only answers on the auth host (other remote hosts get `404`), and it gives the same `404` for an unknown app and for an app that is not routed remotely.

Signed-in users see the normal account list. On the LAN everything works as before.

### Public app paths

Some app manifests mark paths as public (`PROXY_AUTH_WHITELIST`), so they skip Umbrel login. Those lists were written for the LAN. On the remote domain they would be open to the internet, so **they are ignored there by default** and every path needs Umbrel login.

If an app's clients need those paths (for example a mobile sync API), the owner can allow them for that app: each app card in the remote domain settings lists the app's public paths with an **Allow public paths on the remote domain** switch (off by default) and a warning. The manifest's blacklist (`PROXY_AUTH_BLACKLIST`) still applies. LAN behaviour is unchanged.

### Headers

- The login page's CSP `form-action` never falls back to a wildcard on remote hosts.
- Responses from the dashboard server send `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
- HSTS is not sent by umbreld. Enable it at the proxy if you want it.

The settings page warns the owner when 2FA is off. Turning on 2FA for every account is strongly recommended.

## Known limits

- Apps without an app gateway, and non-HTTP ports, are not routed on the remote domain.
- Upstream apps see a LAN `Host`/`Origin`/`Referer`. Apps that build absolute URLs in page bodies from the raw `Host` (instead of `X-Forwarded-Host`) produce LAN URLs; redirects are fixed up, page bodies are not. Use the per-app override for such apps. See "Origin and Referer rewrite" below.
- Only the app's main port is routed. Extra ports an app hands to the browser (for example a separate S3 or gateway port) stay LAN-only.
- Home-screen shortcuts, widgets and the MCP `get_app_details` URL still use port URLs.
- `X-Forwarded-For` is only used to find the client address for login throttling. The secure context comes from the proxy → :443 hop being HTTPS, not from `X-Forwarded-Proto`.
- Login throttling state is kept in memory, so it resets when umbreld restarts.

## Origin and Referer rewrite

Apps check the browser `Origin` in two common ways, and both reject `https://agent-zero-umbrel.example.com` out of the box:

- against a list of LAN URLs Umbrel hands them, for example `http://umbrel.local:3015` (Agent Zero, Django `CSRF_TRUSTED_ORIGINS`, better-auth `AUTH_TRUSTED_ORIGINS`, SvelteKit `ORIGIN`);
- by requiring the `Origin` host to equal `Host` or `X-Forwarded-Host` (Murmur, Agent Zero's WebSocket check, many WebSocket servers).

For remote-domain requests that have passed Umbrel app login (or that come from an app you allowed without login), the app gateway therefore presents the request the way a LAN browser sends it:

- `Host` becomes `<umbrel hostname>:<app port>`, for example `umbrel.local:3015`. The hostname is the device hostname with `.local` added, `umbrel.local` by default;
- `Origin: https://<appId>-umbrel.<domain>` becomes `http://<umbrel hostname>:<app port>`, for normal HTTP requests and WebSocket upgrades;
- a `Referer` on that same origin becomes the LAN origin, keeping its path and query;
- `X-Forwarded-Host: <appId>-umbrel.<domain>` and `X-Forwarded-Proto: https` are set, so apps that build URLs from them still produce remote URLs.

`Host` and `Origin` are always rewritten together, so a same-app request passes both kinds of check. Only an exact match on the app's own remote origin is rewritten. Foreign origins and other apps' origins reach the app unchanged and still fail both checks. Requests with no `Origin` are left alone apart from `Host`. LAN, IP and Tailscale requests are never rewritten.

**Redirects.** Apps configured with a LAN URL (for example `APP_URL=http://umbrel.local:7455`) redirect to it, which does not work from the internet. On an app's remote host the gateway rewrites a response `Location` or `Refresh` URL that points at the app itself to `https://<appId>-umbrel.<domain>`, keeping path and query. "The app itself" means the LAN hostname (with or without `.local`), a private or loopback IP or `localhost` on the app's LAN port, or the app container's host or address on its internal port. Relative URLs, other ports (other apps) and public hosts are left alone. A `Set-Cookie` `Domain` attribute naming a local hostname is dropped, so the cookie becomes host-only on the remote host. This also applies to apps under the per-app override.

**Per-app override.** Apps that compare `Origin` with `X-Forwarded-Host` before `Host` (for example Next.js server actions and Rails), or that build page URLs from the raw `Host`, should get the browser's original headers. Add the app ID under **Settings → Advanced → Remote domain → Advanced → Send the original Host and Origin headers to these apps**, or over tRPC: `lanIngress.setRemoteDomain({..., originRewriteDisabledApps: ["some-app"]})`. Those apps get the original `Host`, `Origin` and `Referer`, plus `X-Forwarded-Host`/`X-Forwarded-Proto`. The setting keeps its `originRewriteDisabledApps` name for compatibility.

## Revision 2

1. **New and changed apps are routed without toggling the mode.** Before this revision, an app installed after the mode was turned on only got a remote host after the mode was turned off and on again. The cause was that the UI refetched the app list on `apps:state:change` before the app's gateway was listening, and nothing told it to fetch again. Now:
   - While the mode is on, umbreld refreshes routing (debounced, 250 ms) on every `apps:state:change` and `apps:settings:change`. That covers install, uninstall, update, start, stop and auth/allow-list changes.
   - Whenever the set of routed hosts or their auth state changes, umbreld emits a payload-free `lan-ingress:remote-routes:change` event. The UI then refetches the app list and the remote-domain settings, so the new `https://<app>-umbrel.<domain>` link appears by itself.
   - The host→app map and allow-list status are rebuilt even if part of a refresh fails.
   - An app whose gateway is still starting returns `503` with `Retry-After: 5` and `Refresh: 5` instead of `404`, so the browser retries on its own.
   - Uninstalled or stopped apps lose their gateway, drop out of the map on the next refresh, and return `404`.
2. **No real domain is used.** Code, tests and docs use `example.com`, `<app>-umbrel.example.com` and `umbrel-auth.example.com`. There is no built-in default base domain any more. It is empty until you set one.
3. **Simpler settings.** The base domain is the main field. Dashboard subdomain, auth subdomain, app template and the Origin rewrite opt-out are in a collapsed **Advanced** section, with a note that the defaults are fine for most setups.
4. **Base domain suggestion.** When nothing is saved yet, the field is pre-filled from the address you opened the dashboard on, with the first label dropped (`umbrel.example.com` → `example.com`). You confirm it by saving. The mode is never turned on automatically. No suggestion is made for IPv4/IPv6 addresses, `localhost`, `*.local`, Tailscale `*.ts.net`, `.onion`, other private-use suffixes (`.internal`, `.lan`, `.home`, `.test`), or single-label and two-label hosts.
5. **Origin/Referer rewrite in the app gateway** (generic, fixes Agent Zero). See "Origin and Referer rewrite" above, including the per-app `originRewriteDisabledApps` override.

Tests added: hostname suggestion (UI), lifecycle refresh, route-change event and uninstall removal (`lan-ingress-remote-lifecycle.unit.test.ts`), the 503 for starting apps, header rewrite helpers, and gateway integration tests. The integration tests send real HTTP and WebSocket upgrade requests to an echo upstream and cover: same-app origin rewritten, foreign/other-app origin untouched, referer path kept, no-origin untouched, LAN requests untouched, and the per-app opt-out.

## Revision 3 (security hardening)

1. **Login backoff, built in.** Exponential backoff per account (5 free failures, then 2 s doubling to 15 min) and per client IP (10 free failures, then 2 s doubling to 1 h) for the dashboard password and 2FA login and the app login. Remote and LAN failures are counted separately per account. Locked logins get `429` with `Retry-After` and skip the password check. Batched tRPC requests that contain auth procedures are rejected with `400`. See "Login backoff".
2. **Real client IP.** `X-Forwarded-For` is only believed from trusted proxies (default: loopback and private networks) on the remote domain, with an optional client IP header. Both are under **Advanced**. See "Client IP and trusted proxies".
3. **No account enumeration on the remote domain.** Empty account list, an account name field on the login pages, constant answers from `user.exists` and `user.is2faEnabled`, no remote registration, a dummy hash for unknown names, and uniform `404`s on the auth host. LAN behaviour is unchanged. See "No account enumeration".
4. **Manifest public paths are ignored remotely** unless the owner allows them per app (off by default, with a warning). See "Public app paths".
5. **Headers.** No wildcard CSP `form-action` fallback on remote hosts; `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` on dashboard responses. The settings page warns when 2FA is off.
6. **Docs.** The proxy guide is provider-neutral and includes a self-hosted Caddy or Traefik setup with a wildcard certificate over DNS-01.

Tests added: the throttle policy (`login-throttle.unit.test.ts`), client IP resolution (`client-ip.unit.test.ts`), the new settings (`remote-domain.unit.test.ts`), public paths in the app gateway (`app-gateway-remote.unit.test.ts`), and HTTP-level tests for batching, enumeration, lockouts, IP spraying, app login and headers on remote and LAN hosts (`remote-hardening.unit.test.ts`).

## Revision 4 (Host/Origin consistency and redirects)

1. **Apps that require the Origin host to match Host now work without an override.** The gateway used to rewrite `Origin` to the LAN origin but leave `Host` as the remote host, so apps such as Murmur, whose CSRF check requires the `Origin` host to equal `Host` or `X-Forwarded-Host`, rejected every POST and WebSocket upgrade. `Host` is now rewritten to the LAN host together with `Origin`, the way a reverse proxy's `ProxyPass`/`ProxyPassReverse` pair presents a backend. LAN-allowlist apps such as Agent Zero keep working. See "Origin and Referer rewrite".
2. **LAN redirects are rewritten.** A `Location` or `Refresh` URL pointing at the app's local address (for example lobe-chat's `http://umbrel.local:7455/signin`) becomes the same path on the app's remote host, and local `Set-Cookie` domains are dropped. See "Redirects".

Tests added: gateway tests against an upstream that enforces the Murmur check (POST and WebSocket upgrade), one that enforces a LAN-origin allowlist, and redirect, `Refresh` and `Set-Cookie` rewriting (`app-gateway-remote.unit.test.ts`); URL matching helpers (`remote-domain.unit.test.ts`).
