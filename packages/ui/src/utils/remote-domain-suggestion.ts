// Suggest a remote-domain base domain from the address the dashboard is open
// on: umbrel.example.com -> example.com. Only a suggestion for the settings
// form; nothing is saved or enabled until the owner confirms it.
const NO_SUGGESTION_SUFFIXES = ['.local', '.localhost', '.ts.net', '.onion', '.internal', '.lan', '.home', '.test']
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function suggestBaseDomain(hostname: string | undefined): string | undefined {
	let host = (hostname ?? '').trim().toLowerCase()
	if (host.endsWith('.')) host = host.slice(0, -1)
	if (!host) return
	// IPv6 literals (bracketed or not) and IPv4 addresses
	if (host.includes(':') || host.startsWith('[')) return
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return
	if (host === 'localhost') return
	if (NO_SUGGESTION_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1))) return

	const labels = host.split('.')
	// Single-label hosts (umbrel, MagicDNS short names) and bare two-label hosts
	// (example.com -> com) have no usable parent domain.
	if (labels.length < 3) return
	if (!labels.every((label) => LABEL.test(label))) return
	const base = labels.slice(1)
	if (/^\d+$/.test(base.at(-1)!)) return
	return base.join('.')
}
