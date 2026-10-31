import type http from 'node:http'

import {describe, expect, test} from 'vitest'

import {resolveRemoteDomain} from '../lan-ingress/remote-domain.js'
import {isTrustedProxy, loginClientFromRequest, normaliseAddress, requestClientIp} from './client-ip.js'

const remote = resolveRemoteDomain({enabled: true, baseDomain: 'example.com'})!

function request(socket: string, headers: Record<string, string | string[]> = {}) {
	return {socket: {remoteAddress: socket}, headers} as unknown as http.IncomingMessage
}

// What umbreld sees for a dashboard request: LAN ingress connects over
// loopback and appends the peer it saw to X-Forwarded-For.
function viaIngress(peer: string, clientXff?: string, extra: Record<string, string> = {}) {
	return request('127.0.0.1', {'x-forwarded-for': clientXff ? `${clientXff}, ${peer}` : peer, ...extra})
}

describe('normaliseAddress()', () => {
	test('accepts IPv4, IPv6, bracketed and mapped addresses', () => {
		expect(normaliseAddress(' 203.0.113.5 ')).toBe('203.0.113.5')
		expect(normaliseAddress('::ffff:203.0.113.5')).toBe('203.0.113.5')
		expect(normaliseAddress('[2001:db8::1]')).toBe('2001:db8::1')
		expect(normaliseAddress('2001:db8::1')).toBe('2001:db8::1')
		expect(normaliseAddress('evil')).toBeUndefined()
		expect(normaliseAddress('203.0.113.5:1234')).toBeUndefined()
		expect(normaliseAddress(undefined)).toBeUndefined()
	})

	test('matches trusted proxy addresses and ranges', () => {
		expect(isTrustedProxy('172.18.0.2', remote.trustedProxies)).toBe(true)
		expect(isTrustedProxy('127.0.0.1', remote.trustedProxies)).toBe(true)
		expect(isTrustedProxy('fd00::1', remote.trustedProxies)).toBe(true)
		expect(isTrustedProxy('203.0.113.5', remote.trustedProxies)).toBe(false)
		expect(isTrustedProxy('198.51.100.7', ['198.51.100.7'])).toBe(true)
		expect(isTrustedProxy('198.51.100.8', ['198.51.100.7'])).toBe(false)
	})
})

describe('requestClientIp() on the LAN', () => {
	test('uses the peer LAN ingress saw and ignores client X-Forwarded-For', () => {
		expect(requestClientIp(viaIngress('192.168.1.20'), remote, '192.168.1.10')).toBe('192.168.1.20')
		expect(requestClientIp(viaIngress('192.168.1.20', '1.2.3.4'), remote, 'umbrel.local')).toBe('192.168.1.20')
		expect(requestClientIp(viaIngress('192.168.1.20', '1.2.3.4'), undefined, 'umbrel.example.com')).toBe('192.168.1.20')
	})

	test('uses the socket address for direct connections', () => {
		expect(requestClientIp(request('192.168.1.20', {'x-forwarded-for': '1.2.3.4'}), remote, '192.168.1.10')).toBe(
			'192.168.1.20',
		)
		expect(requestClientIp(request('::ffff:192.168.1.20'), undefined, undefined)).toBe('192.168.1.20')
	})

	test('only skips umbreld own loopback hop', () => {
		// A proxy on the same host connects to LAN ingress from loopback: stop there
		expect(requestClientIp(viaIngress('127.0.0.1', '1.2.3.4'), remote, '192.168.1.10')).toBe('127.0.0.1')
	})
})

describe('requestClientIp() on the remote domain', () => {
	const host = 'umbrel.example.com'

	test('trusts X-Forwarded-For from a private reverse proxy', () => {
		// Browser 203.0.113.5 -> proxy 172.18.0.2 (appends the client) -> LAN ingress
		expect(requestClientIp(viaIngress('172.18.0.2', '203.0.113.5'), remote, host)).toBe('203.0.113.5')
		expect(requestClientIp(viaIngress('172.18.0.2', '203.0.113.5'), remote, 'nextcloud-umbrel.example.com')).toBe(
			'203.0.113.5',
		)
	})

	test('ignores entries a client prepends before the proxy', () => {
		// The client sent "X-Forwarded-For: 10.9.9.9"; the proxy appended its real address
		expect(requestClientIp(viaIngress('172.18.0.2', '10.9.9.9, 203.0.113.5'), remote, host)).toBe('203.0.113.5')
		expect(requestClientIp(viaIngress('172.18.0.2', '1.1.1.1, 203.0.113.5'), remote, host)).toBe('203.0.113.5')
	})

	test('an untrusted peer cannot choose its address', () => {
		expect(requestClientIp(viaIngress('203.0.113.9', '1.1.1.1'), remote, host)).toBe('203.0.113.9')
		expect(
			requestClientIp(
				viaIngress('203.0.113.9', undefined, {'x-real-ip': '1.1.1.1'}),
				{...remote, clientIpHeader: 'x-real-ip'},
				host,
			),
		).toBe('203.0.113.9')
	})

	test('stops at an unparseable entry', () => {
		expect(requestClientIp(viaIngress('172.18.0.2', '1.1.1.1, garbage, 10.0.0.3'), remote, host)).toBe('10.0.0.3')
	})

	test('honours a custom trusted proxy list', () => {
		const custom = resolveRemoteDomain({
			enabled: true,
			baseDomain: 'example.com',
			trustedProxies: ['198.51.100.7', '2001:db8::/32'],
		})!
		expect(requestClientIp(viaIngress('198.51.100.7', '203.0.113.5'), custom, host)).toBe('203.0.113.5')
		// Private ranges are no longer trusted once the owner sets a list
		expect(requestClientIp(viaIngress('172.18.0.2', '203.0.113.5'), custom, host)).toBe('172.18.0.2')
	})

	test('reads the configured client IP header only from a trusted proxy', () => {
		const custom = resolveRemoteDomain({enabled: true, baseDomain: 'example.com', clientIpHeader: 'CF-Connecting-IP'})!
		const headers = {'cf-connecting-ip': '203.0.113.5'}
		expect(requestClientIp(viaIngress('172.18.0.2', '198.51.100.1', headers), custom, host)).toBe('203.0.113.5')
		// Invalid header value: fall back to X-Forwarded-For
		expect(requestClientIp(viaIngress('172.18.0.2', '198.51.100.1', {'cf-connecting-ip': 'nope'}), custom, host)).toBe(
			'198.51.100.1',
		)
	})

	test('loginClientFromRequest() reports the scope', () => {
		const umbreld = {lanIngress: {remoteDomain: remote}}
		const remoteRequest = Object.assign(viaIngress('172.18.0.2', '203.0.113.5'), {hostname: host})
		const lanRequest = Object.assign(viaIngress('192.168.1.20'), {hostname: '192.168.1.10'})
		expect(loginClientFromRequest(umbreld, remoteRequest)).toEqual({ip: '203.0.113.5', remote: true})
		expect(loginClientFromRequest(umbreld, lanRequest)).toEqual({ip: '192.168.1.20', remote: false})
		expect(loginClientFromRequest({lanIngress: {remoteDomain: undefined}}, remoteRequest)).toEqual({
			ip: '172.18.0.2',
			remote: false,
		})
	})
})
