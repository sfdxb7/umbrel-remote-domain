// @vitest-environment jsdom

import {describe, expect, test} from 'vitest'

import {appToUrl, isRemoteDomainHost} from './misc'

const app = {port: 8085, hiddenService: 'appaddress.onion', remoteUrl: 'https://nextcloud-umbrel.example.com'}

function page(url: string) {
	const {protocol, hostname, origin} = new URL(url)
	return {protocol, hostname, origin}
}

describe('appToUrl', () => {
	test('uses the remote app origin on the remote domain', () => {
		expect(appToUrl(app, 'https:', 'example.com', page('https://umbrel.example.com/'))).toBe(
			'https://nextcloud-umbrel.example.com',
		)
	})

	test('keeps port URLs on IP, LAN and Tailscale pages', () => {
		expect(appToUrl(app, 'http:', 'example.com', page('http://192.168.1.10/'))).toBe('http://192.168.1.10:8085')
		expect(appToUrl(app, 'http:', 'example.com', page('http://umbrel.local/'))).toBe('http://umbrel.local:8085')
		expect(appToUrl(app, 'http:', 'example.com', page('http://umbrel.tail1234.ts.net/'))).toBe(
			'http://umbrel.tail1234.ts.net:8085',
		)
	})

	test('keeps port URLs while remote mode is off', () => {
		expect(appToUrl(app, 'https:', undefined, page('https://umbrel.example.com/'))).toBe(
			'https://umbrel.example.com:8085',
		)
	})

	test('falls back to the port URL for apps without a remote route', () => {
		expect(appToUrl({...app, remoteUrl: null}, 'https:', 'example.com', page('https://umbrel.example.com/'))).toBe(
			'https://umbrel.example.com:8085',
		)
	})

	test('keeps Tor first', () => {
		expect(appToUrl(app, 'http:', 'example.com', page('http://umbrelxyz.onion/'))).toBe('http://appaddress.onion')
	})
})

describe('isRemoteDomainHost', () => {
	test('matches the base domain and its subdomains only', () => {
		expect(isRemoteDomainHost('umbrel.example.com', 'example.com')).toBe(true)
		expect(isRemoteDomainHost('UMBREL.EXAMPLE.COM.', 'example.com')).toBe(true)
		expect(isRemoteDomainHost('evilexample.com', 'example.com')).toBe(false)
		expect(isRemoteDomainHost('example.com.evil.com', 'example.com')).toBe(false)
		expect(isRemoteDomainHost('umbrel.example.com', undefined)).toBe(false)
	})
})
