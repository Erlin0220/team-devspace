import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

test('D1 migration comments cannot introduce remote statement delimiters', async () => {
  // Remote D1 rejects comment-only statements split around a semicolon even
  // when the same migration succeeds in the local SQLite/Miniflare path.
  for (const name of (await readdir('migrations')).filter(x => x.endsWith('.sql'))) {
    const sql = await readFile(`migrations/${name}`, 'utf8');
    for (const [comment] of sql.matchAll(/\/\*[\s\S]*?\*\/|--[^\r\n]*/g)) {
      assert.ok(!comment.includes(';'), `${name}: keep SQL delimiters out of comments`);
    }
  }
});
