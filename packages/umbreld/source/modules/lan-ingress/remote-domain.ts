import net from 'node:net'

// Opt-in "remote domain" mode: umbrelOS sits behind a TLS-terminating reverse
// proxy on a public domain. App-gateway apps get their own host,
// `<appId>-umbrel.<domain>` by default, and app login runs on a dedicated auth
// host. IP, LAN, mDNS and Tailscale access keep using ports. See
// docs/remote-domain.md.

export type RemoteDomainSettings = {
	enabled: boolean
	baseDomain: string
	dashboardSubdomain?: string
	authSubdomain?: string
	appSubdomainTemplate?: string
	// App ids whose Umbrel login is turned off, but which the owner explicitly
	// allows on the remote domain anyway.
	allowUnauthenticatedApps?: string[]
	// App ids that should receive the browser's original Host, Origin and
	// Referer headers instead of the LAN-equivalent ones (see remoteOriginRewrite).
	originRewriteDisabledApps?: string[]
	// App ids whose manifest-declared public paths (PROXY_AUTH_WHITELIST) stay
	// public on the remote domain. Off for every app by default.
	allowPublicPathApps?: string[]
	// App ids whose browser-facing extra ports (see remote-app-environment.ts)
	// get their own hosts. Those hosts skip Umbrel's login, like the LAN ports.
	allowAppPortApps?: string[]
	// Reverse proxies whose X-Forwarded-For (or clientIpHeader) umbreld trusts
	// for remote-domain requests, as IPs or CIDRs. Unset means loopback and
	// private networks, where a proxy on the same machine or network sits.
	trustedProxies?: string[]
	// Optional header a trusted proxy sets to the client IP, for example
	// X-Real-IP. Unset means the X-Forwarded-For chain is used.
	clientIpHeader?: string
}

export type RemoteDomain = {
	baseDomain: string
	dashboardHost: string
	authHost: string
	authOrigin: string
	appSubdomainTemplate: string
	allowUnauthenticatedApps: string[]
	originRewriteDisabledApps: string[]
	allowPublicPathApps: string[]
	allowAppPortApps: string[]
	trustedProxies: string[]
	clientIpHeader?: string
}

export const DEFAULT_DASHBOARD_SUBDOMAIN = 'umbrel'
export const DEFAULT_AUTH_SUBDOMAIN = 'umbrel-auth'
export const DEFAULT_APP_SUBDOMAIN_TEMPLATE = '{app}-umbrel'
export const APP_PLACEHOLDER = '{app}'
export const DEFAULT_TRUSTED_PROXIES = [
	'127.0.0.0/8',
	'::1/128',
	'10.0.0.0/8',
	'172.16.0.0/12',
	'192.168.0.0/16',
	'fc00::/7',
]

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const MAX_DOMAIN_LENGTH = 253
const RESERVED_TLDS = new Set(['local', 'onion', 'localhost', 'internal', 'invalid', 'test', 'example', 'home', 'lan'])

function isValidHostname(value: string) {
	if (value.length === 0 || value.length > MAX_DOMAIN_LENGTH) return false
	return value.split('.').every((label) => LABEL.test(label))
}

// Returns an error message, or undefined when the base domain is acceptable.
export function validateBaseDomain(value: string) {
	if (value !== value.trim()) return 'Domain must not contain spaces'
	if (value !== value.toLowerCase()) return 'Domain must be lowercase'
	if (/[/:@?#\s]/.test(value)) return 'Enter a bare domain such as example.com, without a scheme, port or path'
	if (net.isIP(value) || net.isIP(value.replace(/^\[|\]$/g, ''))) return 'IP addresses are not supported'
	if (!isValidHostname(value)) return 'Enter a valid domain such as example.com'
	const labels = value.split('.')
	if (labels.length < 2) return 'Enter a fully qualified domain such as example.com'
	if (RESERVED_TLDS.has(labels.at(-1)!)) return `.${labels.at(-1)} domains are not supported`
	if (/^\d+$/.test(labels.at(-1)!)) return 'Enter a valid domain such as example.com'
}

// A subdomain is one or more labels below the base domain.
export function validateSubdomain(value: string) {
	if (value !== value.toLowerCase()) return 'Subdomain must be lowercase'
	if (!isValidHostname(value)) return 'Enter a valid subdomain such as umbrel'
}

export function validateAppSubdomainTemplate(value: string) {
	if (value !== value.toLowerCase()) return 'App subdomain pattern must be lowercase'
	if (value.split(APP_PLACEHOLDER).length !== 2)
		return `App subdomain pattern must contain ${APP_PLACEHOLDER} exactly once`
	// Use a representative app id to check the rest of the pattern.
	if (!isValidHostname(value.replace(APP_PLACEHOLDER, 'app')))
		return 'Enter a valid app subdomain pattern such as {app}-umbrel'
}

// An IP address or CIDR range such as 172.18.0.0/16.
export function validateTrustedProxy(value: string) {
	const [address, prefix, ...rest] = value.split('/')
	const family = net.isIP(address ?? '')
	if (!family || rest.length) return `Invalid trusted proxy ${value}`
	if (prefix === undefined) return
	const bits = Number(prefix)
	if (!/^\d+$/.test(prefix) || bits > (family === 4 ? 32 : 128)) return `Invalid trusted proxy ${value}`
}

export function validateClientIpHeader(value: string) {
	if (!/^[a-zA-Z0-9-]{1,64}$/.test(value)) return 'Enter a header name such as X-Real-IP'
	const name = value.toLowerCase()
	// Headers umbreld or the browser control; using them would be meaningless or spoofable.
	if (['host', 'cookie', 'authorization', 'x-forwarded-host', 'x-forwarded-proto'].includes(name)) {
		return `${value} cannot carry the client IP`
	}
}

export function validateRemoteDomainSettings(settings: RemoteDomainSettings) {
	const errors = [
		validateBaseDomain(settings.baseDomain),
		validateSubdomain(settings.dashboardSubdomain ?? DEFAULT_DASHBOARD_SUBDOMAIN),
		validateSubdomain(settings.authSubdomain ?? DEFAULT_AUTH_SUBDOMAIN),
		validateAppSubdomainTemplate(settings.appSubdomainTemplate ?? DEFAULT_APP_SUBDOMAIN_TEMPLATE),
		...(settings.trustedProxies ?? []).map(validateTrustedProxy),
		settings.clientIpHeader ? validateClientIpHeader(settings.clientIpHeader) : undefined,
	].filter(Boolean)
	if (errors.length) return errors[0]
	const dashboardHost = `${settings.dashboardSubdomain ?? DEFAULT_DASHBOARD_SUBDOMAIN}.${settings.baseDomain}`
	const authHost = `${settings.authSubdomain ?? DEFAULT_AUTH_SUBDOMAIN}.${settings.baseDomain}`
	if (dashboardHost === authHost) return 'Dashboard and auth subdomains must be different'
	for (const host of [dashboardHost, authHost]) {
		if (host.length > MAX_DOMAIN_LENGTH) return 'Domain is too long'
	}
}

// Resolve stored settings into exact hosts. Returns undefined when the mode is
// off or the stored settings are invalid, so a broken config never routes.
export function resolveRemoteDomain(settings: RemoteDomainSettings | undefined): RemoteDomain | undefined {
	if (!settings?.enabled) return
	const baseDomain = settings.baseDomain
	const dashboardSubdomain = settings.dashboardSubdomain ?? DEFAULT_DASHBOARD_SUBDOMAIN
	const authSubdomain = settings.authSubdomain ?? DEFAULT_AUTH_SUBDOMAIN
	const appSubdomainTemplate = settings.appSubdomainTemplate ?? DEFAULT_APP_SUBDOMAIN_TEMPLATE
	if (
		validateBaseDomain(baseDomain) ||
		validateSubdomain(dashboardSubdomain) ||
		validateSubdomain(authSubdomain) ||
		validateAppSubdomainTemplate(appSubdomainTemplate)
	) {
		return
	}
	const dashboardHost = `${dashboardSubdomain}.${baseDomain}`
	const authHost = `${authSubdomain}.${baseDomain}`
	if (dashboardHost === authHost) return
	return {
		baseDomain,
		dashboardHost,
		authHost,
		authOrigin: `https://${authHost}`,
		appSubdomainTemplate,
		allowUnauthenticatedApps: [...new Set(settings.allowUnauthenticatedApps ?? [])],
		originRewriteDisabledApps: [...new Set(settings.originRewriteDisabledApps ?? [])],
		allowPublicPathApps: [...new Set(settings.allowPublicPathApps ?? [])],
		allowAppPortApps: [...new Set(settings.allowAppPortApps ?? [])],
		trustedProxies: settings.trustedProxies?.length
			? settings.trustedProxies.filter((entry) => !validateTrustedProxy(entry))
			: DEFAULT_TRUSTED_PROXIES,
		...(settings.clientIpHeader && !validateClientIpHeader(settings.clientIpHeader)
			? {clientIpHeader: settings.clientIpHeader.toLowerCase()}
			: {}),
	}
}

// The exact remote host for an app, or undefined when the app id cannot form
// a valid DNS name or would collide with the dashboard or auth host.
export function appRemoteHost(remote: RemoteDomain, appId: string) {
	if (!/^[a-zA-Z0-9-]+$/.test(appId)) return
	const subdomain = remote.appSubdomainTemplate.replace(APP_PLACEHOLDER, appId.toLowerCase())
	if (validateSubdomain(subdomain)) return
	const host = `${subdomain}.${remote.baseDomain}`
	if (host.length > MAX_DOMAIN_LENGTH) return
	if (host === remote.dashboardHost || host === remote.authHost) return
	return host
}

export function appRemoteOrigin(remote: RemoteDomain, appId: string) {
	const host = appRemoteHost(remote, appId)
	return host ? `https://${host}` : undefined
}

// The host for one of an app's extra ports, `<appId>-<port>-umbrel.<domain>`
// with the default pattern. A port is all digits, so the last dash splits the
// app id from the port and two different (app, port) pairs never share a host.
export function appPortRemoteHost(remote: RemoteDomain, appId: string, port: number) {
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) return
	return appRemoteHost(remote, `${appId}-${port}`)
}

export type AppPortTarget = {appId: string; port: number}

// Build a host -> {appId, port} map for extra ports. An app's own host always
// wins, so an app whose id ends in a number never loses its host to a port.
export function buildAppPortHostMap(
	remote: RemoteDomain,
	appPorts: Array<[appId: string, ports: number[]]>,
	appHosts: Map<string, string>,
) {
	const hosts = new Map<string, AppPortTarget>()
	for (const [appId, ports] of appPorts) {
		for (const port of ports) {
			const host = appPortRemoteHost(remote, appId, port)
			if (host && !appHosts.has(host)) hosts.set(host, {appId, port})
		}
	}
	return hosts
}

// Build a host -> appId map. Ids that collide case-insensitively are dropped
// rather than routed to whichever app happened to come first.
export function buildAppHostMap(remote: RemoteDomain, appIds: string[]) {
	const hosts = new Map<string, string>()
	const collisions = new Set<string>()
	for (const appId of appIds) {
		const host = appRemoteHost(remote, appId)
		if (!host) continue
		if (hosts.has(host) && hosts.get(host) !== appId) collisions.add(host)
		hosts.set(host, appId)
	}
	for (const host of collisions) hosts.delete(host)
	return hosts
}

// Lowercase the Host header and drop the port and a trailing dot. Returns
// undefined for anything that is not a plain DNS name, including IPs.
export function normaliseHostHeader(hostHeader: string | undefined) {
	if (!hostHeader) return
	let host = hostHeader.trim().toLowerCase()
	if (host.startsWith('[')) return // IPv6 literal
	const colon = host.indexOf(':')
	if (colon !== -1) {
		if (!/^\d+$/.test(host.slice(colon + 1))) return
		host = host.slice(0, colon)
	}
	if (host.endsWith('.')) host = host.slice(0, -1)
	if (net.isIP(host) || !isValidHostname(host)) return
	return host
}

export type RemoteHostMatch =
	| {type: 'outside'}
	| {type: 'dashboard'}
	| {type: 'auth'}
	| {type: 'app'; appId: string}
	| ({type: 'port'} & AppPortTarget)
	| {type: 'unknown'}

// Classify a request by its Host header. Hosts outside the base domain keep
// today's behaviour. Hosts inside it only match exactly; anything else under
// the domain (including the bare domain) is unknown and must get a 404.
export function matchRemoteHost(
	remote: RemoteDomain | undefined,
	appHosts: Map<string, string>,
	hostHeader: string | undefined,
	portHosts?: Map<string, AppPortTarget>,
): RemoteHostMatch {
	if (!remote) return {type: 'outside'}
	const host = normaliseHostHeader(hostHeader)
	if (!host) return {type: 'outside'}
	if (host !== remote.baseDomain && !host.endsWith(`.${remote.baseDomain}`)) return {type: 'outside'}
	if (host === remote.dashboardHost) return {type: 'dashboard'}
	if (host === remote.authHost) return {type: 'auth'}
	const appId = appHosts.get(host)
	if (appId) return {type: 'app', appId}
	const port = portHosts?.get(host)
	if (port) return {type: 'port', ...port}
	return {type: 'unknown'}
}

// The URL the app gateway sends an unauthenticated browser to. Built only from
// config: the Host header and request protocol are never reflected.
export function remoteAppAuthUrl(remote: RemoteDomain, appId: string, path: string) {
	const searchParams = new URLSearchParams({origin: 'remote', app: appId, path})
	return `${remote.authOrigin}/app-auth?${searchParams}`
}

// Shared check for the `origin=remote` login flow on the auth host.
export function isRemoteAuthRequest(remote: RemoteDomain | undefined, hostname: string | undefined) {
	if (!remote || !hostname) return false
	return normaliseHostHeader(hostname) === remote.authHost
}

export function isUnderBaseDomain(remote: RemoteDomain, hostname: string) {
	const host = normaliseHostHeader(hostname)
	return !!host && (host === remote.baseDomain || host.endsWith(`.${remote.baseDomain}`))
}

// Many apps check the browser Origin against the LAN addresses Umbrel hands
// them (for example http://umbrel.local:3015) and reject the remote host.
// Others require the Origin host to equal Host or X-Forwarded-Host. For a
// request that arrived on an app's own remote host, the gateway presents it the
// way a LAN browser would send it: Host becomes the LAN host and a same-app
// Origin/Referer the LAN origin, together, so both kinds of check pass.
// X-Forwarded-Host and X-Forwarded-Proto keep the public host and https for
// apps that build URLs from them. Returns undefined for every other host, so
// LAN, IP, Tor and Tailscale requests are never touched.
export function remoteOriginRewrite(
	remote: RemoteDomain | undefined,
	appId: string,
	hostHeader: string | undefined,
	lanOrigin: string | undefined,
) {
	if (!remote) return
	const remoteHost = appRemoteHost(remote, appId)
	if (!remoteHost || normaliseHostHeader(hostHeader) !== remoteHost) return
	const enabled = !!lanOrigin && !remote.originRewriteDisabledApps.includes(appId)
	return {remoteHost, remoteOrigin: `https://${remoteHost}`, lanOrigin: enabled ? lanOrigin : undefined}
}

// The origin a LAN browser uses for an app: http://<device>.local:<port>.
export function lanAppOrigin(hostname: string, port: number) {
	return `http://${hostname}:${port}`
}

function exactOrigin(value: string) {
	try {
		const url = new URL(value)
		if (url.username || url.password) return
		return url.origin
	} catch {
		return
	}
}

// Rewrite Origin and Referer only when they name exactly this app's remote
// origin. Foreign origins, other apps' origins, "null" and missing headers are
// returned unchanged so the app still rejects real cross-site requests.
export function rewriteRemoteOriginHeaders(
	headers: {origin?: string | string[]; referer?: string | string[]},
	remoteOrigin: string,
	lanOrigin: string,
) {
	const result: {origin?: string; referer?: string} = {}
	const {origin, referer} = headers
	if (typeof origin === 'string' && /^https:\/\/[^/?#]+$/i.test(origin) && exactOrigin(origin) === remoteOrigin) {
		result.origin = lanOrigin
	}
	if (typeof referer === 'string' && exactOrigin(referer) === remoteOrigin) {
		const url = new URL(referer)
		result.referer = `${lanOrigin}${url.pathname}${url.search}`
	}
	return result
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]'])

function isPrivateOrLoopbackIp(hostname: string) {
	const host = hostname.replace(/^\[|\]$/g, '')
	if (net.isIPv4(host)) {
		const [a, b] = host.split('.').map(Number) as [number, number]
		return (
			a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
		)
	}
	if (net.isIPv6(host)) return host === '::1' || /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host)
	return false
}

export type LocalAppAddress = {
	// The origin a LAN browser uses for the app, e.g. http://umbrel.local:3015.
	lanOrigin?: string
	// Where the gateway reaches the app, e.g. agent-zero_web_1:80.
	targetHost: string
	targetAddress?: string
	targetPort: number
}

function lanNames(local: LocalAppAddress) {
	if (!local.lanOrigin) return new Set<string>()
	const hostname = new URL(local.lanOrigin).hostname.toLowerCase()
	return new Set([hostname, hostname.replace(/\.local$/, '')])
}

function targetNames(local: LocalAppAddress) {
	const names = new Set([local.targetHost.toLowerCase(), ...LOOPBACK_HOSTS])
	if (local.targetAddress) names.add(hostWithBrackets(local.targetAddress.toLowerCase()))
	return names
}

function hostWithBrackets(host: string) {
	return net.isIPv6(host) ? `[${host}]` : host
}

// Whether a URL points at the app itself through one of its local addresses:
// the LAN hostname (with or without .local), a private or loopback IP or
// localhost on the app's LAN port, or the container host, its address,
// loopback or the wildcard address on its internal port. The LAN hostname on
// any other port is another app and does not match.
export function isLocalAppUrl(url: URL, local: LocalAppAddress) {
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
	if (url.username || url.password) return false
	const host = url.hostname.toLowerCase()
	const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
	const lanPort = local.lanOrigin ? Number(new URL(local.lanOrigin).port || 80) : undefined
	if (port === lanPort && (lanNames(local).has(host) || LOOPBACK_HOSTS.has(host) || isPrivateOrLoopbackIp(host))) {
		return true
	}
	return port === local.targetPort && targetNames(local).has(host)
}

// Rewrite a response URL (Location, Refresh) that points at the app's local
// address to the same path on its remote origin. Relative and foreign URLs
// are returned unchanged.
export function rewriteLocalAppUrl(value: string, local: LocalAppAddress, remoteOrigin: string) {
	if (!/^(?:https?:)?\/\//i.test(value.trim())) return value
	let url: URL
	try {
		url = new URL(value.trim(), 'http://placeholder.invalid')
	} catch {
		return value
	}
	if (!isLocalAppUrl(url, local)) return value
	return `${remoteOrigin}${url.pathname}${url.search}${url.hash}`
}

// Refresh: 0; url=http://umbrel.local:7455/signin
export function rewriteLocalRefresh(value: string, local: LocalAppAddress, remoteOrigin: string) {
	const match = /^(\s*[\d.]*\s*[;,]\s*url\s*=\s*)(['"]?)(.*?)\2(\s*)$/i.exec(value)
	if (!match) return value
	const [, prefix, quote, url, suffix] = match
	return `${prefix}${quote}${rewriteLocalAppUrl(url!, local, remoteOrigin)}${quote}${suffix}`
}

// Drop a Set-Cookie Domain attribute that names a local hostname, so the
// cookie becomes host-only on the remote host instead of being rejected by
// the browser.
export function stripLocalCookieDomain(cookie: string, local: LocalAppAddress) {
	return cookie.replace(/;\s*domain\s*=\s*([^;]*)/gi, (attribute, domain: string) => {
		const host = hostWithBrackets(domain.trim().toLowerCase().replace(/^\./, ''))
		const isLocal = lanNames(local).has(host) || targetNames(local).has(host) || isPrivateOrLoopbackIp(host)
		return isLocal ? '' : attribute
	})
}

// True for any request whose Host is the base domain or below it. Such
// requests came through the public reverse proxy (or look like they did), so
// they get the stricter remote behaviour. LAN, IP, mDNS, Tor and Tailscale
// hosts never match.
export function isRemoteDomainRequest(remote: RemoteDomain | undefined, hostname: string | undefined) {
	return !!remote && !!hostname && isUnderBaseDomain(remote, hostname)
}

// Whether an app's manifest-declared public paths stay public on its remote
// host. Off unless the owner allowed it for this app.
export function remotePublicPathsAllowed(remote: RemoteDomain, appId: string) {
	return remote.allowPublicPathApps.includes(appId)
}

// Whether an app's browser-facing extra ports get remote hosts. Off unless the
// owner allowed it for this app.
export function remoteAppPortsAllowed(remote: RemoteDomain, appId: string) {
	return remote.allowAppPortApps.includes(appId)
}
