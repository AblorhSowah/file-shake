// Barrel for the reference-detection API (DESIGN.md section 8). The design names the module
// for resolveImport only (resolver.ts); the other modules follow the layout in section 4.
// If the Builder placed an export elsewhere, adjust ONLY this file.
export { scanCode } from '../../src/core/references/scan';
export { parseImports, detectLanguage } from '../../src/core/references/parsers/index';
export { countUsages } from '../../src/core/references/usage';
export { loadProjectInfo } from '../../src/core/references/projectInfo';
export { resolveImport } from '../../src/core/references/resolver';
export { analyzeReferences } from '../../src/core/references/index';
