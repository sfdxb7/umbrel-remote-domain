// Exponential backoff for password logins, keyed per account and per client
// IP. Attempts are counted when they start, before the password hash is
// checked, so parallel guesses cannot race past the limit, and a locked key is
// refused without running bcrypt at all.

export type ThrottlePolicy = {
	// Failures allowed before the first lockout
	freeFailures: number
	// Length of the first lockout; each further failure doubles it
	baseDelayMs: number
	maxDelayMs: number
}

export const ACCOUNT_POLICY: ThrottlePolicy = {freeFailures: 5, baseDelayMs: 2_000, maxDelayMs: 15 * 60_000}
export const IP_POLICY: ThrottlePolicy = {freeFailures: 10, baseDelayMs: 2_000, maxDelayMs: 60 * 60_000}
// A key with no failure for this long starts from zero again
export const FORGET_AFTER_MS = 24 * 60 * 60_000
export const MAX_ENTRIES = 10_000

type Entry = {failures: number; lockedUntil: number; lastFailureAt: number}

export type ThrottleKey = {key: string; policy: ThrottlePolicy}

export type ThrottleAttempt =
	| {allowed: false; retryAfterMs: number}
	| {
			allowed: true
			// The attempt succeeded: forget every key's failures
			succeed(): void
			// The attempt neither succeeded nor failed (correct password, 2FA code
			// still to come): undo its count
			cancel(): void
	  }

export const rateLimitMessage = (retryAfterSeconds: number) =>
	`Too many login attempts. Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`

export function lockoutMs(policy: ThrottlePolicy, failures: number) {
	if (failures < policy.freeFailures) return 0
	const doublings = Math.min(failures - policy.freeFailures, 30)
	return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** doublings)
}

export default class LoginThrottle {
	#entries = new Map<string, Entry>()
	#now: () => number
	#maxEntries: number

	constructor({now = Date.now, maxEntries = MAX_ENTRIES}: {now?: () => number; maxEntries?: number} = {}) {
		this.#now = now
		this.#maxEntries = maxEntries
	}

	get size() {
		return this.#entries.size
	}

	#get(key: string, now: number) {
		const entry = this.#entries.get(key)
		if (entry && now - entry.lastFailureAt > FORGET_AFTER_MS) {
			this.#entries.delete(key)
			return
		}
		return entry
	}

	#set(key: string, entry: Entry, now: number) {
		this.#entries.delete(key)
		if (this.#entries.size >= this.#maxEntries) this.#prune(now)
		this.#entries.set(key, entry)
	}

	#prune(now: number) {
		for (const [key, entry] of this.#entries) {
			if (now - entry.lastFailureAt > FORGET_AFTER_MS) this.#entries.delete(key)
		}
		// Still full: drop the least recently failed keys (Map keeps insertion order)
		for (const key of this.#entries.keys()) {
			if (this.#entries.size < this.#maxEntries) break
			this.#entries.delete(key)
		}
	}

	// Milliseconds until any of these keys accepts another attempt, or 0
	retryAfterMs(keys: ThrottleKey[]) {
		const now = this.#now()
		return Math.max(0, ...keys.map(({key}) => (this.#get(key, now)?.lockedUntil ?? 0) - now))
	}

	begin(keys: ThrottleKey[]): ThrottleAttempt {
		const retryAfterMs = this.retryAfterMs(keys)
		if (retryAfterMs > 0) return {allowed: false, retryAfterMs}

		const now = this.#now()
		const previous = new Map<string, Entry | undefined>()
		for (const {key, policy} of keys) {
			const entry = this.#get(key, now)
			previous.set(key, entry && {...entry})
			const failures = (entry?.failures ?? 0) + 1
			const delay = lockoutMs(policy, failures)
			this.#set(key, {failures, lastFailureAt: now, lockedUntil: delay ? now + delay : 0}, now)
		}

		let settled = false
		return {
			allowed: true,
			succeed: () => {
				if (settled) return
				settled = true
				for (const {key} of keys) this.#entries.delete(key)
			},
			cancel: () => {
				if (settled) return
				settled = true
				for (const {key, policy} of keys) {
					const entry = this.#entries.get(key)
					if (!entry) continue
					const before = previous.get(key)
					// Nothing else touched the key since: put it back exactly
					if (entry.failures === (before?.failures ?? 0) + 1 && entry.lastFailureAt === now) {
						if (before) this.#entries.set(key, before)
						else this.#entries.delete(key)
						continue
					}
					const failures = Math.max(0, entry.failures - 1)
					const delay = lockoutMs(policy, failures)
					this.#entries.set(key, {...entry, failures, lockedUntil: delay ? entry.lastFailureAt + delay : 0})
				}
			},
		}
	}

	clear() {
		this.#entries.clear()
	}
}
