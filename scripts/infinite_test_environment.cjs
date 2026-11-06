// Fixture browser suites must never fall through to a paid provider.
exports.assertOfflineValidation = async (origin) => {
  const response = await fetch(`${origin}/api/v1/infinite/config`);
  if (!response.ok || (await response.json()).offline_validation !== true) {
    throw new Error('Browser fixtures require an INFINITE_OFFLINE_VALIDATION=1 test server. No generation was attempted.');
  }
  require('node:child_process').execFileSync(require('node:path').resolve(__dirname, '../venv/bin/python'), [require('node:path').resolve(__dirname, 'create_infinite_fixture.py')]);
};
