import http from 'node:http'
import net from 'node:net'
import {once} from 'node:events'

import {afterEach, describe, expect, test, vi} from 'vitest'

import {resolveRemoteDomain, type RemoteDomain} from '../lan-ingress/remote-domain.js'
import AppGateway, {remoteLoginRedirect} from './app-gateway.js'

const remote = resolveRemoteDomain({enabled: true, baseDomain: 'example.com'})!

describe('remoteLoginRedirect()', () => {
	test('sends the app host to the configured auth origin', () => {
		const url = new URL(remoteLoginRedirect(remote, 'nextcloud', 'nextcloud-umbrel.example.com', '/files?dir=/')!)
		expect(url.origin).toBe('https://umbrel-auth.example.com')
		expect(url.searchParams.get('origin')).toBe('remote')
		expect(url.searchParams.get('app')).toBe('nextcloud')
		expect(url.searchParams.get('path')).toBe('/files?dir=/')
	})

	test('sanitises the path it carries', () => {
		const url = new URL(remoteLoginRedirect(remote, 'nextcloud', 'nextcloud-umbrel.example.com', '//evil.example/x')!)
		expect(url.searchParams.get('path')).toBe('/x')
	})

	test('ignores other hosts so LAN, IP, Tor and Tailscale keep the port flow', () => {
		for (const host of ['192.168.1.10', 'umbrel.local', 'abc.onion', 'immich-umbrel.example.com', 'evil.com']) {
			expect(remoteLoginRedirect(remote, 'nextcloud', host, '/')).toBeUndefined()
		}
		expect(remoteLoginRedirect(undefined, 'nextcloud', 'nextcloud-umbrel.example.com', '/')).toBeUndefined()
	})
})

describe('app gateway login redirect', () => {
	const servers: AppGateway[] = []

	afterEach(async () => {
		await Promise.all(
			servers.splice(0).map((gateway) => new Promise<void>((resolve) => gateway.server.close(() => resolve()))),
		)
	})

	async function startGateway(getRemoteDomain: () => RemoteDomain | undefined) {
		const umbreld = {
			logger: {error: vi.fn()},
			dataDirectory: '/does-not-exist',
			auth: {
				appAccessRevision: 0,
				authenticate: vi.fn(async () => {
					throw new Error('unauthenticated')
				}),
				authorizeApp: vi.fn(),
			},
		}
		const gateway = new AppGateway(
			umbreld as never,
			{
				appId: 'nextcloud',
				appName: 'Nextcloud',
				appIcon: 'https://example.com/icon.svg',
				targetProtocol: 'http',
				targetHost: 'nextcloud_web_1',
				targetAddress: '127.0.0.1',
				targetPort: 1,
				auth: true,
				authWhitelist: [],
				authBlacklist: [],
				trustUpstream: false,
				timeout: 100,
			},
			{getRemoteDomain},
		)
		servers.push(gateway)
		await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve))
		const address = gateway.server.address()
		if (!address || typeof address === 'string') throw new Error('Gateway did not listen on TCP')
		return `http://127.0.0.1:${address.port}`
	}

	// LAN ingress forwards the browser Host as X-Forwarded-Host and the
	// listener protocol as X-Forwarded-Proto.
	const forwarded = (host: string, proto = 'https') => ({'x-forwarded-host': host, 'x-forwarded-proto': proto})

	test('redirects remote app hosts to the auth host from config', async () => {
		const origin = await startGateway(() => remote)
		const response = await fetch(`${origin}/apps/files?x=1`, {
			redirect: 'manual',
			headers: forwarded('nextcloud-umbrel.example.com'),
		})
		expect(response.status).toBe(302)
		const location = new URL(response.headers.get('location')!)
		expect(location.origin).toBe('https://umbrel-auth.example.com')
		expect(location.searchParams.get('origin')).toBe('remote')
		expect(location.searchParams.get('path')).toBe('/apps/files?x=1')
	})

	test('keeps the port based redirect for LAN hosts while remote mode is on', async () => {
		const origin = await startGateway(() => remote)
		const response = await fetch(`${origin}/`, {redirect: 'manual', headers: forwarded('192.168.1.10:8080', 'http')})
		expect(response.status).toBe(302)
		const location = new URL(response.headers.get('location')!)
		expect(location.origin).toBe('http://192.168.1.10:2000')
		expect(location.searchParams.get('origin')).toBe('host')
	})

	test('keeps the port based redirect when remote mode is off', async () => {
		const origin = await startGateway(() => undefined)
		const response = await fetch(`${origin}/`, {
			redirect: 'manual',
			headers: forwarded('nextcloud-umbrel.example.com'),
		})
		const location = new URL(response.headers.get('location')!)
		expect(location.origin).toBe('https://nextcloud-umbrel.example.com:2000')
		expect(location.searchParams.get('origin')).toBe('host')
	})
})

describe('app gateway remote Origin/Referer rewrite', () => {
	const closers: Array<() => Promise<void>> = []
	afterEach(async () => {
		await Promise.all(closers.splice(0).map((close) => close()))
	})

	const close = (server: http.Server) => () =>
		new Promise<void>((resolve) => {
			server.closeAllConnections?.()
			server.close(() => resolve())
		})

	// Upstream app that echoes the headers it received, for HTTP and upgrades.
	async function startUpstream() {
		const seen: http.IncomingHttpHeaders[] = []
		const upstream = http.createServer((request, response) => {
			seen.push(request.headers)
			response.end('ok')
		})
		upstream.on('upgrade', (request, socket) => {
			seen.push(request.headers)
			socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
		})
		upstream.listen(0, '127.0.0.1')
		await once(upstream, 'listening')
		closers.push(close(upstream))
		return {port: (upstream.address() as net.AddressInfo).port, seen}
	}

	async function startGateway(targetPort: number, getRemoteDomain: () => RemoteDomain | undefined) {
		const umbreld = {
			logger: {error: vi.fn()},
			dataDirectory: '/does-not-exist',
			auth: {appAccessRevision: 0, authenticate: vi.fn(), authorizeApp: vi.fn(), registerAppSocket: vi.fn(() => true)},
		}
		const gateway = new AppGateway(
			umbreld as never,
			{
				appId: 'agent-zero',
				appName: 'Agent Zero',
				appIcon: 'https://example.com/icon.svg',
				targetProtocol: 'http',
				targetHost: 'agent-zero_web_1',
				targetAddress: '127.0.0.1',
				targetPort,
				auth: false,
				authWhitelist: [],
				authBlacklist: [],
				trustUpstream: false,
				timeout: 1000,
			},
			{getRemoteDomain, getLanOrigin: () => 'http://umbrel.local:3015'},
		)
		gateway.server.listen(0, '127.0.0.1')
		await once(gateway.server, 'listening')
		closers.push(close(gateway.server))
		return (gateway.server.address() as net.AddressInfo).port
	}

	const remoteHost = 'agent-zero-umbrel.example.com'
	const remoteHeaders = (extra: Record<string, string> = {}) => ({
		host: remoteHost,
		'x-forwarded-host': remoteHost,
		'x-forwarded-proto': 'https',
		...extra,
	})

	function get(port: number, headers: Record<string, string>) {
		return new Promise<void>((resolve, reject) => {
			http
				.get({host: '127.0.0.1', port, path: '/api/chat?x=1', headers}, (response) => {
					response.resume()
					response.on('end', resolve)
				})
				.on('error', reject)
		})
	}

	function upgrade(port: number, headers: Record<string, string>) {
		return new Promise<void>((resolve, reject) => {
			const request = http.request({
				host: '127.0.0.1',
				port,
				path: '/ws',
				headers: {...headers, connection: 'Upgrade', upgrade: 'websocket'},
			})
			request.on('upgrade', (_response, socket) => {
				socket.destroy()
				resolve()
			})
			request.on('response', () => reject(new Error('expected an upgrade')))
			request.on('error', reject)
			request.end()
		})
	}

	test('presents same-app Origin and Referer as the LAN origin', async () => {
		const upstream = await startUpstream()
		const port = await startGateway(upstream.port, () => remote)
		await get(port, remoteHeaders({origin: `https://${remoteHost}`, referer: `https://${remoteHost}/chat/1?tab=files`}))
		expect(upstream.seen[0]).toMatchObject({
			origin: 'http://umbrel.local:3015',
			referer: 'http://umbrel.local:3015/chat/1?tab=files',
			'x-forwarded-host': remoteHost,
			'x-forwarded-proto': 'https',
		})
	})

	test('rewrites the Origin of WebSocket upgrades too', async () => {
		const upstream = await startUpstream()
		const port = await startGateway(upstream.port, () => remote)
		await upgrade(port, remoteHeaders({origin: `https://${remoteHost}`}))
		expect(upstream.seen[0]).toMatchObject({
			origin: 'http://umbrel.local:3015',
			'x-forwarded-host': remoteHost,
			'x-forwarded-proto': 'https',
		})
	})

	test('never rewrites foreign or other app origins', async () => {
		const upstream = await startUpstream()
		const port = await startGateway(upstream.port, () => remote)
		await get(port, remoteHeaders({origin: 'https://evil.com', referer: 'https://evil.com/page'}))
		await upgrade(port, remoteHeaders({origin: 'https://immich-umbrel.example.com'}))
		expect(upstream.seen[0]).toMatchObject({origin: 'https://evil.com', referer: 'https://evil.com/page'})
		expect(upstream.seen[1]).toMatchObject({origin: 'https://immich-umbrel.example.com'})
	})

	test('leaves requests without Origin untouched', async () => {
		const upstream = await startUpstream()
		const port = await startGateway(upstream.port, () => remote)
		await get(port, remoteHeaders())
		expect(upstream.seen[0].origin).toBeUndefined()
		expect(upstream.seen[0].referer).toBeUndefined()
	})

	test('does not touch LAN requests or apps that opted out', async () => {
		const upstream = await startUpstream()
		const lanPort = await startGateway(upstream.port, () => remote)
		await get(lanPort, {
			host: 'umbrel.local:3015',
			'x-forwarded-host': 'umbrel.local:3015',
			'x-forwarded-proto': 'http',
			origin: `https://${remoteHost}`,
		})
		expect(upstream.seen[0].origin).toBe(`https://${remoteHost}`)

		const optedOut = resolveRemoteDomain({
			enabled: true,
			baseDomain: 'example.com',
			originRewriteDisabledApps: ['agent-zero'],
		})!
		const optedOutPort = await startGateway(upstream.port, () => optedOut)
		await get(optedOutPort, remoteHeaders({origin: `https://${remoteHost}`}))
		expect(upstream.seen[1]).toMatchObject({origin: `https://${remoteHost}`, 'x-forwarded-host': remoteHost})
	})
})

describe('app gateway public paths on the remote domain', () => {
	const closers: Array<() => Promise<void>> = []
	afterEach(async () => {
		await Promise.all(closers.splice(0).map((close) => close()))
	})

	async function listen(server: http.Server) {
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
		return (server.address() as net.AddressInfo).port
	}

	async function startGateway(remoteDomain: RemoteDomain | undefined) {
		const upstreamPort = await listen(http.createServer((_request, response) => response.end('upstream')))
		const umbreld = {
			logger: {error: vi.fn()},
			dataDirectory: '/does-not-exist',
			auth: {
				appAccessRevision: 0,
				authenticate: vi.fn(async () => {
					throw new Error('unauthenticated')
				}),
				authorizeApp: vi.fn(),
			},
		}
		const gateway = new AppGateway(
			umbreld as never,
			{
				appId: 'vaultwarden',
				appName: 'Vaultwarden',
				appIcon: 'https://example.com/icon.svg',
				targetProtocol: 'http',
				targetHost: 'vaultwarden_server_1',
				targetAddress: '127.0.0.1',
				targetPort: upstreamPort,
				auth: true,
				authWhitelist: ['/api/*', '/identity/*'],
				authBlacklist: ['/api/admin'],
				trustUpstream: false,
				timeout: 1_000,
			},
			{getRemoteDomain: () => remoteDomain},
		)
		const port = await listen(gateway.server)
		return `http://127.0.0.1:${port}`
	}

	const get = (origin: string, path: string, host: string) =>
		fetch(`${origin}${path}`, {
			redirect: 'manual',
			headers: {'x-forwarded-host': host, 'x-forwarded-proto': 'https'},
		})

	test('ignores PROXY_AUTH_WHITELIST on the remote host by default', async () => {
		const origin = await startGateway(remote)
		const response = await get(origin, '/api/sync', 'vaultwarden-umbrel.example.com')
		expect(response.status).toBe(302)
		expect(new URL(response.headers.get('location')!).origin).toBe('https://umbrel-auth.example.com')
	})

	test('honours it remotely once the owner allows the app', async () => {
		const allowed = resolveRemoteDomain({
			enabled: true,
			baseDomain: 'example.com',
			allowPublicPathApps: ['vaultwarden'],
		})!
		const origin = await startGateway(allowed)
		const response = await get(origin, '/identity/connect/token', 'vaultwarden-umbrel.example.com')
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('upstream')
		// The blacklist and non-public paths still need Umbrel login
		expect((await get(origin, '/api/admin', 'vaultwarden-umbrel.example.com')).status).toBe(302)
		expect((await get(origin, '/vault', 'vaultwarden-umbrel.example.com')).status).toBe(302)
	})

	test('keeps upstream behaviour on the LAN and when the mode is off', async () => {
		for (const remoteDomain of [remote, undefined]) {
			const origin = await startGateway(remoteDomain)
			const lan = await get(origin, '/api/sync', '192.168.1.10:8080')
			expect(lan.status).toBe(200)
			expect(await lan.text()).toBe('upstream')
		}
		const off = await startGateway(undefined)
		expect((await get(off, '/api/sync', 'vaultwarden-umbrel.example.com')).status).toBe(200)
	})
})
