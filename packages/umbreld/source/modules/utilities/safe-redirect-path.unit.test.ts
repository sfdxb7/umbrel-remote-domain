import {describe, expect, test} from 'vitest'

import safeRedirectPath from './safe-redirect-path.js'

describe('safeRedirectPath()', () => {
	test.each([
		['/', '/'],
		['/admin?tab=1#top', '/admin?tab=1#top'],
		['relative/path', '/relative/path'],
		['https://evil.example/steal', '/steal'],
		['//evil.example/steal', '/steal'],
		['///evil.example', '/'],
		['/\\evil.example', '/'],
		['/.//evil.example', '/evil.example'],
		['/a/..//evil.example/x', '/evil.example/x'],
		['\\\\evil.example\\x', '/x'],
		['/%2F%2Fevil.example', '/%2F%2Fevil.example'],
		['javascript:alert(1)', '/'],
		[undefined, '/'],
		[42, '/'],
	])('%s -> %s', (input, expected) => {
		const result = safeRedirectPath(input)
		expect(result).toBe(expected)
		// Whatever comes out must stay on the current origin.
		expect(new URL(result, 'https://app.example.com').origin).toBe('https://app.example.com')
	})
})
