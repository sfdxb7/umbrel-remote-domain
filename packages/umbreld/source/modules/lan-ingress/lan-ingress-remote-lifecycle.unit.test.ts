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
}

// Remote routing has to follow app installs, updates, restarts and uninstalls
// on its own, without the owner toggling the mode off and on.
describe('LAN ingress remote routes follow the app lifecycle', () => {
	const ingresses: LanIngress[] = []
	afterEach(async () => {
		vi.useRealTimers()
		await Promise.all(ingresses.splice(0).map((ingress) => ingress.stop()))
	})

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
})
