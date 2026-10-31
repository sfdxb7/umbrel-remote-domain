import {describe, expect, test} from 'vitest'

import {
	browserFacingPorts,
	publishedTcpPorts,
	remoteAppEnvironment,
	serviceEnvironment,
} from './remote-app-environment.js'
import {resolveRemoteDomain} from './remote-domain.js'
import {appsNeedingRestart} from './routes.js'

// The parts of lobe-chat's app store Compose file that matter here, with
// credentials replaced.
const lobeChat = {
	services: {
		app_proxy: {environment: {APP_HOST: 'lobe-chat_app_1', APP_PORT: 3210, PROXY_AUTH_ADD: 'false'}},
		app: {
			env_file: ['${APP_DATA_DIR}/settings.env'],
			environment: {
				APP_URL: 'http://${DEVICE_DOMAIN_NAME}:7455',
				INTERNAL_APP_URL: 'http://lobe-chat_app_1:3210',
				AUTH_TRUSTED_ORIGINS: 'http://${DEVICE_DOMAIN_NAME}:7455',
				REDIS_TLS: '0',
				S3_ENDPOINT: 'http://${DEVICE_DOMAIN_NAME}:7458',
				S3_INTERNAL_ENDPOINT: 'http://lobe-chat_rustfs_1:9000',
				S3_BUCKET: 'lobe',
				S3_SECRET_ACCESS_KEY: 'example-secret',
				ENABLE_AGENT_GATEWAY: '1',
				AGENT_GATEWAY_URL: 'http://${DEVICE_DOMAIN_NAME}:7459',
				AGENT_GATEWAY_INTERNAL_URL: 'http://lobe-chat_gateway_1:8787',
				DEVICE_GATEWAY_URL: 'http://lobe-chat_gateway_1:8788',
			},
		},
		gateway: {
			ports: ['7459:8787', '7460:8788'],
			environment: {LOBE_API_BASE_URL: 'http://lobe-chat_app_1:3210'},
		},
		postgres: {environment: {POSTGRES_DB: 'lobehub', POSTGRES_PASSWORD: 'example-secret'}},
		rustfs: {
			ports: ['7458:9000'],
			environment: {RUSTFS_ADDRESS: '0.0.0.0:9000', RUSTFS_SECRET_KEY: 'example-secret'},
		},
	},
}

const off = resolveRemoteDomain({enabled: false, baseDomain: 'example.com'})
const on = resolveRemoteDomain({enabled: true, baseDomain: 'example.com'})!
const withPorts = resolveRemoteDomain({enabled: true, baseDomain: 'example.com', allowAppPortApps: ['lobe-chat']})!

describe('remote app environment', () => {
	test('lobe-chat gets its remote origin trusted', () => {
		expect(remoteAppEnvironment({remote: on, appId: 'lobe-chat', compose: lobeChat, mainPort: 7455})).toEqual({
			app: {AUTH_TRUSTED_ORIGINS: 'http://${DEVICE_DOMAIN_NAME}:7455,https://lobe-chat-umbrel.example.com'},
		})
	})

	test('lobe-chat with extra ports allowed points S3 and the agent gateway at their remote hosts', () => {
		expect(remoteAppEnvironment({remote: withPorts, appId: 'lobe-chat', compose: lobeChat, mainPort: 7455})).toEqual({
			app: {
				AUTH_TRUSTED_ORIGINS: 'http://${DEVICE_DOMAIN_NAME}:7455,https://lobe-chat-umbrel.example.com',
				S3_ENDPOINT: 'https://lobe-chat-7458-umbrel.example.com',
				AGENT_GATEWAY_URL: 'https://lobe-chat-7459-umbrel.example.com',
			},
		})
	})

	test('nothing changes when the mode is off or the app has no app gateway', () => {
		expect(remoteAppEnvironment({remote: off, appId: 'lobe-chat', compose: lobeChat, mainPort: 7455})).toEqual({})
		const {app_proxy: _, ...direct} = lobeChat.services
		expect(
			remoteAppEnvironment({remote: withPorts, appId: 'lobe-chat', compose: {services: direct}, mainPort: 7455}),
		).toEqual({})
		expect(remoteAppEnvironment({remote: on, appId: 'lobe-chat', compose: null, mainPort: 7455})).toEqual({})
	})

	test('only published ports the app hands out as a LAN URL are browser-facing', () => {
		expect([...publishedTcpPorts(lobeChat)].sort()).toEqual([7458, 7459, 7460])
		// 7460 is published but never handed out; 7455 is the main port.
		expect(browserFacingPorts(lobeChat, 7455)).toEqual([7458, 7459])
		// A LAN URL to a port the app does not publish is not routed.
		expect(
			browserFacingPorts(
				{services: {app: {environment: {OTHER_APP: 'http://${DEVICE_DOMAIN_NAME}:3000'}}, s3: {ports: ['9000']}}},
				8080,
			),
		).toEqual([])
	})

	test('port parsing covers Compose short and long syntax and skips UDP and random host ports', () => {
		const compose = {
			services: {
				a: {ports: ['127.0.0.1:8001:80', '8002:80/tcp', '8003:53/udp', 8004, '8005']},
				b: {
					ports: [
						{target: 80, published: 8006},
						{target: 53, published: '8007', protocol: 'udp'},
					],
				},
			},
		}
		expect([...publishedTcpPorts(compose)].sort()).toEqual([8001, 8002, 8006])
	})

	test('LAN URL forms keep their path and leave other values alone', () => {
		const compose = {
			services: {
				app_proxy: {},
				web: {
					ports: ['8101:80', '8102:80', '8103:80', '8104:80'],
					environment: [
						'A=http://$DEVICE_DOMAIN_NAME:8101/api?x=1',
						'B=http://${DEVICE_HOSTNAME}.local:8102/',
						'C=http://umbrel.local:8103',
						'D=http://umbrel.local:81049',
						'E=https://${DEVICE_DOMAIN_NAME}:8104',
						'F=http://other.example.net:8104',
					],
				},
			},
		}
		const remote = resolveRemoteDomain({enabled: true, baseDomain: 'example.com', allowAppPortApps: ['web-app']})!
		expect(remoteAppEnvironment({remote, appId: 'web-app', compose, mainPort: 8100})).toEqual({
			web: {
				A: 'https://web-app-8101-umbrel.example.com/api?x=1',
				B: 'https://web-app-8102-umbrel.example.com/',
				C: 'https://web-app-8103-umbrel.example.com',
			},
		})
	})

	test('trusted-origin lists are appended once', () => {
		const compose = {
			services: {
				app_proxy: {},
				web: {
					environment: {
						CSRF_TRUSTED_ORIGINS: 'http://umbrel.local:8000, https://web-app-umbrel.example.com',
						BETTER_AUTH_TRUSTED_ORIGINS: '',
						AUTH_ADDITIONAL_TRUSTED_ORIGINS: 'http://umbrel.local:8000',
						ALLOWED_HOSTS: '*',
					},
				},
			},
		}
		expect(remoteAppEnvironment({remote: on, appId: 'web-app', compose, mainPort: 8000})).toEqual({
			web: {
				BETTER_AUTH_TRUSTED_ORIGINS: 'https://web-app-umbrel.example.com',
				AUTH_ADDITIONAL_TRUSTED_ORIGINS: 'http://umbrel.local:8000,https://web-app-umbrel.example.com',
			},
		})
	})

	test('serviceEnvironment reads map and list forms', () => {
		expect(serviceEnvironment({environment: ['A=1', 'B=x=y', 'BARE', 3]})).toEqual(
			new Map([
				['A', '1'],
				['B', 'x=y'],
			]),
		)
		expect(serviceEnvironment({environment: {A: '1', N: 2, U: null}})).toEqual(new Map([['A', '1']]))
		expect(serviceEnvironment({})).toEqual(new Map())
	})
})

describe('appsNeedingRestart()', () => {
	const app = (id: string, state: string, compose: unknown, port = 7455) => ({
		id,
		state,
		readCompose: async () => compose,
		readManifest: async () => ({port}),
	})
	const umbreld = {
		apps: {
			instances: [
				app('lobe-chat', 'ready', lobeChat),
				app('stopped-chat', 'stopped', lobeChat),
				app('plain', 'ready', {services: {app_proxy: {}, web: {environment: {MODE: 'x'}}}}),
				{
					id: 'broken',
					state: 'ready',
					readCompose: async () => Promise.reject(new Error('bad')),
					readManifest: async () => ({}),
				},
			],
		},
	} as never

	test('lists running apps whose environment changes', async () => {
		const base = {enabled: true, baseDomain: 'example.com'}
		await expect(appsNeedingRestart(umbreld, undefined, base)).resolves.toEqual(['lobe-chat'])
		await expect(appsNeedingRestart(umbreld, base, base)).resolves.toEqual([])
		await expect(appsNeedingRestart(umbreld, base, {...base, allowAppPortApps: ['lobe-chat']})).resolves.toEqual([
			'lobe-chat',
		])
		await expect(appsNeedingRestart(umbreld, base, {...base, allowAppPortApps: ['plain']})).resolves.toEqual([])
		await expect(appsNeedingRestart(umbreld, base, {...base, enabled: false})).resolves.toEqual(['lobe-chat'])
	})
})
