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
3. Optional: the **Advanced** section holds the dashboard subdomain (`umbrel`), auth subdomain (`umbrel-auth`), app subdomain template (`{app}-umbrel`) and the Origin rewrite opt-out. The defaults are fine for most setups.
4. Optional: allow individual apps that have Umbrel login turned off (see below).

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

Some apps only accept requests whose `Origin` matches the LAN URL they expect, and reject `https://<app>-umbrel.example.com`. For remote-domain requests that have passed Umbrel app login (or that come from an app the owner allowed without login), the app gateway:

- rewrites `Origin: https://<appId>-umbrel.<domain>` to `http://<device hostname>.local:<app port>` (`umbrel.local` by default), for HTTP requests and WebSocket upgrades;
- rewrites a `Referer` on that same origin to the LAN origin, keeping its path and query;
- sets `X-Forwarded-Host: <appId>-umbrel.<domain>` and `X-Forwarded-Proto: https`.

Only an exact match on the app's own remote origin is rewritten. Foreign origins and other apps' origins reach the app unchanged, so the app's own cross-origin protection still works. Requests with no `Origin` are left alone. `Host` is **not** rewritten, so apps that build absolute URLs from `Host` keep producing remote URLs. LAN, IP and Tailscale requests are never rewritten.

**Per-app override.** An app that compares `Origin` with `Host` (some WebSocket servers do this by default) will see them differ after the rewrite. For such apps, add the app ID under **Advanced → Send the original Origin header to these apps**, or over tRPC with `originRewriteDisabledApps: ["some-app"]`. Those apps still get `X-Forwarded-Host`/`X-Forwarded-Proto`, but their `Origin` and `Referer` pass through unchanged.

## Reverse proxy requirements

Any reverse proxy or tunnel works if it:

1. **Terminates TLS** for `umbrel.<domain>`, `umbrel-auth.<domain>` and `*-umbrel.<domain>`. The default names are all one level below the base domain, so a single wildcard certificate for `*.<domain>` covers them.
2. **Forwards to umbreld's port 443 over HTTPS** and **skips upstream certificate verification**. umbreld presents its own local-CA certificate, which does not match the public name.
3. **Passes the original `Host` header through.**
4. Supports WebSockets (the dashboard and many apps use them).

DNS: point a wildcard record `*.<domain>` (or `umbrel`, `umbrel-auth` plus one record per app) at the proxy. Unknown hosts under the base domain get a 404 from umbreld, so a wildcard record is safe. Restrict the proxy rule to the hosts above if other services share the domain.

## Exposure

- Only the reverse proxy should be able to reach umbreld's port 443. Do not expose ports 80, 443 or 2000 to the internet directly.
- App ports (for example `8085`) are published directly and bypass this mode. Block them at the firewall and use LAN or Tailscale for port access.
- umbreld does not rate-limit login attempts in this mode. Add rate limiting at the proxy for `POST /trpc/user.login*` on the dashboard host and `POST /v1/account/login*` on the auth host. Consider turning on 2FA for every account.

## Known limits

- HSTS is not sent by umbreld. Enable it at the proxy if you want it.
- Apps without an app gateway, and non-HTTP ports, are not routed on the remote domain.
- App paths that an app's manifest whitelists from Umbrel login stay public on its remote host, same as on the LAN.
- Home-screen shortcuts, widgets and the MCP `get_app_details` URL still use port URLs.
- umbreld does not trust `X-Forwarded-*` headers from the proxy. The secure context comes from the proxy → :443 hop being HTTPS.
- Upstream apps see a LAN `Origin`/`Referer` with the remote `Host` (see the per-app override above).
