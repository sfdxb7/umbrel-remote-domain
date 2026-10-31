import {describe, expect, test} from 'vitest'

import LoginThrottle, {
	ACCOUNT_POLICY,
	FORGET_AFTER_MS,
	IP_POLICY,
	lockoutMs,
	rateLimitMessage,
	type ThrottleKey,
} from './login-throttle.js'

function clock(start = 1_000_000) {
	const state = {now: start}
	return {state, now: () => state.now}
}

const account = (key = 'account:remote:0'): ThrottleKey => ({key, policy: ACCOUNT_POLICY})
const ip = (key = 'ip:203.0.113.5'): ThrottleKey => ({key, policy: IP_POLICY})

// Record one failed attempt (begin without succeed or cancel)
function fail(throttle: LoginThrottle, keys: ThrottleKey[]) {
	const attempt = throttle.begin(keys)
	expect(attempt.allowed).toBe(true)
}

describe('lockoutMs()', () => {
	test('allows the free failures, then doubles up to the cap', () => {
		expect(lockoutMs(ACCOUNT_POLICY, 4)).toBe(0)
		expect(lockoutMs(ACCOUNT_POLICY, 5)).toBe(2_000)
		expect(lockoutMs(ACCOUNT_POLICY, 6)).toBe(4_000)
		expect(lockoutMs(ACCOUNT_POLICY, 10)).toBe(64_000)
		expect(lockoutMs(ACCOUNT_POLICY, 50)).toBe(15 * 60_000)
		expect(lockoutMs(IP_POLICY, 9)).toBe(0)
		expect(lockoutMs(IP_POLICY, 10)).toBe(2_000)
		expect(lockoutMs(IP_POLICY, 1_000)).toBe(60 * 60_000)
	})

	test('formats the retry message', () => {
		expect(rateLimitMessage(1)).toBe('Too many login attempts. Try again in 1 second.')
		expect(rateLimitMessage(30)).toBe('Too many login attempts. Try again in 30 seconds.')
	})
})

describe('LoginThrottle', () => {
	test('locks an account after the free failures and backs off exponentially', () => {
		const {state, now} = clock()
		const throttle = new LoginThrottle({now})
		for (let i = 0; i < 4; i++) fail(throttle, [account()])
		expect(throttle.retryAfterMs([account()])).toBe(0)
		fail(throttle, [account()]) // 5th failure: 2s
		expect(throttle.begin([account()])).toEqual({allowed: false, retryAfterMs: 2_000})

		state.now += 2_000
		fail(throttle, [account()]) // 6th failure: 4s
		expect(throttle.retryAfterMs([account()])).toBe(4_000)
		state.now += 3_999
		expect(throttle.begin([account()]).allowed).toBe(false)
		state.now += 1
		fail(throttle, [account()]) // 7th: 8s
		expect(throttle.retryAfterMs([account()])).toBe(8_000)
	})

	test('a refused attempt does not extend the lockout', () => {
		const {state, now} = clock()
		const throttle = new LoginThrottle({now})
		for (let i = 0; i < 5; i++) fail(throttle, [account()])
		for (let i = 0; i < 100; i++) expect(throttle.begin([account()]).allowed).toBe(false)
		state.now += 2_000
		expect(throttle.retryAfterMs([account()])).toBe(0)
	})

	test('counts attempts up front so parallel guesses cannot race past the limit', () => {
		const throttle = new LoginThrottle({now: clock().now})
		// Five attempts start before any finishes: the fifth already locks
		const attempts = Array.from({length: 6}, () => throttle.begin([account()]))
		expect(attempts.slice(0, 5).every((attempt) => attempt.allowed)).toBe(true)
		expect(attempts[5]!.allowed).toBe(false)
	})

	test('success clears the counters', () => {
		const throttle = new LoginThrottle({now: clock().now})
		for (let i = 0; i < 4; i++) fail(throttle, [account(), ip()])
		const attempt = throttle.begin([account(), ip()])
		if (!attempt.allowed) throw new Error('expected allowed')
		attempt.succeed()
		expect(throttle.size).toBe(0)
		for (let i = 0; i < 4; i++) fail(throttle, [account()])
		expect(throttle.retryAfterMs([account()])).toBe(0)
	})

	test('cancel undoes an attempt that neither failed nor succeeded', () => {
		const throttle = new LoginThrottle({now: clock().now})
		for (let i = 0; i < 4; i++) fail(throttle, [account()])
		for (let i = 0; i < 10; i++) {
			const attempt = throttle.begin([account()])
			if (!attempt.allowed) throw new Error('expected allowed')
			attempt.cancel()
			attempt.cancel() // idempotent
		}
		expect(throttle.retryAfterMs([account()])).toBe(0)
		fail(throttle, [account()])
		expect(throttle.retryAfterMs([account()])).toBe(2_000)

		const fresh = new LoginThrottle({now: clock().now})
		const attempt = fresh.begin([account()])
		if (!attempt.allowed) throw new Error('expected allowed')
		attempt.cancel()
		expect(fresh.size).toBe(0)
	})

	test('cancel after other attempts only removes its own count', () => {
		const throttle = new LoginThrottle({now: clock().now})
		const first = throttle.begin([account()])
		for (let i = 0; i < 3; i++) fail(throttle, [account()]) // 4 counted
		if (!first.allowed) throw new Error('expected allowed')
		first.cancel() // back to 3
		fail(throttle, [account()])
		expect(throttle.retryAfterMs([account()])).toBe(0)
		fail(throttle, [account()]) // 5th failure locks
		expect(throttle.retryAfterMs([account()])).toBe(2_000)
	})

	test('keys are independent: other accounts and IPs are unaffected', () => {
		const throttle = new LoginThrottle({now: clock().now})
		for (let i = 0; i < 5; i++) fail(throttle, [account('account:remote:0'), ip('ip:203.0.113.5')])
		expect(throttle.retryAfterMs([account('account:remote:0')])).toBeGreaterThan(0)
		// The LAN scope of the same account still works
		expect(throttle.retryAfterMs([account('account:local:0')])).toBe(0)
		// The IP is not locked yet (10 free failures)
		expect(throttle.retryAfterMs([ip('ip:203.0.113.5')])).toBe(0)
		// One locked key is enough to refuse
		expect(throttle.begin([account('account:remote:0'), ip('ip:198.51.100.1')]).allowed).toBe(false)
	})

	test('an IP spraying many account names is locked', () => {
		const throttle = new LoginThrottle({now: clock().now})
		for (let i = 0; i < 10; i++) fail(throttle, [account(`account:remote:unknown:user${i}`), ip()])
		const attempt = throttle.begin([account('account:remote:unknown:new'), ip()])
		expect(attempt).toEqual({allowed: false, retryAfterMs: 2_000})
	})

	test('forgets failures after a quiet day', () => {
		const {state, now} = clock()
		const throttle = new LoginThrottle({now})
		for (let i = 0; i < 20; i++) {
			fail(throttle, [account()])
			state.now += 16 * 60_000
		}
		expect(throttle.retryAfterMs([account()])).toBe(0) // capped at 15 min and elapsed
		fail(throttle, [account()])
		expect(throttle.retryAfterMs([account()])).toBe(15 * 60_000)
		state.now += FORGET_AFTER_MS + 1
		fail(throttle, [account()])
		expect(throttle.retryAfterMs([account()])).toBe(0)
	})

	test('stays bounded, dropping expired keys and then the oldest', () => {
		const {state, now} = clock()
		const throttle = new LoginThrottle({now, maxEntries: 3})
		fail(throttle, [ip('ip:a')])
		state.now += FORGET_AFTER_MS + 1
		fail(throttle, [ip('ip:b')])
		fail(throttle, [ip('ip:c')])
		fail(throttle, [ip('ip:d')]) // prunes expired a
		expect(throttle.size).toBe(3)
		fail(throttle, [ip('ip:e')]) // drops oldest b
		expect(throttle.size).toBe(3)
		for (let i = 0; i < 9; i++) fail(throttle, [ip('ip:e')])
		expect(throttle.retryAfterMs([ip('ip:e')])).toBe(2_000)
	})
})
