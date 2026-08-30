import {
  readRegistry,
  validateCatalogFiles,
  validatePluginSource,
} from './catalog.mjs';

const root = process.cwd();
const catalogOnly = process.argv.includes('--catalog-only');
const registry = await readRegistry(root);
await validateCatalogFiles(root, registry);
if (!catalogOnly) {
  for (const plugin of registry.plugins) {
    await validatePluginSource(plugin);
  }
}
console.log(
  catalogOnly
    ? 'Validated the registry and both marketplace descriptors.'
    : `Validated ${registry.plugins.length} pinned plugin sources and both marketplace descriptors.`,
);
