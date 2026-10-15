// Renderer unit tests: what the e2e suite cannot reach. Windows forbids
// `<>` in directory names, so project-name escaping is pinned here, beside
// the 800-character cut boundary.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNotification } from '../src/message.ts';

describe('renderNotification', () => {
  test('escapes markup in the project, session, and excerpt', () => {
    assert.equal(
      renderNotification({
        status: 'completed',
        durationMs: 41_000,
        projectName: 'p<ro>&ject',
        sessionName: 's<e>&ssion',
        sessionTag: 'abcd',
        excerpt: '< Croaked & "quoted" >',
      }),
      '✅ <b>Completed</b> · 41s · #sabcd\n' +
        'p&lt;ro&gt;&amp;ject · s&lt;e&gt;&amp;ssion\n' +
        '\n' +
        '<blockquote expandable>&lt; Croaked &amp; "quoted" &gt;</blockquote>',
    );
  });

  test('leaves an exactly-800-character excerpt whole', () => {
    const text = 'x'.repeat(800);
    assert.equal(
      renderNotification({
        status: 'completed',
        durationMs: 1_000,
        projectName: 'proj',
        sessionName: undefined,
        sessionTag: 'abcd',
        excerpt: text,
      }),
      `✅ <b>Completed</b> · 1s · #sabcd\nproj\n\n<blockquote expandable>${text}</blockquote>`,
    );
  });

  test('cuts an 801-character excerpt to … plus the last 799', () => {
    assert.equal(
      renderNotification({
        status: 'completed',
        durationMs: 1_000,
        projectName: 'proj',
        sessionName: undefined,
        sessionTag: 'abcd',
        excerpt: `${'y'.repeat(2)}${'x'.repeat(799)}`,
      }),
      `✅ <b>Completed</b> · 1s · #sabcd\nproj\n\n<blockquote expandable>…${'x'.repeat(799)}</blockquote>`,
    );
  });
});
