# Remote domain mode

Remote domain mode is an opt-in way to reach umbrelOS and its apps on your own domain through a TLS-terminating reverse proxy. Typical cases are a server without a LAN or a home server published through a tunnel. It is **off by default**. While it is off, umbrelOS behaves exactly as before.

With the mode on and the default naming (base domain `example.com`):

| What | URL |
| --- | --- |
| Dashboard | `https://umbrel.example.com` |
| App login | `https://umbrel-auth.example.com` |
| Each app | `https://<appId>-umbrel.example.com` (e.g. `https://nextcloud-umbrel.example.com`) |

IP, LAN (`umbrel.local`), Tor and Tailscale access is unchanged. Those still use `http://<host>:<app port>` and the login page on port 2000.

## Turning it on

Sign in as the owner and open **Settings → Advanced → Remote domain**:

1. Enter the base domain, for example `example.com`. If no base domain has been saved and you opened the dashboard on a domain name, the field is pre-filled with a suggestion: the current hostname with its first label dropped (`umbrel.example.com` → `example.com`). Check it before saving. The suggestion never turns the mode on. No suggestion is made for IP addresses, `localhost`, `*.local`, `*.ts.net`, `.onion`, other private-use suffixes (`.internal`, `.lan`, `.home`, `.test`), or one- and two-label hosts.
2. Turn on **Enable remote domain** and save.
3. Optional: the **Advanced** section holds the dashboard subdomain (`umbrel`), auth subdomain (`umbrel-auth`), app subdomain template (`{app}-umbrel`), the Host and Origin rewrite opt-out, the trusted proxies and the client IP header (see "Client IP and trusted proxies"). The defaults are fine for most setups.
4. Optional: allow individual apps that have Umbrel login turned off, or allow an app's public paths remotely (see below).

Saving applies immediately, with no restart. The same setting is available over tRPC as `lanIngress.setRemoteDomain` (owner only), for example `{enabled: true, baseDomain: "example.com"}`. `lanIngress.getRemoteDomain` can be read by any account. Only the owner also sees the per-app allow list and app status. The settings are stored in `umbrel.yaml` under `settings.remoteDomain`.

## How routing works

- umbreld's HTTPS listener on **port 443** looks at the `Host` header and **matches it exactly**:
  - the dashboard host serves the dashboard;
  - the auth host serves the app login page;
  - `<template>.<base domain>` serves that app through its app gateway.
- Any **other host under the base domain gets 404**. Hosts outside the base domain (IPs, `umbrel.local`, Tailscale names) go to the dashboard exactly as before.
- Auth and app hosts are only served over HTTPS. On port 80 they return `421`. This keeps the secure `__Host-` session cookies working.
- Login redirects, the post-login handoff URL and the login page's CSP `form-action` are built from the **configured domain** as exact `https://` origins. They are never taken from the request's `Host` header. Redirect paths are sanitised to same-origin paths.
- **Apps with Umbrel login turned off are blocked (403)** on the remote domain by default, because anyone on the internet could reach them. The owner can allow each such app in the settings panel.
- Only apps served through Umbrel's app gateway (normal web apps) get a remote host. Apps without a gateway and non-HTTP services stay on LAN/Tailscale and return 404 on the remote domain.

### App lifecycle

Routing follows apps automatically. You never need to turn the mode off and on.

- While the mode is on, umbreld refreshes routing (debounced, 250 ms) on every `apps:state:change` and `apps:settings:change`. That covers install, uninstall, update, start, stop and auth changes.
- When the set of routed hosts or their auth status changes, umbreld emits the payload-free event `lan-ingress:remote-routes:change`. The dashboard then refetches the app list and remote-domain settings, so a new app's `https://<app>-umbrel.<domain>` link shows up on its own.
- An installed app whose gateway is still starting returns `503` with `Retry-After: 5` and `Refresh: 5`, so the browser retries on its own.
- Uninstalled or stopped apps drop out of the routing table on the next refresh and return `404`.

### Origin and Referer rewrite

Apps check the browser `Origin` in two common ways, and both reject `https://<app>-umbrel.example.com` out of the box:

- against a list of LAN URLs Umbrel hands them, for example `http://umbrel.local:3015` (Django `CSRF_TRUSTED_ORIGINS`, better-auth `AUTH_TRUSTED_ORIGINS`, SvelteKit `ORIGIN`, or an app's own `ALLOWED_ORIGINS`);
- by requiring the `Origin` host to equal `Host` or `X-Forwarded-Host` (a common CSRF and WebSocket check).

For remote-domain requests that have passed Umbrel app login (or that come from an app the owner allowed without login), the app gateway therefore presents the request the way a LAN browser sends it:

- `Host` becomes `<device hostname>.local:<app port>` (`umbrel.local` by default);
- `Origin: https://<appId>-umbrel.<domain>` becomes `http://<device hostname>.local:<app port>`, for HTTP requests and WebSocket upgrades;
- a `Referer` on that same origin becomes the LAN origin, keeping its path and query;
- `X-Forwarded-Host: <appId>-umbrel.<domain>` and `X-Forwarded-Proto: https` are set, so apps that build URLs from them still produce remote URLs.

`Host` and `Origin` are always rewritten together, so a same-app request passes both kinds of check. Only an exact match on the app's own remote origin is rewritten. Foreign origins and other apps' origins reach the app unchanged and still fail both checks. Requests with no `Origin` are left alone apart from `Host`. LAN, IP and Tailscale requests are never rewritten.

**Redirects.** Apps configured with a LAN URL (for example `APP_URL=http://umbrel.local:7455`) redirect to it, which does not work from the internet. On an app's remote host the gateway rewrites a response `Location` or `Refresh` URL that points at the app itself to `https://<appId>-umbrel.<domain>`, keeping path and query. "The app itself" means the LAN hostname (with or without `.local`), a private or loopback IP or `localhost` on the app's LAN port, or the app container's host or address on its internal port. Relative URLs, other ports (other apps) and public hosts are left alone. A `Set-Cookie` `Domain` attribute naming a local hostname is dropped, so the cookie becomes host-only on the remote host. This also applies to apps under the per-app override.

**Per-app override.** Apps that compare `Origin` with `X-Forwarded-Host` before `Host` (for example Next.js server actions and Rails), or that build page URLs from the raw `Host`, should get the browser's original headers. Add the app ID under **Advanced → Send the original Host and Origin headers to these apps**, or over tRPC with `originRewriteDisabledApps: ["some-app"]`. Those apps get the original `Host`, `Origin` and `Referer`, plus `X-Forwarded-Host`/`X-Forwarded-Proto`. The setting keeps its `originRewriteDisabledApps` name for compatibility.

### App environment and extra ports

Some checks live in the app's own configuration, not in headers, so the gateway's header rewrite cannot reach them. A Better Auth login, for example, posts its `callbackURL` in the request body and checks it against `AUTH_TRUSTED_ORIGINS`. Some apps also hand the browser LAN URLs to their other ports, such as an S3 endpoint for uploads or a WebSocket gateway. umbreld never rewrites request or response bodies. Instead, while the mode is on, it adjusts the app's environment:

- **Trusted origins.** If a service of the app sets `AUTH_TRUSTED_ORIGINS`, `BETTER_AUTH_TRUSTED_ORIGINS`, `AUTH_ADDITIONAL_TRUSTED_ORIGINS` or `CSRF_TRUSTED_ORIGINS`, the app's remote origin is appended to the comma-separated list. The LAN entries stay.
- **Extra ports (opt-in per app).** A published port of the app, other than its main port, counts as browser-facing when the app's own Compose file sets an environment value to a LAN URL for it: `http://${DEVICE_DOMAIN_NAME}:<port>` (or `$DEVICE_DOMAIN_NAME`, `${DEVICE_HOSTNAME}.local`, `umbrel.local`). Ports the app never hands out stay LAN-only. When the owner turns on **Route this app's extra ports** on the app's card, each browser-facing port gets its own host, `<appId>-<port>-umbrel.<domain>` with the default pattern, and those values are rewritten to it (path kept). Variables that point at a container name, such as `S3_INTERNAL_ENDPOINT`, are not touched.

Only apps behind the app gateway get these changes. Variables the user set in the app's settings win over them. Variables that only exist in an `env_file` are not seen.

**Where it is written.** The values go into the app's generated Compose override, `docker-compose.umbrel-user-settings.yml` in the app's data directory, next to the user's custom environment. umbreld regenerates that file on every install, start, restart and update, so the values survive app store updates and disappear on the next start after the mode is turned off. Compose only applies environment when containers are created, so **affected apps need a restart** after the domain, the app pattern or an app's extra-port switch changes. Saving the settings lists the running apps that need one.

**Extra port hosts.** A port host goes straight to the app's published port, like a LAN request to that port. The `Host` header and path are passed through unchanged, because S3 presigned URLs sign both; this is also why each port gets a host instead of a path prefix on the app's host. WebSockets work. There is **no Umbrel login** on port hosts: the app's page calls them from another origin (a presigned upload, a cross-origin WebSocket), and those requests cannot carry the app host's `__Host-` login cookie, so a login wall would break exactly these requests. This matches the LAN, where these ports are open to anyone on the network, but on the remote domain they are open to the internet. That is why the switch is off by default and should only be turned on when the app protects those ports itself. Port hosts also follow the app's own allow decision: if the app is blocked on the remote domain, so are its ports. Turning the switch off closes open WebSockets on its hosts.

For example, lobe-chat (main port `7455`) with the mode on for `example.com` and its extra ports allowed gets:

| Variable | LAN value | With remote domain mode |
| --- | --- | --- |
| `AUTH_TRUSTED_ORIGINS` | `http://${DEVICE_DOMAIN_NAME}:7455` | `http://${DEVICE_DOMAIN_NAME}:7455,https://lobe-chat-umbrel.example.com` |
| `S3_ENDPOINT` | `http://${DEVICE_DOMAIN_NAME}:7458` | `https://lobe-chat-7458-umbrel.example.com` |
| `AGENT_GATEWAY_URL` | `http://${DEVICE_DOMAIN_NAME}:7459` | `https://lobe-chat-7459-umbrel.example.com` |

`APP_URL` (the main port), the internal endpoints and the unreferenced device gateway port `7460` are left alone. Because the rewritten URLs are public, LAN browsers use them too while the mode is on. Without the extra-port switch, lobe-chat only gets the trusted origin, which fixes sign-in.

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

## Security on the remote domain

The remote domain is reachable from the whole internet, so some behaviour there is stricter than on the LAN. LAN, IP, Tor and Tailscale requests keep upstream behaviour unless noted.

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

Signed-in users see the normal account list. On the LAN everything works as upstream.

### Public app paths

Some app manifests mark paths as public (`PROXY_AUTH_WHITELIST`), so they skip Umbrel login. Those lists were written for the LAN. On the remote domain they would be open to the internet, so **they are ignored there by default** and every path needs Umbrel login.

If an app's clients need those paths (for example a mobile sync API), the owner can allow them for that app: each app card in the remote domain settings lists the app's public paths with an **Allow public paths on the remote domain** switch (off by default) and a warning. The manifest's blacklist (`PROXY_AUTH_BLACKLIST`) still applies. LAN behaviour is unchanged.

### Headers

- The login page's CSP `form-action` never falls back to a wildcard on remote hosts.
- Responses from the dashboard server send `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

The settings page warns the owner when 2FA is off. Turning on 2FA for every account is strongly recommended.

## Known limits

- Apps without an app gateway, and non-HTTP ports, are not routed on the remote domain.
- If an app doesn't work on the remote domain, turn on Umbrel's login in that app's settings. Apps with the login off are blocked remotely unless you allow them in the settings panel.
- Home-screen shortcuts, widgets and the MCP `get_app_details` URL still use port URLs.
- `X-Forwarded-For` is only used to find the client address for login throttling. The secure context comes from the proxy → :443 hop being HTTPS, not from `X-Forwarded-Proto`.
- Login throttling state is kept in memory, so it resets when umbreld restarts.
- Upstream apps see a LAN `Host`/`Origin`/`Referer`. Apps that build absolute URLs in page bodies from the raw `Host` (instead of `X-Forwarded-Host`) produce LAN URLs; redirects are fixed up, page bodies are not. Use the per-app override for such apps.
- Extra ports are only routed when the app's Compose file hands them out as a `${DEVICE_DOMAIN_NAME}`-style LAN URL and the owner allowed them, and only after the app restarts. Ports an app only mentions in an `env_file`, in its own settings or in page bodies stay LAN-only.
- Port hosts have no Umbrel login (see [App environment and extra ports](#app-environment-and-extra-ports)).
