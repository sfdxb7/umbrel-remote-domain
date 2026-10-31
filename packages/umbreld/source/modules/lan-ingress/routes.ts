import z from 'zod'
import {TRPCError} from '@trpc/server'

import {privateProcedure, privateProcedureWithMembers, router} from '../server/trpc/trpc.js'
import {OWNER_USER_ID} from '../user/constants.js'
import {
	DEFAULT_APP_SUBDOMAIN_TEMPLATE,
	DEFAULT_AUTH_SUBDOMAIN,
	DEFAULT_DASHBOARD_SUBDOMAIN,
	DEFAULT_TRUSTED_PROXIES,
	validateRemoteDomainSettings,
	type RemoteDomainSettings,
} from './remote-domain.js'

const RemoteDomainSettingsSchema = z.object({
	enabled: z.boolean(),
	baseDomain: z.string().trim().toLowerCase().max(253),
	dashboardSubdomain: z.string().trim().toLowerCase().max(253).optional(),
	authSubdomain: z.string().trim().toLowerCase().max(253).optional(),
	appSubdomainTemplate: z.string().trim().toLowerCase().max(253).optional(),
	allowUnauthenticatedApps: z
		.array(z.string().regex(/^[a-zA-Z0-9-]+$/))
		.max(500)
		.optional(),
	originRewriteDisabledApps: z
		.array(z.string().regex(/^[a-zA-Z0-9-]+$/))
		.max(500)
		.optional(),
	allowPublicPathApps: z
		.array(z.string().regex(/^[a-zA-Z0-9-]+$/))
		.max(500)
		.optional(),
	trustedProxies: z.array(z.string().trim().max(64)).max(100).optional(),
	clientIpHeader: z.string().trim().max(64).optional(),
})

export default router({
	getCertificateStatus: privateProcedure.query(async ({ctx}) => ctx.umbreld.lanIngress.getCertificateStatus()),
	resetCa: privateProcedure.mutation(async ({ctx}) => ctx.umbreld.lanIngress.resetCa()),

	// Members need the active domain so app links open on the right host. The
	// per-app allow list and app status stay owner-only.
	getRemoteDomain: privateProcedureWithMembers.query(async ({ctx}) => {
		const isOwner = (ctx.principal?.accountId ?? OWNER_USER_ID) === OWNER_USER_ID
		const lanIngress = ctx.umbreld.lanIngress
		const stored = await ctx.umbreld.store.get('settings.remoteDomain')
		const active = lanIngress.remoteDomain
		const settings = {
			enabled: stored?.enabled ?? false,
			// Empty until the owner saves a domain; the UI suggests one from its own host.
			baseDomain: stored?.baseDomain ?? '',
			dashboardSubdomain: stored?.dashboardSubdomain ?? DEFAULT_DASHBOARD_SUBDOMAIN,
			authSubdomain: stored?.authSubdomain ?? DEFAULT_AUTH_SUBDOMAIN,
			appSubdomainTemplate: stored?.appSubdomainTemplate ?? DEFAULT_APP_SUBDOMAIN_TEMPLATE,
		}
		const result = {
			...settings,
			active: !!active,
			dashboardOrigin: active ? `https://${active.dashboardHost}` : undefined,
			authOrigin: active?.authOrigin,
		}
		if (!isOwner) return result
		return {
			...result,
			allowUnauthenticatedApps: stored?.allowUnauthenticatedApps ?? [],
			originRewriteDisabledApps: stored?.originRewriteDisabledApps ?? [],
			allowPublicPathApps: stored?.allowPublicPathApps ?? [],
			trustedProxies: stored?.trustedProxies ?? [],
			defaultTrustedProxies: DEFAULT_TRUSTED_PROXIES,
			clientIpHeader: stored?.clientIpHeader ?? '',
			apps: lanIngress.remoteAppStatus(),
		}
	}),

	// Owner-only. Saving refreshes LAN ingress so routing changes immediately.
	setRemoteDomain: privateProcedure.input(RemoteDomainSettingsSchema).mutation(async ({ctx, input}) => {
		const next: RemoteDomainSettings = {
			...input,
			allowUnauthenticatedApps: [...new Set(input.allowUnauthenticatedApps ?? [])],
			originRewriteDisabledApps: [...new Set(input.originRewriteDisabledApps ?? [])],
			allowPublicPathApps: [...new Set(input.allowPublicPathApps ?? [])],
			trustedProxies: [...new Set((input.trustedProxies ?? []).filter(Boolean))],
			clientIpHeader: input.clientIpHeader || undefined,
		}
		if (next.enabled || next.baseDomain) {
			const error = validateRemoteDomainSettings(next)
			if (error) throw new TRPCError({code: 'BAD_REQUEST', message: error})
		}
		const previous = await ctx.umbreld.store.get('settings.remoteDomain')
		await ctx.umbreld.store.set('settings.remoteDomain', next)
		try {
			await ctx.umbreld.lanIngress.refresh()
		} catch (error) {
			if (previous === undefined) await ctx.umbreld.store.delete('settings.remoteDomain')
			else await ctx.umbreld.store.set('settings.remoteDomain', previous)
			await ctx.umbreld.lanIngress.refresh().catch(() => {})
			throw error
		}
		return true
	}),
})
