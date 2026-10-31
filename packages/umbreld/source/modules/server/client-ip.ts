import net from 'node:net'
import type http from 'node:http'

import {isRemoteDomainRequest, type RemoteDomain} from '../lan-ingress/remote-domain.js'

// Strip IPv6 brackets and the IPv4-mapped prefix. Returns undefined for
// anything that is not an IP address.
export function normaliseAddress(value: string | undefined) {
	if (!value) return
	let address = value.trim()
	if (address.startsWith('[') && address.includes(']')) address = address.slice(1, address.indexOf(']'))
	if (address.toLowerCase().startsWith('::ffff:') && net.isIPv4(address.slice(7))) address = address.slice(7)
	return net.isIP(address) ? address : undefined
}

function isLoopback(address: string) {
	return address === '::1' || (net.isIPv4(address) && address.startsWith('127.'))
}

const matchers = new WeakMap<string[], net.BlockList>()

function trustedProxyList(entries: string[]) {
	let list = matchers.get(entries)
	if (list) return list
	list = new net.BlockList()
	for (const entry of entries) {
		const [address, prefix] = entry.split('/')
		const family = net.isIP(address ?? '')
		if (!family) continue
		const type = family === 4 ? 'ipv4' : 'ipv6'
		if (prefix === undefined) list.addAddress(address!, type)
		else list.addSubnet(address!, Number(prefix), type)
	}
	matchers.set(entries, list)
	return list
}

export function isTrustedProxy(address: string, entries: string[]) {
	return trustedProxyList(entries).check(address, net.isIPv4(address) ? 'ipv4' : 'ipv6')
}

function headerValues(value: string | string[] | undefined) {
	if (value === undefined) return []
	return (Array.isArray(value) ? value : [value]).flatMap((entry) => entry.split(','))
}

// The address of the client that made the request, for rate limiting.
//
// umbreld's own LAN ingress reaches the dashboard over loopback and appends the
// peer it saw to X-Forwarded-For, so that one loopback hop is skipped.
// Beyond that, forwarded addresses are
// only believed for remote-domain requests and only from the reverse proxies
// the owner trusts (loopback and private networks by default). A client that
// talks to umbreld directly, or through an untrusted hop, is identified by
// that hop's address and cannot choose its own.
export function requestClientIp(
	request: http.IncomingMessage,
	remote: RemoteDomain | undefined,
	hostname: string | undefined,
): string {
	const socketAddress = normaliseAddress(request.socket?.remoteAddress) ?? 'unknown'
	const forwarded = headerValues(request.headers['x-forwarded-for']).map(normaliseAddress)
	// Anything left of an unparseable entry cannot be attributed to a hop.
	const lastInvalid = forwarded.lastIndexOf(undefined)
	const chain = [...(forwarded.slice(lastInvalid + 1) as string[]), socketAddress]

	// Skip umbreld's own loopback hop (LAN ingress to Express), once only: a
	// loopback address further left came from a proxy on the same host.
	let index = chain.length - 1
	if (index > 0 && isLoopback(chain[index]!)) index--
	if (!remote || !isRemoteDomainRequest(remote, hostname)) return chain[index]!

	const trusted = (address: string) => isTrustedProxy(address, remote.trustedProxies)
	if (!trusted(chain[index]!)) return chain[index]!

	if (remote.clientIpHeader) {
		const headerAddress = normaliseAddress(headerValues(request.headers[remote.clientIpHeader])[0])
		if (headerAddress) return headerAddress
	}

	while (index > 0 && trusted(chain[index]!)) index--
	return chain[index]!
}

type UmbreldLike = {lanIngress: {remoteDomain: RemoteDomain | undefined}}

// Express requests: is this on the public remote domain?
export function isRemoteDomainHttpRequest(umbreld: UmbreldLike, request: {hostname?: string}) {
	return isRemoteDomainRequest(umbreld.lanIngress.remoteDomain, request.hostname)
}

export function loginClientFromRequest(umbreld: UmbreldLike, request: http.IncomingMessage & {hostname?: string}) {
	const remote = umbreld.lanIngress.remoteDomain
	return {
		ip: requestClientIp(request, remote, request.hostname),
		remote: isRemoteDomainRequest(remote, request.hostname),
	}
}
