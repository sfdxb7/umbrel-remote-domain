import http from 'node:http'
import type {AddressInfo} from 'node:net'

import bcrypt from 'bcryptjs'
import cookieParser from 'cookie-parser'
import express from 'express'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest'

// The tRPC router imports the full daemon graph. Stub native modules that are
// not needed here so this file also runs on machines without a native toolchain.
vi.mock('drivelist', () => ({default: {list: async () => []}, list: async () => []}))
vi.mock('node-pty', () => ({default: {}, spawn: () => {}}))

import type Umbreld from '../../index.js'
import {resolveRemoteDomain, type RemoteDomain} from '../lan-ingress/remote-domain.js'
import User from '../user/user.js'
import createAppAuthRouter, {appHandoffFormAction} from './app-auth.js'
import {securityHeaders} from './index.js'
import {batchedAuthProcedures, trpcExpressHandler} from './trpc/index.js'

const REMOTE_HOST = 'umbrel.example.com'
const AUTH_HOST = 'umbrel-auth.example.com'
const LAN_HOST = '192.168.1.10'
// LAN ingress appends the peer it saw; a reverse proxy in front appends the browser
const REMOTE_XFF = '203.0.113.5, 172.18.0.2'
const LAN_XFF = '192.168.1.20'

const remote = resolveRemoteDomain({enabled: true, baseDomain: 'example.com'})!

let ownerHash: string
let aliceHash: string
beforeAll(async () => {
	ownerHash = await bcrypt.hash('owner-password', 4)
	aliceHash = await bcrypt.hash('alice-password', 4)
})

type Data = Record<string, any>

function createUmbreld(data: Data, remoteDomain: RemoteDomain | undefined = remote) {
	const logger = {log: vi.fn(), error: vi.fn(), verbose: vi.fn(), createChildLogger: () => logger}
	const umbreld = {
		logger,
		store: {
			get: async (key: string) => key.split('.').reduce((value: any, part) => value?.[part], data),
			set: async (key: string, value: unknown) => {
				data[key] = value
			},
		},
		lanIngress: {
			remoteDomain,
			remoteAppOrigin: (appId: string) =>
				remoteDomain && appId === 'nextcloud' ? `https://nextcloud-umbrel.${remoteDomain.baseDomain}` : undefined,
		},
		apps: {
			getApp: (appId: string) => ({
				readManifest: async () => {
					if (!['nextcloud', 'unrouted'].includes(appId)) throw new Error(`App ${appId} not found`)
					return {id: appId, name: appId, port: 8080}
				},
				readHiddenService: async () => '',
			}),
		},
		auth: {
			sessionIssuanceRevision: () => 1,
			createSession: vi.fn(async ({accountId}: {accountId: string}) => ({
				appGatewayToken: 'gateway-token',
				browserSessionToken: 'browser-token',
				dashboardToken: `dashboard-${accountId}`,
				expiresAt: Date.now() + 60_000,
				principal: {sessionId: 'session'},
			})),
			issueAppHandoff: vi.fn(async () => 'handoff-token'),
			authenticateApiCredentials: async (token: string) => {
				if (token !== 'valid-token') throw new Error('Invalid token')
				return {accountId: '0'}
			},
			revokeSession: vi.fn(),
		},
	} as unknown as Umbreld
	umbreld.user = new User(umbreld)
	return umbreld
}

let server: http.Server
let port: number
let umbreld: Umbreld

beforeAll(async () => {
	const app = express()
	app.set('trust proxy', 'loopback')
	app.use(cookieParser())
	app.use(securityHeaders({developmentMode: false}))
	// The tests swap umbreld per test; routes read it at request time
	app.use((request, _response, next) => {
		request.app.set('umbreld', umbreld)
		request.app.set('logger', umbreld.logger)
		next()
	})
	app.use('/app-auth', (request, response, next) => createAppAuthRouter(umbreld)(request, response, next))
	app.use('/trpc', trpcExpressHandler)
	server = http.createServer(app)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	port = (server.address() as AddressInfo).port
})

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve))
})

beforeEach(() => {
	umbreld = createUmbreld({
		user: {name: 'Owner', hashedPassword: ownerHash, totpUri: 'otpauth://totp/Umbrel?secret=JBSWY3DPEHPK3PXP'},
		members: [{id: 'Alice', name: 'Alice', hashedPassword: aliceHash}],
	})
})

afterEach(() => {
	vi.restoreAllMocks()
})

type Response = {status: number; headers: http.IncomingHttpHeaders; body: any}

function call(
	method: 'GET' | 'POST',
	path: string,
	{host, xff, body, headers = {}}: {host: string; xff: string; body?: unknown; headers?: Record<string, string>},
) {
	return new Promise<Response>((resolve, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body)
		const request = http.request(
			{
				host: '127.0.0.1',
				port,
				method,
				path,
				headers: {
					host,
					'x-forwarded-host': host,
					'x-forwarded-for': xff,
					...(payload ? {'content-type': 'application/json'} : {}),
					...headers,
				},
			},
			(response) => {
				let text = ''
				response.on('data', (chunk) => (text += chunk))
				response.on('end', () => {
					let parsed: unknown = text
					try {
						parsed = JSON.parse(text)
					} catch {}
					resolve({status: response.statusCode!, headers: response.headers, body: parsed})
				})
			},
		)
		request.on('error', reject)
		request.end(payload)
	})
}

const remoteGet = (path: string, headers?: Record<string, string>) =>
	call('GET', path, {host: REMOTE_HOST, xff: REMOTE_XFF, headers})
const lanGet = (path: string) => call('GET', path, {host: LAN_HOST, xff: LAN_XFF})
const login = (host: string, xff: string, input: Record<string, unknown>) =>
	call('POST', '/trpc/user.login', {host, xff, body: input})

describe('tRPC batching', () => {
	test('finds auth procedures in batched paths', () => {
		expect(batchedAuthProcedures('/user.login')).toEqual([])
		expect(batchedAuthProcedures('/user.login,user.login')).toEqual(['user.login', 'user.login'])
		expect(batchedAuthProcedures('/user.exists,user.loginNative')).toEqual(['user.loginNative'])
		expect(batchedAuthProcedures('/user.login%2Cuser.verifyPassword')).toEqual(['user.login', 'user.verifyPassword'])
		expect(batchedAuthProcedures('/user.exists,user.listAccounts')).toEqual([])
		expect(batchedAuthProcedures('/%E0%A4%A')).toEqual([])
	})

	test('refuses batches that carry password guesses, on the LAN too', async () => {
		const body = {0: {password: 'a'}, 1: {password: 'b'}}
		for (const host of [REMOTE_HOST, LAN_HOST]) {
			const response = await call('POST', '/trpc/user.login,user.login?batch=1', {host, xff: LAN_XFF, body})
			expect(response.status).toBe(400)
			expect(response.body.error.message).toBe('Authentication procedures cannot be batched')
		}
		expect(umbreld.auth.createSession).not.toHaveBeenCalled()
	})

	test('still serves other batches', async () => {
		const response = await lanGet('/trpc/user.exists,user.listAccounts?batch=1&input=%7B%7D')
		expect(response.status).toBe(200)
		expect(response.body[0].result.data).toBe(true)
	})
})

describe('account enumeration on the remote domain', () => {
	test('listAccounts is empty remotely unless signed in, and unchanged on the LAN', async () => {
		expect((await remoteGet('/trpc/user.listAccounts')).body.result.data).toEqual([])
		const signedIn = await remoteGet('/trpc/user.listAccounts', {authorization: 'Bearer valid-token'})
		expect(signedIn.body.result.data.map((account: {userId: string}) => account.userId)).toEqual(['0', 'Alice'])
		const lan = await lanGet('/trpc/user.listAccounts')
		expect(lan.body.result.data.map((account: {name: string}) => account.name)).toEqual(['Owner', 'Alice'])
	})

	test('exists does not reveal setup state remotely', async () => {
		umbreld = createUmbreld({})
		expect((await remoteGet('/trpc/user.exists')).body.result.data).toBe(true)
		expect((await lanGet('/trpc/user.exists')).body.result.data).toBe(false)
	})

	test('is2faEnabled does not reveal the owner 2FA state remotely', async () => {
		expect((await remoteGet('/trpc/user.is2faEnabled')).body.result.data).toBe(false)
		expect((await lanGet('/trpc/user.is2faEnabled')).body.result.data).toBe(true)
	})

	test('register is refused remotely', async () => {
		umbreld = createUmbreld({})
		const response = await call('POST', '/trpc/user.register', {
			host: REMOTE_HOST,
			xff: REMOTE_XFF,
			body: {name: 'Mallory', password: 'password-password'},
		})
		expect(response.status).toBe(403)
	})
})

describe('login backoff', () => {
	test('remote login by typed username, case-insensitive', async () => {
		const response = await login(REMOTE_HOST, REMOTE_XFF, {username: 'alice', password: 'alice-password'})
		expect(response.status).toBe(200)
		expect(response.body.result.data).toBe('dashboard-Alice')
		expect(umbreld.auth.createSession).toHaveBeenCalledWith(expect.objectContaining({accountId: 'Alice'}))
		const unknown = await login(REMOTE_HOST, REMOTE_XFF, {username: 'nobody', password: 'x'})
		expect(unknown.status).toBe(401)
		expect(unknown.body.error.message).toBe('Incorrect password')
	})

	test('locks the account remotely after five failures without locking the LAN', async () => {
		for (let i = 0; i < 5; i++) {
			const response = await login(REMOTE_HOST, REMOTE_XFF, {userId: 'Alice', password: 'wrong'})
			expect(response.status).toBe(401)
		}
		// Even the right password is refused while locked
		const locked = await login(REMOTE_HOST, REMOTE_XFF, {username: 'Alice', password: 'alice-password'})
		expect(locked.status).toBe(429)
		expect(locked.body.error.message).toMatch(/^Too many login attempts\. Try again in \d+ seconds?\.$/)
		expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0)
		// A different internet address is refused too: the account key is shared
		const otherIp = await login(REMOTE_HOST, '198.51.100.9, 172.18.0.2', {userId: 'Alice', password: 'alice-password'})
		expect(otherIp.status).toBe(429)
		// The LAN has its own account scope
		const lan = await login(LAN_HOST, LAN_XFF, {userId: 'Alice', password: 'alice-password'})
		expect(lan.status).toBe(200)
	})

	test('locks an IP that sprays account names', async () => {
		for (let i = 0; i < 10; i++) {
			expect((await login(REMOTE_HOST, REMOTE_XFF, {username: `user${i}`, password: 'x'})).status).toBe(401)
		}
		expect((await login(REMOTE_HOST, REMOTE_XFF, {username: 'Alice', password: 'alice-password'})).status).toBe(429)
		// A client-chosen X-Forwarded-For entry does not escape the lock
		expect(
			(await login(REMOTE_HOST, `10.1.2.3, ${REMOTE_XFF}`, {username: 'Alice', password: 'alice-password'})).status,
		).toBe(429)
	})

	test('a correct password awaiting its 2FA code does not count as a failure', async () => {
		for (let i = 0; i < 8; i++) {
			const response = await login(REMOTE_HOST, REMOTE_XFF, {password: 'owner-password'})
			expect(response.body.error.message).toBe('Missing 2FA code')
		}
		expect(umbreld.user.loginThrottle.size).toBe(0)
	})
})

describe('app-auth on the remote domain', () => {
	const authGet = (path: string) => call('GET', path, {host: AUTH_HOST, xff: REMOTE_XFF})

	test('does not list accounts remotely', async () => {
		expect((await authGet('/app-auth/v1/account/accounts')).body).toEqual([])
		expect((await lanGet('/app-auth/v1/account/accounts')).body).toHaveLength(2)
	})

	test('only answers on the auth host', async () => {
		const response = await remoteGet('/app-auth/v1/account/accounts')
		expect(response.status).toBe(404)
		expect(
			(await call('GET', '/app-auth/v1/apps?app=nextcloud', {host: 'x.example.com', xff: REMOTE_XFF})).status,
		).toBe(404)
	})

	test('/v1/apps answers 404 alike for missing and unrouted apps', async () => {
		expect((await authGet('/app-auth/v1/apps?app=nextcloud')).body).toEqual({id: 'nextcloud', name: 'nextcloud'})
		expect((await authGet('/app-auth/v1/apps?app=unrouted')).status).toBe(404)
		expect((await authGet('/app-auth/v1/apps?app=missing')).status).toBe(404)
		// LAN keeps upstream behaviour
		expect((await lanGet('/app-auth/v1/apps?app=unrouted')).status).toBe(200)
	})

	test('app login is throttled with a 429 and Retry-After', async () => {
		const appLogin = (password: string) =>
			call('POST', '/app-auth/v1/account/login?origin=remote&app=nextcloud&path=/', {
				host: AUTH_HOST,
				xff: REMOTE_XFF,
				body: {username: 'alice', password},
			})
		expect((await appLogin('alice-password')).status).toBe(200)
		expect(umbreld.auth.createSession).toHaveBeenCalledWith(expect.objectContaining({accountId: 'Alice'}))
		for (let i = 0; i < 5; i++) expect((await appLogin('wrong')).status).toBe(401)
		const locked = await appLogin('alice-password')
		expect(locked.status).toBe(429)
		expect(locked.body.error.code).toBe(-32029)
		expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0)
	})

	test('never widens form-action to a wildcard port on the remote domain', async () => {
		const request = (hostname: string, query: Record<string, string>) =>
			({hostname, protocol: 'https', query}) as unknown as express.Request
		await expect(appHandoffFormAction(umbreld, request(AUTH_HOST, {origin: 'host', app: 'nextcloud'}))).resolves.toBe(
			undefined,
		)
		await expect(appHandoffFormAction(umbreld, request(AUTH_HOST, {}))).resolves.toBeUndefined()
		await expect(appHandoffFormAction(umbreld, request(LAN_HOST, {origin: 'host', app: 'nextcloud'}))).resolves.toBe(
			`https://${LAN_HOST}:*`,
		)
		const response = await authGet('/app-auth/v1/account/accounts')
		expect(response.headers['content-security-policy']).not.toMatch(/:\*/)
	})
})

describe('security headers', () => {
	test('sends nosniff and the strict referrer policy', async () => {
		for (const response of [await remoteGet('/trpc/user.exists'), await authGet()]) {
			expect(response.headers['x-content-type-options']).toBe('nosniff')
			expect(response.headers['referrer-policy']).toBe('no-referrer')
			expect(response.headers['content-security-policy']).toContain("form-action 'self'")
		}
	})

	function authGet() {
		return call('GET', '/app-auth/v1/account/accounts', {host: AUTH_HOST, xff: REMOTE_XFF})
	}
})
