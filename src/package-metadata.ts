import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageMetadata {
	name: string;
	version: string;
	packageRoot: string;
	sourcePath: string;
}

export type PackageMetadataResolver = () => PackageMetadata;

export function createPackageMetadataResolver(
	entrypointUrl: string,
): PackageMetadataResolver {
	const sourcePath = fileURLToPath(entrypointUrl);
	const packageRoot = path.resolve(path.dirname(sourcePath), "..");
	let cachedPackageMetadata: PackageMetadata | null = null;

	return function getPackageMetadata(): PackageMetadata {
		if (cachedPackageMetadata) {
			return cachedPackageMetadata;
		}

		let name = "pi-compact-plus";
		let version = "0.1.0";

		try {
			const packageJsonPath = path.join(packageRoot, "package.json");
			const packageJson = JSON.parse(
				fs.readFileSync(packageJsonPath, "utf8"),
			) as {
				name?: string;
				version?: string;
			};
			name = packageJson.name ?? name;
			version = packageJson.version ?? version;
		} catch {
			// Best-effort metadata only.
		}

		cachedPackageMetadata = {
			name,
			version,
			packageRoot,
			sourcePath,
		};
		return cachedPackageMetadata;
	};
}
