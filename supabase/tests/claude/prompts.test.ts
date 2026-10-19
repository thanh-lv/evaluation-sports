/** System prompt blocks (DESIGN.md §8.2): byte-identical across languages and users, deterministic rubric text. */
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from '@std/assert';
import { BASE_SYSTEM_V2, buildCoachRequest, renderRubricText, rubricText, systemBlocks } from '@shared/claude/index.ts';
import { loadRubric } from '@shared/rubric/load.ts';
import { assertSnapshot, preparedFixture, requestInput } from './_claude.ts';

Deno.test('system blocks are byte-identical for VI and EN, both kinds and different analyses', async () => {
  const bd = await preparedFixture('synthetic_bd_clear_fh_60');
  const bd2 = await preparedFixture('synthetic_bd_smash_30');
  const pb = await preparedFixture('synthetic_pb_dink_60');
  const sys = (s: unknown) => JSON.stringify(s);
  const vi = buildCoachRequest(requestInput(bd, 'vi')).params;
  const en = buildCoachRequest(requestInput(bd, 'en')).params;
  const basic = buildCoachRequest(requestInput(bd2, 'en', 'basic')).params;
  assertEquals(sys(vi.system), sys(en.system));
  assertEquals(sys(vi.system), sys(basic.system));
  assertEquals(JSON.stringify(vi.output_config?.format), JSON.stringify(en.output_config?.format));
  // Different sport → different rubric block, same base block.
  const pbSys = buildCoachRequest(requestInput(pb, 'vi')).params.system as { text: string }[];
  const bdSys = vi.system as { text: string }[];
  assertEquals(pbSys[0].text, bdSys[0].text);
  assertNotEquals(pbSys[1].text, bdSys[1].text);
  // The language only appears on the last line of the user text.
  const userText = (p: typeof vi) => {
    const content = p.messages[0].content as { type: string; text?: string }[];
    return content[content.length - 1].text ?? '';
  };
  assert(userText(vi).endsWith('\nOutput language: vi'));
  assert(userText(en).endsWith('\nOutput language: en'));
  assertEquals(userText(vi).replace(/vi$/, 'en'), userText(en));
});

Deno.test('BASE_SYSTEM_V2 holds the v1.1 rules and nothing volatile', () => {
  for (
    const needle of [
      'ONLY from <candidates>',
      'no numbers and no units',
      'In pose-only mode',
      'Contact times are estimates',
      'No diagnoses and no medical terms',
      '"bạn"',
      'at most 8 words',
      'summary (at most 3 sentences',
      'Output language: vi',
      '- Dink = Dink',
    ]
  ) assertStringIncludes(BASE_SYSTEM_V2, needle);
  assert(!/\b20\d\d-\d\d-\d\d\b/.test(BASE_SYSTEM_V2), 'no dates in the system prompt');
  assert(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(BASE_SYSTEM_V2), 'no ids in the system prompt');
});

Deno.test('rubric text is deterministic and covers every checkpoint, V anchor, fault and drill', () => {
  for (const sport of ['badminton', 'pickleball'] as const) {
    const rubric = loadRubric(sport);
    const text = renderRubricText(rubric);
    assertEquals(text, renderRubricText(structuredClone(rubric)));
    assertEquals(rubricText(sport), text);
    for (const c of rubric.checkpoints) {
      assertStringIncludes(text, `- ${c.id} | `);
      for (const a of c.vAnchors ?? []) assertStringIncludes(text, a.replace(/\s+/g, ' ').trim());
    }
    for (const f of rubric.faults) {
      assertStringIncludes(text, `- ${f.id} | checkpoint ${f.checkpoint}`);
      for (const d of f.drills) assertStringIncludes(text, d);
    }
    for (const d of rubric.drills) assertStringIncludes(text, `- ${d.id} | `);
    // English only: no Vietnamese diacritics leak from the {vi, en} catalog fields.
    assert(!/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(text), `${sport}: VI text in rubric`);
  }
});

Deno.test('system prompt snapshots', async () => {
  await assertSnapshot('base_system.txt', BASE_SYSTEM_V2 + '\n');
  await assertSnapshot('rubric_text.badminton.txt', rubricText('badminton') + '\n');
  await assertSnapshot('rubric_text.pickleball.txt', rubricText('pickleball') + '\n');
  // The cached block order and breakpoint: base (no marker), rubric (ephemeral marker).
  const blocks = systemBlocks('badminton') as { text: string; cache_control?: unknown }[];
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0].cache_control, undefined);
  assertEquals(blocks[1].cache_control, { type: 'ephemeral' });
});
