import React from 'react'
import {useTranslation} from 'react-i18next'
import {TbAlertTriangle} from 'react-icons/tb'

import {Button} from '@/components/ui/button'
import {Input, Labeled} from '@/components/ui/input'
import {Switch} from '@/components/ui/switch'
import {toast} from '@/components/ui/toast'
import {cn} from '@/lib/utils'
import {BackButton} from '@/routes/settings/_components/shared'
import {trpcReact} from '@/trpc/trpc'
import {suggestBaseDomain} from '@/utils/remote-domain-suggestion'
import {tw} from '@/utils/tw'

type Draft = {
	enabled: boolean
	baseDomain: string
	dashboardSubdomain: string
	authSubdomain: string
	appSubdomainTemplate: string
	allowUnauthenticatedApps: string[]
	originRewriteDisabledApps: string[]
	allowPublicPathApps: string[]
	allowAppPortApps: string[]
	trustedProxies: string[]
	clientIpHeader: string
}

// Comma or space separated values (app ids, proxy addresses), as typed in the
// advanced section.
function parseList(value: string) {
	return [...new Set(value.split(/[\s,]+/).filter(Boolean))]
}

// Owner-only settings for remote domain mode. See docs/remote-domain.md.
export function RemoteDomainSettingsPanel({onBack}: {onBack: () => void}) {
	const {t} = useTranslation()
	const utils = trpcReact.useUtils()
	const remoteQ = trpcReact.lanIngress.getRemoteDomain.useQuery()
	const setMut = trpcReact.lanIngress.setRemoteDomain.useMutation()
	const twoFactorQ = trpcReact.user.is2faEnabled.useQuery()
	const [draft, setDraft] = React.useState<Draft>()

	const data = remoteQ.data
	const saved: Draft | undefined = data && {
		enabled: data.enabled,
		baseDomain: data.baseDomain,
		dashboardSubdomain: data.dashboardSubdomain,
		authSubdomain: data.authSubdomain,
		appSubdomainTemplate: data.appSubdomainTemplate,
		allowUnauthenticatedApps: 'allowUnauthenticatedApps' in data ? data.allowUnauthenticatedApps : [],
		originRewriteDisabledApps: 'originRewriteDisabledApps' in data ? data.originRewriteDisabledApps : [],
		allowPublicPathApps: 'allowPublicPathApps' in data ? data.allowPublicPathApps : [],
		allowAppPortApps: 'allowAppPortApps' in data ? data.allowAppPortApps : [],
		trustedProxies: 'trustedProxies' in data ? data.trustedProxies : [],
		clientIpHeader: 'clientIpHeader' in data ? data.clientIpHeader : '',
	}
	const defaultTrustedProxies = data && 'defaultTrustedProxies' in data ? data.defaultTrustedProxies : []
	// With no saved domain, prefill one derived from this page's address
	// (umbrel.example.com -> example.com). It is only a draft: the mode stays
	// off until the owner turns it on and saves.
	const suggestion = data && !data.baseDomain ? suggestBaseDomain(window.location.hostname) : undefined
	const [rewriteDisabledText, setRewriteDisabledText] = React.useState('')
	const [trustedProxiesText, setTrustedProxiesText] = React.useState('')
	React.useEffect(() => {
		if (saved && !draft) {
			setDraft({...saved, baseDomain: saved.baseDomain || suggestion || ''})
			setRewriteDisabledText(saved.originRewriteDisabledApps.join(', '))
			setTrustedProxiesText(saved.trustedProxies.join(', '))
		}
	}, [saved, draft, suggestion])
	const showSuggestion = !!suggestion && draft?.baseDomain === suggestion

	const apps = data && 'apps' in data ? data.apps : []

	const save = async (next: Draft, {keepDraft = false} = {}) => {
		try {
			const {restartRequired} = await setMut.mutateAsync(next)
			if (!keepDraft) setDraft(next)
			await Promise.all([utils.lanIngress.getRemoteDomain.invalidate(), utils.apps.list.invalidate()])
			toast.success(t('remote-domain.saved'), {area: 'settings'})
			if (restartRequired.length > 0) {
				toast.info(t('remote-domain.restart-required', {apps: restartRequired.join(', ')}), {area: 'settings'})
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : t('unknown-error')
			toast.error(t('remote-domain.save-error', {message}), {area: 'settings'})
		}
	}

	const update = (patch: Partial<Draft>) => setDraft((current) => (current ? {...current, ...patch} : current))

	// Allow-list switches save immediately on top of the saved settings, so
	// unsaved edits in the form above are not applied by accident.
	const toggleApp = (appId: string, allowed: boolean) => {
		if (!saved) return
		const allow = new Set(saved.allowUnauthenticatedApps)
		if (allowed) allow.add(appId)
		else allow.delete(appId)
		const allowUnauthenticatedApps = [...allow]
		void save({...saved, allowUnauthenticatedApps}, {keepDraft: true})
		update({allowUnauthenticatedApps})
	}

	const togglePublicPaths = (appId: string, allowed: boolean) => {
		if (!saved) return
		const allow = new Set(saved.allowPublicPathApps)
		if (allowed) allow.add(appId)
		else allow.delete(appId)
		const allowPublicPathApps = [...allow]
		void save({...saved, allowPublicPathApps}, {keepDraft: true})
		update({allowPublicPathApps})
	}

	const toggleAppPorts = (appId: string, allowed: boolean) => {
		if (!saved) return
		const allow = new Set(saved.allowAppPortApps)
		if (allowed) allow.add(appId)
		else allow.delete(appId)
		const allowAppPortApps = [...allow]
		void save({...saved, allowAppPortApps}, {keepDraft: true})
		update({allowAppPortApps})
	}

	// A remote domain puts the login page on the internet. Nudge the owner
	// towards 2FA without blocking the setting.
	const show2faWarning = !!draft?.enabled && twoFactorQ.data === false

	return (
		<div className='flex flex-col gap-y-5'>
			<BackButton onClick={onBack}>{t('advanced-settings')}</BackButton>
			<div className='space-y-1 px-1'>
				<h3 className='text-18 leading-tight font-semibold'>{t('remote-domain.title')}</h3>
				<p className='text-13 leading-tight text-white/45'>{t('remote-domain.description')}</p>
			</div>
			<div className='flex items-start gap-3 rounded-12 bg-[#F5A623]/10 p-3'>
				<TbAlertTriangle className='mt-0.5 size-5 shrink-0 text-[#F5A623]' />
				<span className='text-12 leading-tight text-white/60'>{t('remote-domain.warning')}</span>
			</div>
			{show2faWarning && (
				<div className='flex items-start gap-3 rounded-12 bg-[#F5A623]/10 p-3'>
					<TbAlertTriangle className='mt-0.5 size-5 shrink-0 text-[#F5A623]' />
					<span className='text-12 leading-tight text-white/60'>{t('remote-domain.2fa-warning')}</span>
				</div>
			)}
			{draft && (
				<form
					className='flex flex-col gap-y-3'
					onSubmit={(event) => {
						event.preventDefault()
						void save(draft)
					}}
				>
					<label className={cardClass}>
						<div className='flex-1 space-y-1'>
							<h3 className='text-14 leading-tight font-medium'>{t('remote-domain.enable')}</h3>
							<p className='text-13 leading-tight opacity-45'>
								{data?.active && data.dashboardOrigin
									? t('remote-domain.active', {origin: data.dashboardOrigin})
									: t('remote-domain.inactive')}
							</p>
						</div>
						<Switch checked={draft.enabled} onCheckedChange={(enabled) => update({enabled})} />
					</label>
					<Labeled label={t('remote-domain.base-domain')}>
						<Input
							sizeVariant='short-square'
							placeholder='example.com'
							value={draft.baseDomain}
							onValueChange={(baseDomain) => update({baseDomain})}
						/>
					</Labeled>
					<p className='-mt-1 px-1 text-12 leading-tight text-white/45'>
						{showSuggestion
							? t('remote-domain.base-domain-suggested', {domain: suggestion})
							: t('remote-domain.base-domain-help')}
					</p>
					<details className='rounded-12 bg-white/4 px-4 py-3'>
						<summary className='cursor-pointer text-14 font-medium'>{t('remote-domain.advanced')}</summary>
						<div className='mt-3 flex flex-col gap-y-3'>
							<p className='text-12 leading-tight text-white/45'>{t('remote-domain.advanced-description')}</p>
							<p className='text-12 leading-tight text-white/45'>{t('remote-domain.advanced-login-note')}</p>
							<Labeled label={t('remote-domain.dashboard-subdomain')}>
								<Input
									sizeVariant='short-square'
									value={draft.dashboardSubdomain}
									onValueChange={(dashboardSubdomain) => update({dashboardSubdomain})}
								/>
							</Labeled>
							<Labeled label={t('remote-domain.auth-subdomain')}>
								<Input
									sizeVariant='short-square'
									value={draft.authSubdomain}
									onValueChange={(authSubdomain) => update({authSubdomain})}
								/>
							</Labeled>
							<Labeled label={t('remote-domain.app-subdomain-template')}>
								<Input
									sizeVariant='short-square'
									value={draft.appSubdomainTemplate}
									onValueChange={(appSubdomainTemplate) => update({appSubdomainTemplate})}
								/>
							</Labeled>
							<Labeled label={t('remote-domain.origin-rewrite-disabled')}>
								<Input
									sizeVariant='short-square'
									placeholder='app-id, other-app-id'
									value={rewriteDisabledText}
									onValueChange={(value) => {
										setRewriteDisabledText(value)
										update({originRewriteDisabledApps: parseList(value)})
									}}
								/>
							</Labeled>
							<p className='-mt-1 text-12 leading-tight text-white/45'>
								{t('remote-domain.origin-rewrite-disabled-help')}
							</p>
							<Labeled label={t('remote-domain.trusted-proxies')}>
								<Input
									sizeVariant='short-square'
									placeholder={defaultTrustedProxies.join(', ')}
									value={trustedProxiesText}
									onValueChange={(value) => {
										setTrustedProxiesText(value)
										update({trustedProxies: parseList(value)})
									}}
								/>
							</Labeled>
							<p className='-mt-1 text-12 leading-tight text-white/45'>{t('remote-domain.trusted-proxies-help')}</p>
							<Labeled label={t('remote-domain.client-ip-header')}>
								<Input
									sizeVariant='short-square'
									placeholder='X-Forwarded-For'
									value={draft.clientIpHeader}
									onValueChange={(clientIpHeader) => update({clientIpHeader: clientIpHeader.trim()})}
								/>
							</Labeled>
							<p className='-mt-1 text-12 leading-tight text-white/45'>{t('remote-domain.client-ip-header-help')}</p>
						</div>
					</details>
					<Button type='submit' variant='primary' size='dialog' disabled={setMut.isPending}>
						{t('remote-domain.save')}
					</Button>
				</form>
			)}
			{draft && apps.length > 0 && (
				<div className='flex flex-col gap-y-2'>
					<h4 className='px-1 text-14 font-medium'>{t('remote-domain.apps-title')}</h4>
					<p className='px-1 text-12 leading-tight text-white/45'>{t('remote-domain.apps-description')}</p>
					<p className='px-1 text-12 leading-tight text-white/45'>{t('remote-domain.apps-restart-note')}</p>
					{apps.map((app) => (
						<div key={app.appId} className={cn(cardClass, 'flex-col gap-y-3')}>
							<div className='flex w-full items-start gap-x-2'>
								<div className='min-w-0 flex-1 space-y-1'>
									<h3 className='truncate text-14 leading-tight font-medium'>{app.appId}</h3>
									<p className='truncate text-12 leading-tight opacity-45'>
										{app.authEnabled
											? app.origin
											: app.allowed
												? t('remote-domain.app-allowed', {origin: app.origin})
												: t('remote-domain.app-blocked')}
									</p>
								</div>
								{!app.authEnabled && (
									<Switch
										checked={app.allowed}
										disabled={setMut.isPending}
										onCheckedChange={(allowed) => toggleApp(app.appId, allowed)}
									/>
								)}
							</div>
							{app.authEnabled && app.publicPaths.length > 0 && (
								<div className='flex w-full items-start gap-x-2 border-t border-white/6 pt-3'>
									<div className='min-w-0 flex-1 space-y-1'>
										<h4 className='text-13 leading-tight font-medium'>{t('remote-domain.public-paths')}</h4>
										<p className='text-12 leading-tight break-all opacity-45'>
											{t('remote-domain.public-paths-help', {paths: app.publicPaths.join(', ')})}
										</p>
									</div>
									<Switch
										checked={app.publicPathsAllowed}
										disabled={setMut.isPending}
										onCheckedChange={(allowed) => togglePublicPaths(app.appId, allowed)}
									/>
								</div>
							)}
							{app.ports.length > 0 && (app.authEnabled || app.allowed) && (
								<div className='flex w-full items-start gap-x-2 border-t border-white/6 pt-3'>
									<div className='min-w-0 flex-1 space-y-1'>
										<h4 className='text-13 leading-tight font-medium'>{t('remote-domain.app-ports')}</h4>
										<p className='text-12 leading-tight break-all opacity-45'>
											{t('remote-domain.app-ports-help', {origins: app.ports.map((port) => port.origin).join(', ')})}
										</p>
									</div>
									<Switch
										checked={app.portsAllowed}
										disabled={setMut.isPending}
										onCheckedChange={(allowed) => toggleAppPorts(app.appId, allowed)}
									/>
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	)
}

const cardClass = tw`flex items-start gap-x-2 rounded-12 bg-white/6 p-4`
