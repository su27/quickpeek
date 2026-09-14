export type ArchiveEntry = {
  name: string;
  dir: boolean;
  uncompressedSize?: number;
  compressedSize?: number;
  dateParts?: [number, number, number, number, number, number];
};
export type ArchiveDirectory = { entries: ArchiveEntry[]; truncated: boolean };
export type ArchiveTreeRow = {
  entry: ArchiveEntry;
  name: string;
  path: string;
  depth: number;
  parent?: number;
};
type Node = { entry: ArchiveEntry; name: string; path: string; children: Node[]; folders: Map<string, Node> };

/** ZIPs need not contain directory records. Build parents without extracting anything.
 * Case is significant, duplicate files remain visible, explicit directories enrich
 * their inferred node. Bound inferred nodes as well as raw archive records.
 */
export function buildArchiveTree(directory: ArchiveDirectory, limit = 10000): {
  rows: ArchiveTreeRow[];
  truncated: boolean;
} {
  const root: Node = { entry: { name: "", dir: true }, name: "", path: "", children: [], folders: new Map() };
  let count = 0;
  let truncated = directory.truncated;
  for (const entry of directory.entries) {
    // Treat Windows separators consistently too; do not resolve '..' against
    // the filesystem or silently turn a suspicious path into a different file.
    const parts = entry.name.split(/[\\/]+/).filter(part => part !== "" && part !== ".");
    if (!parts.length) continue;
    if (parts.length > 128) { truncated = true; continue; }
    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const last = i === parts.length - 1;
      const dir = !last || entry.dir;
      const existing = dir ? parent.folders.get(name) : undefined;
      if (existing) {
        if (last) existing.entry = entry;
        parent = existing;
        continue;
      }
      if (count >= limit) { truncated = true; break; }
      const path = parent.path ? `${parent.path}/${name}` : name;
      const node: Node = {
        name, path,
        entry: last ? entry : { name: `${path}/`, dir: true },
        children: [], folders: new Map(),
      };
      parent.children.push(node);
      if (dir) parent.folders.set(name, node);
      parent = node;
      count++;
    }
  }

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const compare = (a: Node, b: Node): number => Number(b.entry.dir) - Number(a.entry.dir)
    || collator.compare(a.name, b.name);
  const rows: ArchiveTreeRow[] = [];
  const stack: Array<{ node: Node; depth: number; parent?: number }> = root.children.sort(compare)
    .reverse().map(node => ({ node, depth: 0 }));
  while (stack.length) {
    const { node, depth, parent } = stack.pop()!;
    const index = rows.length;
    rows.push({ entry: node.entry, name: node.name, path: node.path, depth, parent });
    // Iterative traversal avoids stack overflow on deeply nested archive paths.
    for (const child of node.children.sort(compare).reverse()) stack.push({ node: child, depth: depth + 1, parent: index });
  }
  return { rows, truncated };
}
