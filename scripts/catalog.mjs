import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CODEX_POLICY = Object.freeze({
  installation: 'AVAILABLE',
  authentication: 'ON_INSTALL',
});

const SEMVER = /^\d+\.\d+\.\d+$/u;
const KNOWN_PLUGINS = Object.freeze({
  'thoth-agents': {
    repository: 'https://github.com/EremesNG/thoth-agents.git',
    path: 'plugin',
  },
  'thoth-mem': {
    repository: 'https://github.com/EremesNG/thoth-mem.git',
    path: 'plugin',
  },
});

export function validateRegistry(registry) {
  if (registry?.marketplace?.name !== 'thoth-plugins') {
    throw new Error('marketplace name must be thoth-plugins');
  }
  if (!Array.isArray(registry.plugins)) {
    throw new Error('plugins must be an array');
  }
  const pluginNames = registry.plugins.map((plugin) => plugin?.name).sort();
  if (pluginNames.join(',') !== 'thoth-agents,thoth-mem') {
    throw new Error('plugins must contain thoth-agents and thoth-mem exactly once');
  }
  for (const plugin of registry.plugins) {
    if (typeof plugin?.name !== 'string' || !SEMVER.test(plugin.version ?? '')) {
      throw new Error('plugin name and version must be valid');
    }
    const expectedRef = `v${plugin.version}`;
    if (plugin.ref !== expectedRef) {
      throw new Error(`${plugin.name} ref must be ${expectedRef}`);
    }
    const known = KNOWN_PLUGINS[plugin.name];
    if (plugin.repository !== known.repository) {
      throw new Error(`${plugin.name} repository must remain authoritative`);
    }
    if (plugin.path !== known.path) {
      throw new Error(`${plugin.name} plugin path must remain ${known.path}`);
    }
  }
  return registry;
}

export function renderCatalogs(registry) {
  validateRegistry(registry);
  const plugins = [...registry.plugins].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  return {
    codex: {
      name: registry.marketplace.name,
      interface: { displayName: registry.marketplace.displayName },
      plugins: plugins.map((plugin) => ({
        name: plugin.name,
        source: {
          source: 'git-subdir',
          url: plugin.repository,
          path: `./${plugin.path}`,
          ref: plugin.ref,
        },
        policy: CODEX_POLICY,
        category: plugin.category,
      })),
    },
    claude: {
      $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
      name: registry.marketplace.name,
      description: registry.marketplace.description,
      owner: registry.marketplace.owner,
      plugins: plugins.map((plugin) => ({
        name: plugin.name,
        description: plugin.description,
        version: plugin.version,
        author: plugin.author,
        source: {
          source: 'git-subdir',
          url: plugin.repository,
          path: plugin.path,
          ref: plugin.ref,
        },
        category: plugin.category.toLowerCase(),
        homepage: plugin.homepage,
      })),
    },
  };
}

export function deriveCachePath(marketplaceName, plugin, skillName = plugin.name) {
  return `cache/${marketplaceName}/${plugin.name}/${plugin.version}/skills/${skillName}/SKILL.md`;
}

export function updatePluginVersion(registry, pluginName, version) {
  validateRegistry(registry);
  if (!SEMVER.test(version)) {
    throw new Error(`version must be an exact semantic version: ${version}`);
  }
  const updated = structuredClone(registry);
  const plugin = updated.plugins.find((entry) => entry.name === pluginName);
  if (!plugin) {
    throw new Error(`unknown plugin: ${pluginName}`);
  }
  plugin.version = version;
  plugin.ref = `v${version}`;
  validateRegistry(updated);
  return updated;
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function descriptorPaths(root) {
  return {
    Codex: join(root, '.agents', 'plugins', 'marketplace.json'),
    Claude: join(root, '.claude-plugin', 'marketplace.json'),
  };
}

function registryPath(root) {
  return join(root, 'catalog', 'plugins.json');
}

export async function readRegistry(root) {
  let registry;
  try {
    registry = JSON.parse(await readFile(registryPath(root), 'utf8'));
  } catch (error) {
    throw new Error('catalog registry is missing or invalid', { cause: error });
  }
  return validateRegistry(registry);
}

async function writeRegistry(root, registry) {
  await mkdir(join(root, 'catalog'), { recursive: true });
  await writeFile(registryPath(root), formatJson(registry));
}

export async function writeCatalogFiles(root, registry) {
  const rendered = renderCatalogs(registry);
  const paths = descriptorPaths(root);
  await mkdir(join(root, '.agents', 'plugins'), { recursive: true });
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(paths.Codex, formatJson(rendered.codex));
  await writeFile(paths.Claude, formatJson(rendered.claude));
}

export async function validateCatalogFiles(root, registry) {
  const rendered = renderCatalogs(registry);
  const paths = descriptorPaths(root);
  for (const [host, expected] of [
    ['Codex', rendered.codex],
    ['Claude', rendered.claude],
  ]) {
    const actual = await readFile(paths[host], 'utf8');
    if (actual !== formatJson(expected)) {
      throw new Error(`${host} marketplace descriptor is not synchronized`);
    }
  }
}

export async function updateCatalogPlugin(
  root,
  pluginName,
  version,
  sourceValidator = validatePluginSource,
) {
  const current = await readRegistry(root);
  const updated = updatePluginVersion(current, pluginName, version);
  const selected = updated.plugins.find((plugin) => plugin.name === pluginName);
  await sourceValidator(selected);
  await writeRegistry(root, updated);
  await writeCatalogFiles(root, updated);
  return updated;
}

async function readManifest(path, pluginName, host) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${pluginName} ${host} manifest is missing or invalid`, {
      cause: error,
    });
  }
  return manifest;
}

export async function validatePluginCheckout(plugin, checkoutRoot) {
  const pluginRoot = join(checkoutRoot, plugin.path);
  const manifests = [
    ['Codex', join(pluginRoot, '.codex-plugin', 'plugin.json')],
    ['Claude', join(pluginRoot, '.claude-plugin', 'plugin.json')],
  ];
  for (const [host, path] of manifests) {
    const manifest = await readManifest(path, plugin.name, host);
    if (manifest.name !== plugin.name) {
      throw new Error(`${plugin.name} ${host} manifest name must be ${plugin.name}`);
    }
    if (manifest.version !== plugin.version) {
      throw new Error(
        `${plugin.name} ${host} manifest version must be ${plugin.version}`,
      );
    }
  }
  for (const skill of plugin.requiredSkills) {
    const skillPath = join(pluginRoot, 'skills', skill, 'SKILL.md');
    try {
      await readFile(skillPath, 'utf8');
    } catch (error) {
      throw new Error(`${plugin.name} required Skill ${skill} is missing`, {
        cause: error,
      });
    }
  }
}

export async function validatePluginSource(plugin) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'thoth-plugin-source-'));
  const checkoutRoot = join(temporaryRoot, 'checkout');
  try {
    try {
      await execFileAsync(
        'git',
        [
          'clone',
          '--quiet',
          '--depth',
          '1',
          '--single-branch',
          '--branch',
          plugin.ref,
          plugin.repository,
          checkoutRoot,
        ],
        { windowsHide: true },
      );
    } catch (error) {
      throw new Error(`could not clone ${plugin.name} at ${plugin.ref}`, {
        cause: error,
      });
    }
    await validatePluginCheckout(plugin, checkoutRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
