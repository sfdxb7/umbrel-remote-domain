import {appPortRemoteHost, appRemoteOrigin, remoteAppPortsAllowed, type RemoteDomain} from './remote-domain.js'

// Environment an app needs to work on its remote host. The app gateway makes
// requests look like LAN requests, but two things live in the app's own
// config, not in headers:
// - Origin allow lists. A login form that posts its own callback URL (Better
//   Auth's callbackURL, for example) is checked against these.
// - LAN URLs to the app's other published ports, which the app hands to the
//   browser (an S3 endpoint for uploads, a WebSocket gateway).
// umbreld writes the result into the app's generated Compose override, so it
// applies on the app's next start and survives app store updates.
// See docs/remote-domain.md.

type ComposeLike = {services?: Record<string, unknown> | null} | null | undefined

// Comma separated origin allow lists. The app's remote origin is appended.
export const TRUSTED_ORIGIN_ENV_NAMES = [
	'AUTH_TRUSTED_ORIGINS',
	'BETTER_AUTH_TRUSTED_ORIGINS',
	'AUTH_ADDITIONAL_TRUSTED_ORIGINS',
	'CSRF_TRUSTED_ORIGINS',
]

// http://<LAN host>:<port> as written in app store Compose files.
const LAN_PORT_URL =
	/^http:\/\/(?:\$\{DEVICE_DOMAIN_NAME\}|\$DEVICE_DOMAIN_NAME|\$\{DEVICE_HOSTNAME\}\.local|umbrel\.local):(\d{1,5})(?=[/?#]|$)/

function serviceEntries(compose: ComposeLike) {
	return Object.entries(compose?.services ?? {}).flatMap(([name, service]) =>
		service && typeof service === 'object'
			? [[name, service as {environment?: unknown; ports?: unknown}] as const]
			: [],
	)
}

// String values of a service's `environment`, in map or list form.
export function serviceEnvironment(service: {environment?: unknown}) {
	const environment = new Map<string, string>()
	const raw = service.environment
	if (Array.isArray(raw)) {
		for (const entry of raw) {
			if (typeof entry !== 'string') continue
			const separator = entry.indexOf('=')
			if (separator > 0) environment.set(entry.slice(0, separator), entry.slice(separator + 1))
		}
	} else if (raw && typeof raw === 'object') {
		for (const [name, value] of Object.entries(raw)) {
			if (typeof value === 'string') environment.set(name, value)
		}
	}
	return environment
}

// Where each published TCP host port lands: the Compose service and its
// container port. The host port only exists on the Docker host, which umbreld
// may not share (umbreld in a container), so remote routes dial the service's
// container on its container port instead, like the app gateway does.
export type PublishedPortTarget = {service: string; containerPort: number}

export function publishedPortTargets(compose: ComposeLike) {
	const targets = new Map<number, PublishedPortTarget>()
	for (const [name, service] of serviceEntries(compose)) {
		if (!Array.isArray(service.ports)) continue
		for (const entry of service.ports) {
			// A bare container port ("80" or 80) gets a random host port, so only
			// HOST:CONTAINER and IP:HOST:CONTAINER entries name a published port.
			let published: unknown
			let target: unknown
			if (typeof entry === 'string') {
				if (/\/udp$/i.test(entry.trim())) continue
				const parts = entry
					.trim()
					.replace(/\/tcp$/i, '')
					.split(':')
				if (parts.length > 1) [published, target] = parts.slice(-2)
			} else if (entry && typeof entry === 'object' && 'published' in entry) {
				if ('protocol' in entry && entry.protocol === 'udp') continue
				published = entry.published
				target = 'target' in entry ? entry.target : undefined
			}
			const port = Number(published)
			const containerPort = Number(target)
			if (!isPort(port) || targets.has(port)) continue
			// Ranges ("8000-8001:8000-8001") are not a single upstream.
			targets.set(port, {service: name, containerPort: isPort(containerPort) ? containerPort : 0})
		}
	}
	return targets
}

function isPort(port: number) {
	return Number.isInteger(port) && port > 0 && port <= 65_535
}

// Host ports the app publishes over TCP.
export function publishedTcpPorts(compose: ComposeLike) {
	return new Set(publishedPortTargets(compose).keys())
}

// Published ports, other than the app's main port, that its own environment
// points the browser at with a LAN URL. Only these can get a remote host;
// ports the app never hands out (device or admin ports) stay LAN-only.
export function browserFacingPorts(compose: ComposeLike, mainPort: number) {
	const published = publishedTcpPorts(compose)
	published.delete(mainPort)
	const ports = new Set<number>()
	for (const [, service] of serviceEntries(compose)) {
		for (const value of serviceEnvironment(service).values()) {
			const port = Number(LAN_PORT_URL.exec(value)?.[1])
			if (published.has(port)) ports.add(port)
		}
	}
	return [...ports].sort((a, b) => a - b)
}

// The environment overrides for one app, by service. Empty when the mode is
// off or the app is not behind the app gateway (only gateway apps get a
// remote host). Values keep the app's own `${...}` references so Compose still
// interpolates them; callers must not escape them.
export function remoteAppEnvironment({
	remote,
	appId,
	compose,
	mainPort,
}: {
	remote: RemoteDomain | undefined
	appId: string
	compose: ComposeLike
	mainPort: number
}) {
	const overrides: Record<string, Record<string, string>> = {}
	if (!remote || !compose?.services?.app_proxy) return overrides
	const origin = appRemoteOrigin(remote, appId)
	if (!origin) return overrides
	const ports = new Set(remoteAppPortsAllowed(remote, appId) ? browserFacingPorts(compose, mainPort) : [])

	for (const [serviceName, service] of serviceEntries(compose)) {
		for (const [name, value] of serviceEnvironment(service)) {
			let next: string | undefined
			if (TRUSTED_ORIGIN_ENV_NAMES.includes(name)) {
				const origins = value.split(',').map((entry) => entry.trim())
				if (!origins.includes(origin)) next = value.trim() ? `${value},${origin}` : origin
			} else {
				const match = LAN_PORT_URL.exec(value)
				const port = Number(match?.[1])
				const host = match && ports.has(port) ? appPortRemoteHost(remote, appId, port) : undefined
				if (host) next = `https://${host}${value.slice(match![0].length)}`
			}
			if (next !== undefined) (overrides[serviceName] ??= {})[name] = next
		}
	}
	return overrides
}
