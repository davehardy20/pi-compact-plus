import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

const LIMIT = 65_536;

function manifest(path: string): {
	name?: string;
	version?: string;
	bin?: { pi?: string };
} {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > LIMIT) {
			throw new Error("Invalid manifest");
		}
		const buffer = Buffer.alloc(LIMIT + 1);
		const size = readSync(fd, buffer, 0, buffer.length, 0);
		if (size > LIMIT) throw new Error("Invalid manifest");
		return JSON.parse(buffer.subarray(0, size).toString("utf8"));
	} finally {
		closeSync(fd);
	}
}

/** Read-only optional compatibility fixture discovery; never execute the CLI. */
export function findInstalledPiRuntime(
	version: string,
	searchPath = process.env.PATH,
): string | undefined {
	if (!searchPath || searchPath.length > LIMIT) return undefined;
	const directories = searchPath.split(delimiter);
	if (directories.length > 128) return undefined;
	for (const directory of directories) {
		if (!isAbsolute(directory) || directory.split(/[\\/]/).includes("..")) {
			continue;
		}
		let cli: string;
		try {
			cli = realpathSync(join(directory, "pi"));
		} catch {
			continue;
		}
		let root = dirname(cli);
		for (let depth = 0; depth < 8; depth++) {
			try {
				const pkg = manifest(join(root, "package.json"));
				const bin = pkg?.bin?.pi;
				if (
					pkg?.name === "@earendil-works/pi-coding-agent" &&
					pkg.version === version &&
					typeof bin === "string" &&
					!isAbsolute(bin) &&
					!bin.split(/[\\/]/).includes("..") &&
					!relative(root, cli).startsWith("..") &&
					realpathSync(join(root, bin)) === cli
				) {
					return root;
				}
			} catch {
				// Missing/malformed manifests are not SDK evidence.
			}
			const parent = dirname(root);
			if (parent === root) break;
			root = parent;
		}
	}
	return undefined;
}
