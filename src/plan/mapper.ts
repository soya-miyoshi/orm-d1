/**
 * Row mappers.
 *
 * Rule R2 forbids `new Function`, so a mapper is a monomorphic loop over
 * precomputed arrays rather than generated source. Every output object is
 * built with the same keys in the same order, so V8 gives them one hidden
 * class — that shape stability is most of the win.
 */

export interface FieldPlan {
	/** Output path: `['id']`, or `['user', 'id']` for a nested selection. */
	readonly path: readonly string[];
	/** Position in the result row. */
	readonly index: number;
	/** Key in the keyed (batch) read path. */
	readonly key: string;
	readonly decode: ((value: unknown) => unknown) | undefined;
	/**
	 * True when this leaf is a plain table column, as opposed to a `sql`
	 * expression. A nullable group's collapse-to-`null` decision is made from
	 * its Column leaves alone — matching Drizzle, which never installs a
	 * nullify entry for a non-Column field (`is(field, Column)` in
	 * `drizzle-orm/utils.js`) and so never lets it veto the collapse.
	 */
	readonly isColumn: boolean;
}

/** A nested object in the output shape. */
interface GroupSpec {
	readonly key: string;
	readonly children: readonly Node[];
	/**
	 * True when the group comes from an outer-joined table: if every one of its
	 * Column fields is null, the whole group is null rather than an object of
	 * nulls.
	 */
	readonly nullable: boolean;
	/**
	 * Indexes of this group's *direct* depth-2 Column leaves — not `sql`
	 * leaves, and not leaves belonging to a nested group further down. The
	 * null check for collapsing the group reads only these, matching Drizzle
	 * (`path.length === 2`, applied per leaf): a `sql` leaf riding along must
	 * not veto (or force) the collapse merely by being non-null, and a leaf
	 * that sits deeper belongs to a nested group of its own.
	 */
	readonly columnIndexes: readonly number[];
}

interface LeafSpec {
	readonly key: string;
	readonly index: number;
	readonly decode: ((value: unknown) => unknown) | undefined;
}

type Node = { readonly kind: 'leaf'; readonly leaf: LeafSpec } | { readonly kind: 'group'; readonly group: GroupSpec };

export interface Shape {
	readonly nodes: readonly Node[];
	readonly flat: boolean;
}

/** Build the output shape from a flat field list plus the set of nullable groups. */
export function buildShape(fields: readonly FieldPlan[], nullableGroups: ReadonlySet<string>): Shape {
	const flat = fields.every((f) => f.path.length === 1);
	if (flat) {
		return {
			flat: true,
			nodes: fields.map((f) => ({
				kind: 'leaf' as const,
				leaf: { key: f.path[0]!, index: f.index, decode: f.decode },
			})),
		};
	}

	interface Draft {
		key: string;
		children: Draft[];
		leaf?: LeafSpec;
		columnIndexes: number[];
		path: string;
	}

	const root: Draft = { key: '', children: [], columnIndexes: [], path: '' };
	const find = (parent: Draft, key: string, path: string): Draft => {
		let node = parent.children.find((c) => c.key === key && !c.leaf);
		if (!node) {
			node = { key, children: [], columnIndexes: [], path };
			parent.children.push(node);
		}
		return node;
	};

	for (const field of fields) {
		let parent = root;
		for (let i = 0; i < field.path.length - 1; i++) {
			const segment = field.path[i]!;
			parent = find(parent, segment, parent.path ? `${parent.path}.${segment}` : segment);
			// Only the *direct* parent (the last iteration, i.e. the group this
			// leaf is an immediate child of) collects it into `columnIndexes` —
			// matching Drizzle's per-leaf `path.length === 2` rule: a deeper
			// ancestor group does not see leaves nested further below it.
			if (field.isColumn && i === field.path.length - 2) parent.columnIndexes.push(field.index);
		}
		parent.children.push({
			key: field.path.at(-1)!,
			children: [],
			columnIndexes: [],
			path: '',
			leaf: { key: field.path.at(-1)!, index: field.index, decode: field.decode },
		});
	}

	const toNode = (draft: Draft): Node =>
		draft.leaf
			? { kind: 'leaf', leaf: draft.leaf }
			: {
				kind: 'group',
				group: {
					key: draft.key,
					children: draft.children.map(toNode),
					nullable: nullableGroups.has(draft.path),
					columnIndexes: draft.columnIndexes,
				},
			};

	return { flat: false, nodes: root.children.map(toNode) };
}

const readRow = (nodes: readonly Node[], read: (index: number) => unknown): Record<string, unknown> => {
	const obj: Record<string, unknown> = {};
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i]!;
		if (node.kind === 'leaf') {
			const raw = read(node.leaf.index);
			obj[node.leaf.key] = raw === null || raw === undefined
				? null
				: node.leaf.decode
				? node.leaf.decode(raw)
				: raw;
			continue;
		}
		const group = node.group;
		if (
			group.nullable
			&& group.columnIndexes.length > 0
			&& group.columnIndexes.every((index) => read(index) === null || read(index) === undefined)
		) {
			obj[group.key] = null;
			continue;
		}
		obj[group.key] = readRow(group.children, read);
	}
	return obj;
};

/** Positional mapper — the direct `.raw()` read path. */
export function buildPositionalMapper<T>(shape: Shape): (rows: unknown[][]) => T[] {
	if (shape.flat) {
		const leaves = shape.nodes.map((n) => (n as { leaf: LeafSpec }).leaf);
		return (rows) => {
			const out: T[] = new Array(rows.length);
			for (let r = 0; r < rows.length; r++) {
				const row = rows[r]!;
				const obj: Record<string, unknown> = {};
				for (let f = 0; f < leaves.length; f++) {
					const leaf = leaves[f]!;
					const raw = row[leaf.index];
					obj[leaf.key] = raw === null || raw === undefined ? null : leaf.decode ? leaf.decode(raw) : raw;
				}
				out[r] = obj as T;
			}
			return out;
		};
	}

	// The `(index) => row[index]` reader is allocated once here, not once per
	// row inside `.map()` — `current` is closed over and reassigned each
	// iteration instead. Measured (see the batch's F-104 note): ~15-20% faster
	// at 1k-10k rows for this shape, with no behaviour change.
	return (rows) => {
		const out: T[] = new Array(rows.length);
		let current: unknown[];
		const read = (index: number): unknown => current[index];
		for (let r = 0; r < rows.length; r++) {
			current = rows[r]!;
			out[r] = readRow(shape.nodes, read) as T;
		}
		return out;
	};
}

/** Keyed mapper — used inside `batch()`, where `.raw()` is unavailable. */
export function buildKeyedMapper<T>(
	shape: Shape,
	fields: readonly FieldPlan[],
): (rows: Record<string, unknown>[]) => T[] {
	const keyByIndex: string[] = [];
	for (const field of fields) keyByIndex[field.index] = field.key;

	return (rows) => {
		const out: T[] = new Array(rows.length);
		let current: Record<string, unknown>;
		const read = (index: number): unknown => current[keyByIndex[index]!];
		for (let r = 0; r < rows.length; r++) {
			current = rows[r]!;
			out[r] = readRow(shape.nodes, read) as T;
		}
		return out;
	};
}
