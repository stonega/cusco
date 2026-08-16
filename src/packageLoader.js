import Gio from 'gi://Gio?version=2.0';

const moduleDirectory = Gio.File.new_for_uri(import.meta.url).get_parent();

export async function importPackageModule(relativePath) {
    const normalizedPath = String(relativePath ?? '').trim();

    if (!/^[A-Za-z0-9_/-]+\.js$/.test(normalizedPath) || normalizedPath.includes('..'))
        throw new Error(`Invalid package module path: ${normalizedPath}`);

    const installedPackage = moduleDirectory.resolve_relative_path(
        `packages/${normalizedPath}`,
    );
    const sourcePackage = moduleDirectory.resolve_relative_path(
        `../packages/${normalizedPath}`,
    );
    const packageModule = installedPackage.query_exists(null)
        ? installedPackage
        : sourcePackage;

    if (!packageModule.query_exists(null))
        throw new Error(`Package module was not found: ${normalizedPath}`);

    return await import(packageModule.get_uri());
}
