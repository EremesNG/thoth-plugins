import { updateCatalogPlugin, validatePluginSource } from './catalog.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing required argument ${name}`);
  }
  return value;
}

function optionalArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value?.startsWith('--')) {
    throw new Error(`Missing value for argument ${name}`);
  }
  return value;
}

const pluginName = argument('--plugin');
const version = argument('--version');
const sourceRepository = optionalArgument('--source-repository');
const sourceValidator = sourceRepository
  ? (plugin) => validatePluginSource({ ...plugin, repository: sourceRepository })
  : validatePluginSource;
const updated = await updateCatalogPlugin(
  process.cwd(),
  pluginName,
  version,
  sourceValidator,
);
console.log(`Updated ${pluginName} to ${version} in ${updated.plugins.length} marketplace entries.`);
