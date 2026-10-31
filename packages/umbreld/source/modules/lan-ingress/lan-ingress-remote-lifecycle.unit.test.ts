import http from 'node:http'
import net from 'node:net'
import {once} from 'node:events'

import Emittery from 'emittery'
import {afterEach, describe, expect, test, vi} from 'vitest'

const {execaDollar} = vi.hoisted(() => ({execaDollar: vi.fn(() => vi.fn(async () => ({exitCode: 0, stdout: ''})))}))
vi.mock('execa', () => ({$: execaDollar}))

import LanIngress from './lan-ingress.js'
import type {RemoteDomainSettings} from './remote-domain.js'

type Internals = {
	remoteGatewayAppIds(): string[]
	remoteAppAuth(appId: string): boolean | undefined
	updateRemoteAppHosts(): void
	remoteDispatchFor(host: string, protocol: 'https'): unknown
	remoteAppBrowserPorts(appId: string): number[]
	handleRemoteRequest(
		request: http.IncomingMessage,
		response: http.ServerResponse,
		protocol: 'https',
		upstreamPort: number,
	): boolean
	handleRemoteUpgrade(request: http.IncomingMessage, socket: net.Socket, head: Buffer, protocol: 'https'): boolean
}

// Remote routing has to follow app installs, updates, restarts and uninstalls
// on its own, without the owner toggling the mode off and on.
describe('LAN ingress remote routes follow the app lifecycle', () => {
	const ingresses: LanIngress[] = []
	afterEach(async () => {
		vi.useRealTimers()
		await Promise.all(ingresses.splice(0).map((ingress) => ingress.stop()))
	})

	const servers: http.Server[] = []
	const sockets = new Set<net.Socket>()
	afterEach(async () => {
		// Upgraded sockets are not closed by closeAllConnections().
		for (const socket of sockets) socket.destroy()
		sockets.clear()
		await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
	})

	async function listen(server: http.Server) {
		servers.push(server)
		server.on('connection', (socket) => sockets.add(socket))
		server.listen(0, '127.0.0.1')
		await once(server, 'listening')
		return (server.address() as net.AddressInfo).port
	}

	function createIngress(settings: RemoteDomainSettings | undefined) {
		const logger = {createChildLogger: () => logger, log: vi.fn(), error: vi.fn(), verbose: vi.fn()}
		const emitter = new Emittery()
		const emitted: string[] = []
		const eventBus = {
			on: emitter.on.bind(emitter),
			emit: vi.fn(async (event: string) => {
				emitted.push(event)
			}),
		}
		const store = {get: vi.fn(async () => settings)}
		const ingress = new LanIngress({dataDirectory: '/tmp', port: 80, logger, eventBus, store} as never)
		ingresses.push(ingress)
		let gatewayApps = ['nextcloud']
		const internals = ingress as unknown as Internals
		vi.spyOn(internals, 'remoteGatewayAppIds').mockImplementation(() => gatewayApps)
		vi.spyOn(internals, 'remoteAppAuth').mockImplementation((appId) => (gatewayApps.includes(appId) ? true : undefined))
		return {
			ingress,
			internals,
			emitter,
			emitted,
			setGatewayApps: (apps: string[]) => (gatewayApps = apps),
		}
	}

	const enabled = {enabled: true, baseDomain: 'example.com'}

	async function start(ingress: LanIngress) {
		// Skip the real refresh (certs, listeners, nftables); only the lifecycle
		// wiring is under test here.
		const refresh = vi.spyOn(ingress, 'refresh').mockResolvedValue()
		await ingress.start()
		await ingress.loadRemoteDomain()
		refresh.mockClear()
		return refresh
	}

	test('an app state change schedules one coalesced refresh while the mode is on', async () => {
		const {ingress, emitter} = createIngress(enabled)
		const refresh = await start(ingress)
		vi.useFakeTimers()
		await emitter.emit('apps:state:change', {appId: 'agent-zero', state: 'ready'})
		await emitter.emit('apps:state:change', {appId: 'agent-zero', state: 'running'})
		await emitter.emit('apps:settings:change', {appId: 'agent-zero'})
		expect(refresh).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(300)
		expect(refresh).toHaveBeenCalledTimes(1)
	})

	test('does not add refreshes while the mode is off', async () => {
		const {ingress, emitter} = createIngress({enabled: false, baseDomain: 'example.com'})
		const refresh = await start(ingress)
		vi.useFakeTimers()
		await emitter.emit('apps:state:change', {appId: 'agent-zero', state: 'ready'})
		await vi.advanceTimersByTimeAsync(300)
		expect(refresh).not.toHaveBeenCalled()
	})

	test('stops listening for app events once stopped', async () => {
		const {ingress, emitter} = createIngress(enabled)
		const refresh = await start(ingress)
		await ingress.stop()
		vi.useFakeTimers()
		await emitter.emit('apps:state:change', {appId: 'agent-zero', state: 'ready'})
		await vi.advanceTimersByTimeAsync(300)
		expect(refresh).not.toHaveBeenCalled()
	})

	test('routes a newly installed app and tells clients, without a toggle', async () => {
		const {ingress, internals, emitted, setGatewayApps} = createIngress(enabled)
		await start(ingress)
		emitted.length = 0
		expect(ingress.remoteAppOrigin('agent-zero')).toBeUndefined()

		// The gateway for the new app starts listening, then LAN ingress refreshes.
		setGatewayApps(['nextcloud', 'agent-zero'])
		internals.updateRemoteAppHosts()
		expect(ingress.remoteAppOrigin('agent-zero')).toBe('https://agent-zero-umbrel.example.com')
		expect(emitted).toEqual(['lan-ingress:remote-routes:change'])

		// A refresh with nothing new does not spam clients.
		internals.updateRemoteAppHosts()
		expect(emitted).toHaveLength(1)
	})

	test('stops routing an uninstalled app', async () => {
		const {ingress, internals, emitted, setGatewayApps} = createIngress(enabled)
		await start(ingress)
		expect(ingress.remoteAppOrigin('nextcloud')).toBe('https://nextcloud-umbrel.example.com')
		emitted.length = 0

		setGatewayApps([])
		internals.updateRemoteAppHosts()
		expect(ingress.remoteAppOrigin('nextcloud')).toBeUndefined()
		expect(internals.remoteDispatchFor('nextcloud-umbrel.example.com', 'https')).toMatchObject({
			type: 'reject',
			status: 404,
		})
		expect(emitted).toEqual(['lan-ingress:remote-routes:change'])
	})

	test('routes an opted-in extra port to its published port, with WebSockets, and closes them when it stops', async () => {
		// The app's published port: echoes what it received and accepts upgrades.
		const upstream = http.createServer((request, response) => {
			response.end(JSON.stringify({url: request.url, headers: request.headers}))
		})
		upstream.on('upgrade', (_request, socket) => {
			socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
		})
		const appPort = await listen(upstream)

		const settings = {...enabled, allowAppPortApps: ['nextcloud']}
		const {ingress, internals, setGatewayApps} = createIngress(settings)
		vi.spyOn(internals, 'remoteAppBrowserPorts').mockImplementation((appId) => (appId === 'nextcloud' ? [appPort] : []))
		await start(ingress)
		internals.updateRemoteAppHosts()
		const portHost = `nextcloud-${appPort}-umbrel.example.com`
		expect(ingress.remoteAppStatus()[0]).toMatchObject({
			appId: 'nextcloud',
			ports: [{port: appPort, origin: `https://${portHost}`}],
			portsAllowed: true,
		})

		// The front stands in for umbreld's HTTPS listener after TLS.
		const front = http.createServer((request, response) => {
			if (!internals.handleRemoteRequest(request, response, 'https', 0)) response.end('dashboard')
		})
		front.on('upgrade', (request, socket, head) => {
			if (!internals.handleRemoteUpgrade(request, socket as net.Socket, head, 'https')) socket.destroy()
		})
		const frontPort = await listen(front)

		const get = (host: string) =>
			new Promise<{status: number; body: string}>((resolve, reject) => {
				http
					.get({port: frontPort, path: '/lobe/a.png?X-Amz-Signature=abc', headers: {host}}, (response) => {
						let body = ''
						response.on('data', (chunk) => (body += chunk))
						response.on('end', () => resolve({status: response.statusCode!, body}))
					})
					.on('error', reject)
			})

		const {status, body} = await get(portHost)
		expect(status).toBe(200)
		const seen = JSON.parse(body)
		// Host and path reach the app as the browser sent them (S3 signs both).
		expect(seen.url).toBe('/lobe/a.png?X-Amz-Signature=abc')
		expect(seen.headers.host).toBe(portHost)
		expect(seen.headers['x-forwarded-proto']).toBe('https')
		expect(seen.headers['x-forwarded-for']).toBeUndefined()

		// A WebSocket upgrade goes through, and closes once the port stops being routed.
		const client = net.connect(frontPort, '127.0.0.1')
		await once(client, 'connect')
		client.write(`GET /ws HTTP/1.1\r\nHost: ${portHost}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`)
		const [handshake] = await once(client, 'data')
		expect(String(handshake)).toMatch(/^HTTP\/1\.1 101/)
		const closed = once(client, 'close')
		setGatewayApps([])
		internals.updateRemoteAppHosts()
		await closed
		expect((await get(portHost)).status).toBe(404)
	})

	test('does not route extra ports the owner did not allow', async () => {
		const {ingress, internals} = createIngress(enabled)
		vi.spyOn(internals, 'remoteAppBrowserPorts').mockImplementation(() => [7458])
		await start(ingress)
		internals.updateRemoteAppHosts()
		expect(ingress.remoteAppStatus()[0]).toMatchObject({
			ports: [{port: 7458, origin: 'https://nextcloud-7458-umbrel.example.com'}],
			portsAllowed: false,
		})
		expect(internals.remoteDispatchFor('nextcloud-7458-umbrel.example.com', 'https')).toMatchObject({
			type: 'reject',
			status: 404,
		})
	})
})
