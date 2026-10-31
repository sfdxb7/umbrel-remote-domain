import {indexBy} from 'remeda'

import {UserApp} from '@/trpc/trpc'

export function firstNameFromFullName(name: string) {
	return name.split(' ')[0]
}

export function sleep(milliseconds: number) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export function isNormalNumber(value: number | null | undefined): value is number {
	if (value === undefined || value === null) return false
	return value !== Infinity && value !== -Infinity && !isNaN(value)
}

// https://stackoverflow.com/a/39419171
export function assertUnreachable(x: never): never {
	throw new Error("Didn't expect to get here, got " + x)
}

/**
 * Does what lodash's keyBy does, but returns with better types
 */
export function keyBy<T, U extends keyof T>(array: ReadonlyArray<T>, key: U): Record<T[U] & string, T> {
	return indexBy(array, (el) => el[key])
}

// Not using `url-join` or others because they remove desired slashes after joining. `new URL('?bla=1', 'http://localhost:3001/a/').href` preserves trailing slash to return 'http://localhost:3001/a/?bla=1'
// The `transmission` app depends on this behavior because the app's full path is `http://localhost:9091/transmission/web/` but when joining a query string, we want it to be `http://localhost:9091/transmission/web/?bla=1`
export function urlJoin(base: string, path: string) {
	return new URL(path, base).href
}

/** `urlJoin` doesn't work when used like so: `urlJoin('foo', 'bar')`, and sometimes we just want basic behavior */
export function pathJoin(base: string, path: string) {
	// Remove trailing slash from base and leading slash from path
	return base.replace(/\/$/, '') + '/' + path.replace(/^\//, '')
}

// True when the dashboard is being viewed through the remote domain (VPS mode),
// i.e. the page host is the base domain or a subdomain of it.
export function isRemoteDomainHost(hostname: string, remoteBaseDomain?: string) {
	if (!remoteBaseDomain) return false
	const host = hostname.toLowerCase().replace(/\.$/, '')
	return host === remoteBaseDomain || host.endsWith(`.${remoteBaseDomain}`)
}

type AppUrlFields = Pick<UserApp, 'hiddenService' | 'port'> & {remoteUrl?: string | null}

// `remoteBaseDomain` is only set while remote domain mode is active. On the
// remote domain, apps open on their own https host; IP, LAN, mDNS and
// Tailscale pages keep using ports.
export function appToUrl(
	app: AppUrlFields,
	protocol = location.protocol,
	remoteBaseDomain?: string,
	page: Pick<Location, 'protocol' | 'hostname' | 'origin'> = location,
) {
	if (page.origin.indexOf('.onion') !== -1) return `${page.protocol}//${app.hiddenService}`
	if (app.remoteUrl && isRemoteDomainHost(page.hostname, remoteBaseDomain)) return app.remoteUrl
	return `${protocol}//${page.hostname}:${app.port}`
}

export function appToUrlWithAppPath(app: UserApp, protocol = location.protocol, remoteBaseDomain?: string) {
	return urlJoin(appToUrl(app, protocol, remoteBaseDomain), app.path ?? '')
}

const ALWAYS_OPEN_HTTPS_REQUIRED_APPS_KEY = 'UMBREL_ALWAYS_OPEN_HTTPS_REQUIRED_APPS'

export function getAlwaysOpenHttpsRequiredApps() {
	return localStorage.getItem(ALWAYS_OPEN_HTTPS_REQUIRED_APPS_KEY) === 'true'
}

export function setAlwaysOpenHttpsRequiredApps(value: boolean) {
	if (value) {
		localStorage.setItem(ALWAYS_OPEN_HTTPS_REQUIRED_APPS_KEY, 'true')
	} else {
		localStorage.removeItem(ALWAYS_OPEN_HTTPS_REQUIRED_APPS_KEY)
	}
}

export function isOnionPage() {
	return window.location.origin.indexOf('.onion') !== -1
}

export function preloadImage(url: string): Promise<void> {
	return new Promise((resolve) => {
		const img = new Image()
		const handleLoad = () => {
			img.removeEventListener('load', handleLoad)
			resolve()
		}
		img.addEventListener('load', handleLoad)
		img.src = url
	})
}

// ---

export function isWindows() {
	return /Win/i.test(navigator.userAgent)
}

export function isLinux() {
	return /Linux/i.test(navigator.userAgent)
}

export function isMac() {
	return /Mac/i.test(navigator.userAgent)
}

export function platform() {
	if (isWindows()) return 'windows'
	if (isLinux()) return 'linux'
	if (isMac()) return 'mac'
	return 'other'
}

// NOTE: in Chrome, this can be `true` when emulating a touch device
export const IS_ANDROID = /Android/i.test(navigator.userAgent)

export const IS_DEV = localStorage.getItem('debug') === 'true'

export function cmdOrCtrl() {
	return isMac() ? '⌘' : 'Ctrl+'
}
