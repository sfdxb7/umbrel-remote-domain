// Turn an untrusted redirect target into a same-origin path.
//
// Only the pathname, search and hash are kept, so absolute URLs lose their
// authority. A path that still starts with several slashes (for example
// `/.//evil.com`, `/a/..//evil.com` or `/%2e//evil.com` after URL
// normalisation) would be a protocol-relative URL to a browser, so leading
// slashes are collapsed into one.
export default function safeRedirectPath(value: unknown) {
	if (typeof value !== 'string') return '/'
	try {
		const url = new URL(value, 'http://umbrel.invalid')
		const path = `${url.pathname}${url.search}${url.hash}`
		const collapsed = path.replace(/^[/\\]+/, '/')
		return collapsed.startsWith('/') ? collapsed : '/'
	} catch {
		return '/'
	}
}
