import {describe, expect, test} from 'vitest'

import {
	DEFAULT_TRUSTED_PROXIES,
	appPortRemoteHost,
	appRemoteHost,
	buildAppHostMap,
	buildAppPortHostMap,
	isRemoteAuthRequest,
	isRemoteDomainRequest,
	lanAppOrigin,
	matchRemoteHost,
	normaliseHostHeader,
	remoteAppPortsAllowed,
	remotePublicPathsAllowed,
	remoteAppAuthUrl,
	remoteOriginRewrite,
	resolveRemoteDomain,
	rewriteRemoteOriginHeaders,
	rewriteLocalAppUrl,
	rewriteLocalRefresh,
	stripLocalCookieDomain,
	validateBaseDomain,
	validateClientIpHeader,
	validateRemoteDomainSettings,
	validateTrustedProxy,
} from './remote-domain.js'
import {remoteDispatch} from './lan-ingress.js'

const remote = resolveRemoteDomain({enabled: true, baseDomain: 'example.com'})!

describe('remote domain settings', () => {
	test('is off unless explicitly enabled', () => {
		expect(resolveRemoteDomain(undefined)).toBeUndefined()
		expect(resolveRemoteDomain({enabled: false, baseDomain: 'example.com'})).toBeUndefined()
	})

	test('uses the approved default host names', () => {
		expect(remote).toEqual({
			baseDomain: 'example.com',
			dashboardHost: 'umbrel.example.com',
			authHost: 'umbrel-auth.example.com',
			authOrigin: 'https://umbrel-auth.example.com',
			appSubdomainTemplate: '{app}-umbrel',
			allowUnauthenticatedApps: [],
			originRewriteDisabledApps: [],
			allowPublicPathApps: [],
			allowAppPortApps: [],
			trustedProxies: DEFAULT_TRUSTED_PROXIES,
			clientIpHeader: undefined,
		})
		expect(appRemoteHost(remote, 'nextcloud')).toBe('nextcloud-umbrel.example.com')
	})

	test('supports custom names', () => {
		const custom = resolveRemoteDomain({
			enabled: true,
			baseDomain: 'example.com',
			dashboardSubdomain: 'home',
			authSubdomain: 'login.home',
			appSubdomainTemplate: '{app}.apps',
		})!
		expect(custom.dashboardHost).toBe('home.example.com')
		expect(custom.authOrigin).toBe('https://login.home.example.com')
		expect(appRemoteHost(custom, 'Immich')).toBe('immich.apps.example.com')
	})

	test.each([
		['example.com', undefined],
		['sub.example.com', undefined],
		['https://example.com', 'scheme'],
		['example.com:443', 'port'],
		['example.com/path', 'path'],
		['Example.com', 'case'],
		['192.168.1.10', 'ip'],
		['umbrel.local', 'reserved'],
		['localhost', 'single label'],
		['-bad.io', 'label'],
		['', 'empty'],
	])('validates base domain %s', (value, problem) => {
		expect(!!validateBaseDomain(value)).toBe(problem !== undefined)
	})

	test('rejects bad templates and colliding hosts, and never resolves invalid settings', () => {
		expect(
			validateRemoteDomainSettings({enabled: true, baseDomain: 'example.com', appSubdomainTemplate: 'apps'}),
		).toBeTruthy()
		expect(
			validateRemoteDomainSettings({enabled: true, baseDomain: 'example.com', appSubdomainTemplate: '{app}{app}'}),
		).toBeTruthy()
		expect(
			validateRemoteDomainSettings({enabled: true, baseDomain: 'example.com', authSubdomain: 'umbrel'}),
		).toBeTruthy()
		expect(resolveRemoteDomain({enabled: true, baseDomain: 'https://example.com'})).toBeUndefined()
	})

	test('app hosts never collide with the dashboard or auth host', () => {
		const custom = resolveRemoteDomain({enabled: true, baseDomain: 'example.com', appSubdomainTemplate: '{app}'})!
		expect(appRemoteHost(custom, 'umbrel')).toBeUndefined()
		expect(appRemoteHost(custom, 'umbrel-auth')).toBeUndefined()
		expect(appRemoteHost(custom, 'bitcoin')).toBe('bitcoin.example.com')
		expect(appRemoteHost(remote, 'bad.id')).toBeUndefined()
		expect(appRemoteHost(remote, 'a'.repeat(80))).toBeUndefined()
	})

	test('drops app ids that collide case-insensitively', () => {
		const hosts = buildAppHostMap(remote, ['Files', 'files', 'immich'])
		expect([...hosts.entries()]).toEqual([['immich-umbrel.example.com', 'immich']])
	})
})

describe('remote host matching', () => {
	const appHosts = buildAppHostMap(remote, ['nextcloud'])

	test.each([
		['umbrel.example.com', {type: 'dashboard'}],
		['UMBREL.example.com.', {type: 'dashboard'}],
		['umbrel.example.com:443', {type: 'dashboard'}],
		['umbrel-auth.example.com', {type: 'auth'}],
		['nextcloud-umbrel.example.com', {type: 'app', appId: 'nextcloud'}],
		['immich-umbrel.example.com', {type: 'unknown'}],
		['example.com', {type: 'unknown'}],
		['x.umbrel.example.com', {type: 'unknown'}],
		['nextcloud-umbrel.example.com.evil.com', {type: 'outside'}],
		['evilexample.com', {type: 'outside'}],
		['umbrel.local', {type: 'outside'}],
		['192.168.1.10', {type: 'outside'}],
		['192.168.1.10:80', {type: 'outside'}],
		['[fd00::1]:443', {type: 'outside'}],
		['100.64.0.1', {type: 'outside'}],
		[undefined, {type: 'outside'}],
	])('%s', (host, expected) => {
		expect(matchRemoteHost(remote, appHosts, host)).toEqual(expected)
	})

	test('treats everything as outside while the mode is off', () => {
		expect(matchRemoteHost(undefined, appHosts, 'nextcloud-umbrel.example.com')).toEqual({type: 'outside'})
	})

	test('normalises Host headers and refuses odd ones', () => {
		expect(normaliseHostHeader('Umbrel.Example.COM:443')).toBe('umbrel.example.com')
		expect(normaliseHostHeader('umbrel.example.com:abc')).toBeUndefined()
		expect(normaliseHostHeader('user@umbrel.example.com')).toBeUndefined()
	})

	test('only the exact auth host accepts the remote login flow', () => {
		expect(isRemoteAuthRequest(remote, 'umbrel-auth.example.com')).toBe(true)
		expect(isRemoteAuthRequest(remote, 'umbrel.example.com')).toBe(false)
		expect(isRemoteAuthRequest(remote, 'umbrel-auth.example.com.evil.com')).toBe(false)
		expect(isRemoteAuthRequest(undefined, 'umbrel-auth.example.com')).toBe(false)
	})
})

describe('remote auth redirect', () => {
	test('is built from config and encodes the path', () => {
		const url = new URL(remoteAppAuthUrl(remote, 'nextcloud', '/apps/files?dir=/a&x=1#h'))
		expect(url.origin).toBe('https://umbrel-auth.example.com')
		expect(url.pathname).toBe('/app-auth')
		expect(Object.fromEntries(url.searchParams)).toEqual({
			origin: 'remote',
			app: 'nextcloud',
			path: '/apps/files?dir=/a&x=1#h',
		})
	})
})

describe('remoteDispatch()', () => {
	const allowRemote = resolveRemoteDomain({
		enabled: true,
		baseDomain: 'example.com',
		allowUnauthenticatedApps: ['pihole'],
	})!
	const appHosts = buildAppHostMap(allowRemote, ['nextcloud', 'transmission', 'pihole'])
	const appAuth = (appId: string) => ({nextcloud: true, transmission: false, pihole: false})[appId]
	const dispatch = (host: string | undefined, protocol: 'http' | 'https' = 'https', remoteDomain = allowRemote) =>
		remoteDispatch({remote: remoteDomain, appHosts, appAuth, host, protocol})

	test('keeps IP, LAN, mDNS and Tailscale hosts on the dashboard path', () => {
		for (const host of ['192.168.1.10', 'umbrel.local', '100.64.0.1:443', 'umbrel.tail1234.ts.net', undefined]) {
			expect(dispatch(host)).toEqual({type: 'dashboard'})
			expect(dispatch(host, 'http')).toEqual({type: 'dashboard'})
		}
	})

	test('serves the dashboard host like any other dashboard request', () => {
		expect(dispatch('umbrel.example.com')).toEqual({type: 'dashboard'})
	})

	test('routes the auth host and apps with Umbrel login', () => {
		expect(dispatch('umbrel-auth.example.com')).toEqual({type: 'auth'})
		expect(dispatch('nextcloud-umbrel.example.com')).toEqual({type: 'app', appId: 'nextcloud'})
	})

	test('returns 404 for unknown hosts under the domain instead of the dashboard', () => {
		expect(dispatch('example.com')).toMatchObject({type: 'reject', status: 404})
		expect(dispatch('random-umbrel.example.com')).toMatchObject({type: 'reject', status: 404})
		expect(dispatch('random-umbrel.example.com', 'http')).toMatchObject({type: 'reject', status: 404})
	})

	test('refuses auth and app hosts on plain HTTP', () => {
		expect(dispatch('umbrel-auth.example.com', 'http')).toMatchObject({type: 'reject', status: 421})
		expect(dispatch('nextcloud-umbrel.example.com', 'http')).toMatchObject({type: 'reject', status: 421})
	})

	test('blocks apps with Umbrel login off unless the owner allowed them', () => {
		expect(dispatch('transmission-umbrel.example.com')).toMatchObject({type: 'reject', status: 403})
		expect(dispatch('pihole-umbrel.example.com')).toEqual({type: 'app', appId: 'pihole'})
	})

	test('tells the browser to retry while an installed app is still starting', () => {
		const pendingHosts = new Set(['newapp-umbrel.example.com'])
		const pending = (host: string, protocol: 'http' | 'https' = 'https') =>
			remoteDispatch({remote: allowRemote, appHosts, appAuth, host, protocol, pendingHosts})
		expect(pending('newapp-umbrel.example.com')).toMatchObject({type: 'reject', status: 503})
		expect(pending('NewApp-umbrel.example.com:443')).toMatchObject({type: 'reject', status: 503})
		expect(pending('newapp-umbrel.example.com', 'http')).toMatchObject({type: 'reject', status: 404})
		expect(pending('gone-umbrel.example.com')).toMatchObject({type: 'reject', status: 404})
	})

	test('does nothing while the mode is off', () => {
		expect(
			remoteDispatch({remote: undefined, appHosts, appAuth, host: 'nextcloud-umbrel.example.com', protocol: 'https'}),
		).toEqual({type: 'dashboard'})
	})
})

describe('extra app ports', () => {
	const portRemote = resolveRemoteDomain({
		enabled: true,
		baseDomain: 'example.com',
		allowUnauthenticatedApps: ['lobe-chat'],
		allowAppPortApps: ['lobe-chat', 'nextcloud', 'transmission', 'lobe-chat'],
	})!
	const appHosts = buildAppHostMap(portRemote, ['lobe-chat', 'nextcloud', 'transmission', 'files', 'files-8080'])
	const portHosts = buildAppPortHostMap(
		portRemote,
		[
			['lobe-chat', [7458, 7459]],
			['transmission', [9091]],
			['files', [8080, 8081]],
		],
		appHosts,
	)
	const appAuth = (appId: string) => ({'lobe-chat': false, nextcloud: true, transmission: false})[appId]
	const dispatch = (host: string, protocol: 'http' | 'https' = 'https', remote = portRemote) =>
		remoteDispatch({remote, appHosts, portHosts, appAuth, host, protocol})

	test('each port gets its own host under the app pattern', () => {
		expect(portRemote.allowAppPortApps).toEqual(['lobe-chat', 'nextcloud', 'transmission'])
		expect(appPortRemoteHost(portRemote, 'lobe-chat', 7458)).toBe('lobe-chat-7458-umbrel.example.com')
		expect(appPortRemoteHost(portRemote, 'lobe-chat', 0)).toBeUndefined()
		expect(appPortRemoteHost(portRemote, 'lobe-chat', 70_000)).toBeUndefined()
		// An app's own host wins over another app's port host with the same name.
		expect(portHosts.get('files-8080-umbrel.example.com')).toBeUndefined()
		expect(portHosts.get('files-8081-umbrel.example.com')).toEqual({appId: 'files', port: 8081})
		expect(matchRemoteHost(portRemote, appHosts, 'files-8080-umbrel.example.com', portHosts)).toEqual({
			type: 'app',
			appId: 'files-8080',
		})
	})

	test('routes opted-in ports over HTTPS only', () => {
		expect(dispatch('lobe-chat-7458-umbrel.example.com')).toEqual({type: 'port', appId: 'lobe-chat', port: 7458})
		expect(dispatch('Lobe-Chat-7459-umbrel.example.com:443')).toEqual({type: 'port', appId: 'lobe-chat', port: 7459})
		expect(dispatch('lobe-chat-7458-umbrel.example.com', 'http')).toMatchObject({type: 'reject', status: 421})
		expect(dispatch('lobe-chat-7460-umbrel.example.com')).toMatchObject({type: 'reject', status: 404})
	})

	test('follows the app allow decision and the per-app opt-in', () => {
		// Umbrel's login is off and the app is not allowed: its ports are blocked too.
		expect(dispatch('transmission-9091-umbrel.example.com')).toMatchObject({type: 'reject', status: 403})
		// Not opted in: the host does not exist.
		expect(dispatch('files-8081-umbrel.example.com')).toMatchObject({type: 'reject', status: 404})
		const optedOut = resolveRemoteDomain({
			enabled: true,
			baseDomain: 'example.com',
			allowUnauthenticatedApps: ['lobe-chat'],
		})!
		expect(remoteAppPortsAllowed(optedOut, 'lobe-chat')).toBe(false)
		expect(dispatch('lobe-chat-7458-umbrel.example.com', 'https', optedOut)).toMatchObject({
			type: 'reject',
			status: 404,
		})
		expect(
			remoteDispatch({
				remote: undefined,
				appHosts,
				portHosts,
				appAuth,
				host: 'lobe-chat-7458-umbrel.example.com',
				protocol: 'https',
			}),
		).toEqual({type: 'dashboard'})
	})
})

describe('remote Origin/Referer rewrite', () => {
	const remoteOrigin = 'https://agent-zero-umbrel.example.com'
	const lanOrigin = 'http://umbrel.local:3015'

	test('rewrites the same app origin to its LAN origin', () => {
		expect(rewriteRemoteOriginHeaders({origin: remoteOrigin}, remoteOrigin, lanOrigin)).toEqual({origin: lanOrigin})
		expect(
			rewriteRemoteOriginHeaders({origin: 'https://Agent-Zero-Umbrel.example.com'}, remoteOrigin, lanOrigin),
		).toEqual({origin: lanOrigin})
	})

	test('keeps the referer path and query', () => {
		expect(rewriteRemoteOriginHeaders({referer: `${remoteOrigin}/chat/1?tab=files`}, remoteOrigin, lanOrigin)).toEqual({
			referer: `${lanOrigin}/chat/1?tab=files`,
		})
	})

	test('leaves foreign and other app origins untouched', () => {
		for (const origin of [
			'https://evil.com',
			'https://immich-umbrel.example.com',
			'https://umbrel.example.com',
			'http://agent-zero-umbrel.example.com',
			'https://agent-zero-umbrel.example.com:8443',
			'https://agent-zero-umbrel.example.com.evil.com',
			'null',
		]) {
			expect(rewriteRemoteOriginHeaders({origin, referer: `${origin}/x`}, remoteOrigin, lanOrigin)).toEqual({})
		}
	})

	test('leaves requests without Origin or Referer untouched', () => {
		expect(rewriteRemoteOriginHeaders({}, remoteOrigin, lanOrigin)).toEqual({})
	})

	test('only applies on the app own remote host and honours the per-app opt out', () => {
		const lan = lanAppOrigin('umbrel.local', 3015)
		expect(remoteOriginRewrite(remote, 'agent-zero', 'agent-zero-umbrel.example.com', lan)).toEqual({
			remoteHost: 'agent-zero-umbrel.example.com',
			remoteOrigin,
			lanOrigin,
		})
		for (const host of ['umbrel.local:3015', '192.168.1.10:3015', 'immich-umbrel.example.com', undefined]) {
			expect(remoteOriginRewrite(remote, 'agent-zero', host, lan)).toBeUndefined()
		}
		expect(remoteOriginRewrite(undefined, 'agent-zero', 'agent-zero-umbrel.example.com', lan)).toBeUndefined()
		const optedOut = resolveRemoteDomain({
			enabled: true,
			baseDomain: 'example.com',
			originRewriteDisabledApps: ['agent-zero'],
		})!
		expect(remoteOriginRewrite(optedOut, 'agent-zero', 'agent-zero-umbrel.example.com', lan)?.lanOrigin).toBeUndefined()
	})
})

describe('local redirect rewrite', () => {
	const local = {lanOrigin: 'http://umbrel.local:7455', targetHost: 'lobe-chat_app_1', targetPort: 3210}
	const remoteOrigin = 'https://lobe-chat-umbrel.example.com'

	test('maps the app local addresses to its remote origin', () => {
		for (const url of [
			'http://umbrel.local:7455/signin?callbackUrl=%2F',
			'https://umbrel.local:7455/signin?callbackUrl=%2F',
			'http://umbrel:7455/signin?callbackUrl=%2F',
			'http://10.0.0.5:7455/signin?callbackUrl=%2F',
			'http://[::1]:7455/signin?callbackUrl=%2F',
			'http://lobe-chat_app_1:3210/signin?callbackUrl=%2F',
			'http://0.0.0.0:3210/signin?callbackUrl=%2F',
		]) {
			expect(rewriteLocalAppUrl(url, local, remoteOrigin)).toBe(`${remoteOrigin}/signin?callbackUrl=%2F`)
		}
	})

	test('leaves other apps, public hosts, credentials and relative URLs alone', () => {
		for (const url of [
			'http://umbrel.local:7458/bucket',
			'http://lobe-chat_app_1:7455/x',
			'http://8.8.8.8:7455/x',
			'https://evil.com/x',
			'http://user:pass@umbrel.local:7455/x',
			'/signin',
			'javascript:alert(1)',
			'http://[bad',
		]) {
			expect(rewriteLocalAppUrl(url, local, remoteOrigin)).toBe(url)
		}
	})

	test('rewrites the Refresh url and keeps its delay and quotes', () => {
		expect(rewriteLocalRefresh("5; URL='http://umbrel.local:7455/a?b=1'", local, remoteOrigin)).toBe(
			`5; URL='${remoteOrigin}/a?b=1'`,
		)
		expect(rewriteLocalRefresh('5', local, remoteOrigin)).toBe('5')
	})

	test('drops only local cookie domains', () => {
		expect(stripLocalCookieDomain('s=1; Domain=.umbrel.local; Secure', local)).toBe('s=1; Secure')
		expect(stripLocalCookieDomain('s=1; domain=192.168.1.10', local)).toBe('s=1')
		expect(stripLocalCookieDomain('s=1; Domain=example.com', local)).toBe('s=1; Domain=example.com')
	})
})

describe('remote hardening settings', () => {
	test('validates trusted proxies', () => {
		for (const ok of ['172.18.0.2', '172.16.0.0/12', '::1', 'fc00::/7', '2001:db8::/128', '0.0.0.0/0']) {
			expect(validateTrustedProxy(ok)).toBeUndefined()
		}
		for (const bad of ['', 'proxy', '172.18.0.0/33', '::/129', '10.0.0.0/8/1', '10.0.0.0/x', '10.0.0.0/']) {
			expect(validateTrustedProxy(bad)).toBeTruthy()
		}
	})

	test('validates the client IP header', () => {
		expect(validateClientIpHeader('X-Real-IP')).toBeUndefined()
		expect(validateClientIpHeader('CF-Connecting-IP')).toBeUndefined()
		for (const bad of [
			'',
			'X Real',
			'a:b',
			'Host',
			'cookie',
			'Authorization',
			'X-Forwarded-Host',
			'x-forwarded-proto',
		]) {
			expect(validateClientIpHeader(bad)).toBeTruthy()
		}
		expect(validateClientIpHeader('x'.repeat(65))).toBeTruthy()
	})

	test('rejects invalid hardening settings and resolves valid ones', () => {
		const base = {enabled: true, baseDomain: 'example.com'}
		expect(validateRemoteDomainSettings({...base, trustedProxies: ['10.0.0.0/8', 'nope']})).toBe(
			'Invalid trusted proxy nope',
		)
		expect(validateRemoteDomainSettings({...base, clientIpHeader: 'Host'})).toBe('Host cannot carry the client IP')
		const resolved = resolveRemoteDomain({
			...base,
			trustedProxies: ['198.51.100.7'],
			clientIpHeader: 'X-Real-IP',
			allowPublicPathApps: ['vaultwarden', 'vaultwarden'],
		})!
		expect(resolved.trustedProxies).toEqual(['198.51.100.7'])
		expect(resolved.clientIpHeader).toBe('x-real-ip')
		expect(resolved.allowPublicPathApps).toEqual(['vaultwarden'])
		expect(resolveRemoteDomain({...base, trustedProxies: []})!.trustedProxies).toEqual(DEFAULT_TRUSTED_PROXIES)
		expect(resolveRemoteDomain({...base, clientIpHeader: 'Host'})!.clientIpHeader).toBeUndefined()
	})

	test('public paths stay off remotely unless allowed per app', () => {
		expect(remotePublicPathsAllowed(remote, 'vaultwarden')).toBe(false)
		const allowed = resolveRemoteDomain({
			enabled: true,
			baseDomain: 'example.com',
			allowPublicPathApps: ['vaultwarden'],
		})!
		expect(remotePublicPathsAllowed(allowed, 'vaultwarden')).toBe(true)
		expect(remotePublicPathsAllowed(allowed, 'nextcloud')).toBe(false)
	})

	test('isRemoteDomainRequest() matches only the base domain and below', () => {
		expect(isRemoteDomainRequest(remote, 'umbrel.example.com')).toBe(true)
		expect(isRemoteDomainRequest(remote, 'anything.example.com')).toBe(true)
		expect(isRemoteDomainRequest(remote, 'example.com')).toBe(true)
		for (const host of ['192.168.1.10', 'umbrel.local', 'abc.onion', 'example.com.evil.com', 'notexample.com']) {
			expect(isRemoteDomainRequest(remote, host)).toBe(false)
		}
		expect(isRemoteDomainRequest(undefined, 'umbrel.example.com')).toBe(false)
		expect(isRemoteDomainRequest(remote, undefined)).toBe(false)
	})
})
