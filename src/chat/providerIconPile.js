import Gio from 'gi://Gio?version=2.0';

const moduleDirectory = Gio.File.new_for_uri(import.meta.url).get_parent();
const installedPackage = moduleDirectory.resolve_relative_path(
    '../packages/providerIconPile/index.js',
);
const sourcePackage = moduleDirectory.resolve_relative_path(
    '../../packages/providerIconPile/index.js',
);
const providerIconPile = await import(
    (installedPackage.query_exists(null) ? installedPackage : sourcePackage).get_uri()
);

export const arrangeProviderIconBodies = providerIconPile.arrangeProviderIconBodies;
export const createProviderIconBodies = providerIconPile.createProviderIconBodies;
export const providerIdsForUsageBreakdown = providerIconPile.providerIdsForUsageBreakdown;
export const stepProviderIconBodies = providerIconPile.stepProviderIconBodies;
