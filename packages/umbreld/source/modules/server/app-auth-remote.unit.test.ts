import type express from 'express'
import {describe, expect, test, vi} from 'vitest'

// app-auth.ts imports the full daemon graph. Stub native modules that are not
// needed here so this file also runs on machines without a native toolchain.
vi.mock('drivelist', () => ({default: {list: async () => []}, list: async () => []}))
vi.mock('node-pty', () => ({default: {}, spawn: () => {}}))

import {resolveRemoteDomain, type RemoteDomain} from '../lan-ingress/remote-domain.js'
import {appHandoffFormAction, createHandoffResponse, parseAppAuthRequest} from './app-auth.js'

const remote = resolveRemoteDomain({enabled: true, baseDomain: 'example.com'})!

function fakeUmbreld(remoteDomain: RemoteDomain | undefined, routedApps = ['nextcloud']) {
	return {
		lanIngress: {
			remoteDomain,
			remoteAppOrigin: (appId: string) =>
				remoteDomain && routedApps.includes(appId) ? `https://${appId}-umbrel.${remoteDomain.baseDomain}` : undefined,
		},
		apps: {
			getApp: () => ({
				readManifest: async () => ({port: 8080}),
				readHiddenService: async () => 'abc.onion',
			}),
		},
		auth: {issueAppHandoff: vi.fn(async () => 'handoff-token')},
	} as never
}

function fakeRequest(hostname: string, query: Record<string, string>, protocol = 'https') {
	return {hostname, protocol, query} as unknown as express.Request
}

const remoteQuery = {origin: 'remote', app: 'nextcloud', path: '/files'}

describe('remote app auth requests', () => {
	test('accepts the remote origin only on the configured auth host', () => {
		expect(parseAppAuthRequest(fakeUmbreld(remote), fakeRequest('umbrel-auth.example.com', remoteQuery))).toEqual({
			appId: 'nextcloud',
			origin: 'remote',
			redirectPath: '/files',
		})
		for (const host of ['umbrel.example.com', '192.168.1.10', 'evil.com', 'umbrel-auth.example.com.evil.com']) {
			expect(() => parseAppAuthRequest(fakeUmbreld(remote), fakeRequest(host, remoteQuery))).toThrow(
				'Unsupported origin',
			)
		}
		expect(() =>
			parseAppAuthRequest(fakeUmbreld(undefined), fakeRequest('umbrel-auth.example.com', remoteQuery)),
		).toThrow('Unsupported origin')
	})

	test('sanitises the redirect path', () => {
		const request = fakeRequest('umbrel-auth.example.com', {...remoteQuery, path: 'https://evil.example//x'})
		expect(parseAppAuthRequest(fakeUmbreld(remote), request).redirectPath).toBe('/x')
	})

	test('hands off to the exact app origin from config', async () => {
		const response = await createHandoffResponse(
			fakeUmbreld(remote),
			fakeRequest('umbrel-auth.example.com', remoteQuery),
			'gateway-token',
		)
		expect(response).toEqual({
			url: 'https://nextcloud-umbrel.example.com/umbrel_/api/v1/auth/handoff',
			params: {r: '/files', handoff: 'handoff-token'},
		})
	})

	test('refuses a handoff for apps that are not routed on the remote domain', async () => {
		await expect(
			createHandoffResponse(
				fakeUmbreld(remote, []),
				fakeRequest('umbrel-auth.example.com', remoteQuery),
				'gateway-token',
			),
		).rejects.toThrow('not available on the remote domain')
	})

	test('keeps the host and port handoff for LAN requests', async () => {
		const response = await createHandoffResponse(
			fakeUmbreld(remote),
			fakeRequest('192.168.1.10', {origin: 'host', app: 'nextcloud', path: '/'}, 'http'),
			'gateway-token',
		)
		expect(response.url).toBe('http://192.168.1.10:8080/umbrel_/api/v1/auth/handoff')
	})

	test('limits form-action to the exact remote app origin', async () => {
		await expect(
			appHandoffFormAction(fakeUmbreld(remote), fakeRequest('umbrel-auth.example.com', remoteQuery)),
		).resolves.toBe('https://nextcloud-umbrel.example.com')
		// Wrong host, unrouted app, or mode off: no extra source beyond 'self'.
		await expect(
			appHandoffFormAction(fakeUmbreld(remote), fakeRequest('umbrel.example.com', remoteQuery)),
		).resolves.toBeUndefined()
		await expect(
			appHandoffFormAction(fakeUmbreld(remote, []), fakeRequest('umbrel-auth.example.com', remoteQuery)),
		).resolves.toBeUndefined()
		await expect(
			appHandoffFormAction(fakeUmbreld(undefined), fakeRequest('umbrel-auth.example.com', remoteQuery)),
		).resolves.toBeUndefined()
	})

	test('keeps the existing LAN form-action', async () => {
		await expect(
			appHandoffFormAction(
				fakeUmbreld(remote),
				fakeRequest('192.168.1.10', {origin: 'host', app: 'nextcloud'}, 'http'),
			),
		).resolves.toBe('http://192.168.1.10:*')
	})
})
