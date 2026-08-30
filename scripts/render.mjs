import { readRegistry, writeCatalogFiles } from './catalog.mjs';

const root = process.cwd();
const registry = await readRegistry(root);
await writeCatalogFiles(root, registry);
console.log(`Rendered ${registry.plugins.length} plugins for Codex and Claude Code.`);
