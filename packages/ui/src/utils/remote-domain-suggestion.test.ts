import {describe, expect, test} from 'vitest'

import {suggestBaseDomain} from './remote-domain-suggestion'

describe('suggestBaseDomain', () => {
	test('drops the first label of the dashboard host', () => {
		expect(suggestBaseDomain('umbrel.example.com')).toBe('example.com')
		expect(suggestBaseDomain('UMBREL.Example.COM.')).toBe('example.com')
		expect(suggestBaseDomain('umbrel.home.example.co.uk')).toBe('home.example.co.uk')
	})

	test('has no suggestion for IP addresses', () => {
		for (const host of ['192.168.1.10', '100.101.102.103', '[fd7a:115c:a1e0::1]', 'fd7a:115c:a1e0::1', '::1']) {
			expect(suggestBaseDomain(host)).toBeUndefined()
		}
	})

	test('has no suggestion for local, Tailscale, Tor or single-label hosts', () => {
		for (const host of [
			'localhost',
			'app.localhost',
			'umbrel.local',
			'umbrel.lan',
			'umbrel.home',
			'umbrel.tail1234.ts.net',
			'abcdefghijklmnop.onion',
			'umbrel',
			'example.com',
			'',
			undefined,
		]) {
			expect(suggestBaseDomain(host)).toBeUndefined()
		}
	})

	test('rejects malformed hosts', () => {
		expect(suggestBaseDomain('umbrel..example.com')).toBeUndefined()
		expect(suggestBaseDomain('umbrel.-bad.com')).toBeUndefined()
		expect(suggestBaseDomain('a.b.123')).toBeUndefined()
	})
})
