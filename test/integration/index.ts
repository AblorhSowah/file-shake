// Loaded by VS Code (extensionTestsPath, bundled to out/integration/index.js). Runs mocha (tdd) over
// the suite files that belong to the launch variant.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import Mocha from 'mocha';
import { selectSuiteFiles } from './harness';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', timeout: 60000, color: false });
  const dir = join(__dirname, 'suite');
  const variant = process.env['FS_TEST_VARIANT'] ?? 'single';
  const files = selectSuiteFiles(readdirSync(dir), variant);
  if (files.length === 0) return Promise.reject(new Error(`no suite files found in ${dir} for variant ${variant}`));
  for (const f of files) mocha.addFile(join(dir, f));
  const grep = process.env['FS_TEST_GREP'];
  if (grep) mocha.grep(grep);
  return new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} integration test(s) failed (variant ${variant}).`));
        else resolve();
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
