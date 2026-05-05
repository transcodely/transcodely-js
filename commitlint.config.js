/**
 * Conventional commits config — keep in sync with the allowed `types` in
 * .github/workflows/pr-title.yml and the `changelog-sections` in
 * release-please-config.json. release-please derives version bumps from
 * these types, so divergence breaks semver correctness.
 */
export default {
	extends: ['@commitlint/config-conventional'],
	rules: {
		'type-enum': [
			2,
			'always',
			[
				'feat',
				'fix',
				'perf',
				'revert',
				'docs',
				'style',
				'chore',
				'refactor',
				'test',
				'build',
				'ci'
			]
		],
		'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
		'header-max-length': [2, 'always', 100]
	}
};
