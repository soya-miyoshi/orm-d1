/**
 * Set both packages to one version, in lockstep.
 *
 *   node scripts/set-version.mjs 0.2.0
 *
 * Three things have to move together — `orm-d1`'s version, `orm-d1-kit`'s
 * version, and `orm-d1-kit`'s peer range on `orm-d1` — and the release workflow
 * refuses to publish if they disagree. Doing it by hand across two files is
 * exactly the step that gets half-done, so it is a script.
 *
 * Deliberately writes the peer range as `^<version>`: lockstep means the kit
 * published alongside a given orm-d1 is the one it is tested against.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];

if (!version) {
	console.error('usage: node scripts/set-version.mjs <version>');
	process.exit(1);
}

// The subset of semver this project actually uses. A prerelease is allowed
// because 0.x releases and rc builds are both plausible here.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
	console.error(`Not a version: ${version}. Expected e.g. 0.2.0 or 1.0.0-rc.1.`);
	process.exit(1);
}

/** Rewrite one field without reformatting the file — these are tab-indented. */
const edit = (path, replacements) => {
	const before = readFileSync(path, 'utf8');
	let after = before;

	for (const [pattern, replacement] of replacements) {
		if (!pattern.test(after)) {
			console.error(`${path}: could not find ${pattern}`);
			process.exit(1);
		}
		after = after.replace(pattern, replacement);
	}

	writeFileSync(path, after);
	return before !== after;
};

edit('package.json', [[/("version":\s*)"[^"]+"/, `$1"${version}"`]]);
edit('kit/package.json', [
	[/("version":\s*)"[^"]+"/, `$1"${version}"`],
	[/("orm-d1":\s*)"[^"]+"/, `$1"^${version}"`],
]);

console.log(`orm-d1 and orm-d1-kit are now ${version} (kit peer: ^${version}).`);
console.log('Next: npm run check, commit, tag v' + version + ', draft the release.');
