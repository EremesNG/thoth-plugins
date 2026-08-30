import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  deriveCachePath,
  readRegistry,
  renderCatalogs,
  updateCatalogPlugin,
  updatePluginVersion,
  validateCatalogFiles,
  validatePluginCheckout,
  validatePluginSource,
  validateRegistry,
  writeCatalogFiles,
} from '../scripts/catalog.mjs';

const registry = {
  schemaVersion: 1,
  marketplace: {
    name: 'thoth-plugins',
    displayName: 'Thoth Plugins',
    description: 'Canonical marketplace for Thoth coding-agent plugins.',
    owner: { name: 'EremesNG' },
  },
  plugins: [
    {
      name: 'thoth-agents',
      version: '0.3.11',
      repository: 'https://github.com/EremesNG/thoth-agents.git',
      ref: 'v0.3.11',
      path: 'plugin',
      description: 'Adaptive multi-harness orchestration.',
      author: { name: 'thoth-agents maintainers' },
      homepage: 'https://github.com/EremesNG/thoth-agents',
      category: 'Productivity',
      requiredSkills: ['thoth-sdd'],
    },
    {
      name: 'thoth-mem',
      version: '0.4.13',
      repository: 'https://github.com/EremesNG/thoth-mem.git',
      ref: 'v0.4.13',
      path: 'plugin',
      description: 'SQLite-first persistent project memory.',
      author: { name: 'thoth-mem maintainers' },
      homepage: 'https://github.com/EremesNG/thoth-mem',
      category: 'Productivity',
      requiredSkills: ['thoth-mem'],
    },
  ],
};

test('renders one neutral marketplace with two independently pinned plugins', () => {
  const { codex, claude } = renderCatalogs(registry);

  assert.deepEqual(codex, {
    name: 'thoth-plugins',
    interface: { displayName: 'Thoth Plugins' },
    plugins: registry.plugins.map((plugin) => ({
      name: plugin.name,
      source: {
        source: 'git-subdir',
        url: plugin.repository,
        path: './plugin',
        ref: plugin.ref,
      },
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
      category: 'Productivity',
    })),
  });
  assert.deepEqual(claude, {
    $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
    name: 'thoth-plugins',
    description: registry.marketplace.description,
    owner: { name: 'EremesNG' },
    plugins: registry.plugins.map((plugin) => ({
      name: plugin.name,
      description: plugin.description,
      version: plugin.version,
      author: plugin.author,
      source: {
        source: 'git-subdir',
        url: plugin.repository,
        path: 'plugin',
        ref: plugin.ref,
      },
      category: 'productivity',
      homepage: plugin.homepage,
    })),
  });
  assert.equal(
    deriveCachePath(registry.marketplace.name, registry.plugins[1]),
    'cache/thoth-plugins/thoth-mem/0.4.13/skills/thoth-mem/SKILL.md',
  );
});

test('rejects an ambiguous marketplace identity and version pin drift', () => {
  const ambiguous = structuredClone(registry);
  ambiguous.marketplace.name = 'thoth-mem';
  assert.throws(
    () => validateRegistry(ambiguous),
    /marketplace name must be thoth-plugins/u,
  );

  const drifted = structuredClone(registry);
  drifted.plugins[1].ref = 'main';
  assert.throws(
    () => validateRegistry(drifted),
    /thoth-mem ref must be v0\.4\.13/u,
  );
});

test('rejects duplicate plugins and authoritative repository drift', () => {
  const duplicate = structuredClone(registry);
  duplicate.plugins[1] = structuredClone(duplicate.plugins[0]);
  assert.throws(
    () => validateRegistry(duplicate),
    /plugins must contain thoth-agents and thoth-mem exactly once/u,
  );

  const redirected = structuredClone(registry);
  redirected.plugins[1].repository = 'https://example.com/not-thoth-mem.git';
  assert.throws(
    () => validateRegistry(redirected),
    /thoth-mem repository must remain authoritative/u,
  );
});

test('updates only the selected plugin version and leaves the source registry untouched', () => {
  const before = structuredClone(registry);
  const updated = updatePluginVersion(registry, 'thoth-mem', '0.4.14');

  assert.deepEqual(registry, before);
  assert.deepEqual(updated.plugins[0], before.plugins[0]);
  assert.deepEqual(updated.plugins[1], {
    ...before.plugins[1],
    version: '0.4.14',
    ref: 'v0.4.14',
  });
});

test('writes deterministic descriptors and rejects committed descriptor drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thoth-plugins-catalog-'));
  try {
    await writeCatalogFiles(root, registry);
    await assert.doesNotReject(validateCatalogFiles(root, registry));
    const codexPath = join(root, '.agents', 'plugins', 'marketplace.json');
    const codex = await readFile(codexPath, 'utf8');
    assert.equal(codex.endsWith('\n'), true);

    await writeFile(codexPath, codex.replace('Thoth Plugins', 'Drifted Catalog'));
    await assert.rejects(
      validateCatalogFiles(root, registry),
      /Codex marketplace descriptor is not synchronized/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not write catalog files when selected source validation fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thoth-plugins-update-'));
  try {
    await mkdir(join(root, 'catalog'), { recursive: true });
    const registryPath = join(root, 'catalog', 'plugins.json');
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    await writeCatalogFiles(root, registry);
    const before = await readFile(registryPath, 'utf8');

    await assert.rejects(
      updateCatalogPlugin(root, 'thoth-mem', '0.4.14', async () => {
        throw new Error('source rejected');
      }),
      /source rejected/u,
    );
    assert.equal(await readFile(registryPath, 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persists only the validated selected plugin update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thoth-plugins-update-'));
  try {
    await mkdir(join(root, 'catalog'), { recursive: true });
    await writeFile(
      join(root, 'catalog', 'plugins.json'),
      `${JSON.stringify(registry, null, 2)}\n`,
    );
    await writeCatalogFiles(root, registry);

    await updateCatalogPlugin(root, 'thoth-mem', '0.4.14', async (plugin) => {
      assert.equal(plugin.ref, 'v0.4.14');
    });
    const updated = await readRegistry(root);
    assert.deepEqual(updated.plugins[0], registry.plugins[0]);
    assert.equal(updated.plugins[1].version, '0.4.14');
    await assert.doesNotReject(validateCatalogFiles(root, updated));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts a tagged plugin checkout only when both manifests and Skills agree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thoth-plugins-checkout-'));
  const plugin = registry.plugins[1];
  try {
    await mkdir(join(root, 'plugin', '.codex-plugin'), { recursive: true });
    await mkdir(join(root, 'plugin', '.claude-plugin'), { recursive: true });
    await mkdir(join(root, 'plugin', 'skills', 'thoth-mem'), { recursive: true });
    const manifest = `${JSON.stringify({ name: 'thoth-mem', version: '0.4.13' })}\n`;
    await writeFile(join(root, 'plugin', '.codex-plugin', 'plugin.json'), manifest);
    await writeFile(join(root, 'plugin', '.claude-plugin', 'plugin.json'), manifest);
    await writeFile(join(root, 'plugin', 'skills', 'thoth-mem', 'SKILL.md'), '# thoth-mem\n');

    await assert.doesNotReject(validatePluginCheckout(plugin, root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a tagged checkout whose native manifest version drifts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thoth-plugins-checkout-'));
  const plugin = registry.plugins[1];
  try {
    await mkdir(join(root, 'plugin', '.codex-plugin'), { recursive: true });
    await mkdir(join(root, 'plugin', '.claude-plugin'), { recursive: true });
    await mkdir(join(root, 'plugin', 'skills', 'thoth-mem'), { recursive: true });
    await writeFile(
      join(root, 'plugin', '.codex-plugin', 'plugin.json'),
      `${JSON.stringify({ name: 'thoth-mem', version: '0.4.13' })}\n`,
    );
    await writeFile(
      join(root, 'plugin', '.claude-plugin', 'plugin.json'),
      `${JSON.stringify({ name: 'thoth-mem', version: '9.9.9' })}\n`,
    );
    await writeFile(join(root, 'plugin', 'skills', 'thoth-mem', 'SKILL.md'), '# thoth-mem\n');

    await assert.rejects(
      validatePluginCheckout(plugin, root),
      /thoth-mem Claude manifest version must be 0\.4\.13/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a tagged checkout missing a declared Skill entrypoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'thoth-plugins-checkout-'));
  const plugin = registry.plugins[1];
  try {
    await mkdir(join(root, 'plugin', '.codex-plugin'), { recursive: true });
    await mkdir(join(root, 'plugin', '.claude-plugin'), { recursive: true });
    const manifest = `${JSON.stringify({ name: 'thoth-mem', version: '0.4.13' })}\n`;
    await writeFile(join(root, 'plugin', '.codex-plugin', 'plugin.json'), manifest);
    await writeFile(join(root, 'plugin', '.claude-plugin', 'plugin.json'), manifest);

    await assert.rejects(
      validatePluginCheckout(plugin, root),
      /thoth-mem required Skill thoth-mem is missing/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validates the exact requested tag from a git source', async () => {
  const source = await mkdtemp(join(tmpdir(), 'thoth-plugins-source-'));
  try {
    await mkdir(join(source, 'plugin', '.codex-plugin'), { recursive: true });
    await mkdir(join(source, 'plugin', '.claude-plugin'), { recursive: true });
    await mkdir(join(source, 'plugin', 'skills', 'thoth-mem'), { recursive: true });
    const manifest = `${JSON.stringify({ name: 'thoth-mem', version: '0.4.13' })}\n`;
    await writeFile(join(source, 'plugin', '.codex-plugin', 'plugin.json'), manifest);
    await writeFile(join(source, 'plugin', '.claude-plugin', 'plugin.json'), manifest);
    await writeFile(join(source, 'plugin', 'skills', 'thoth-mem', 'SKILL.md'), '# thoth-mem\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Catalog Test'], { cwd: source });
    execFileSync('git', ['config', 'user.email', 'catalog-test@example.invalid'], { cwd: source });
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: source });
    execFileSync('git', ['tag', 'v0.4.13'], { cwd: source });

    const localPlugin = { ...registry.plugins[1], repository: source };
    await assert.doesNotReject(validatePluginSource(localPlugin));
    await assert.rejects(
      validatePluginSource({ ...localPlugin, ref: 'v9.9.9' }),
      /could not clone thoth-mem at v9\.9\.9/u,
    );
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});
