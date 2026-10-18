/**
 * Copy rules for every user-facing rubric string (DESIGN.md §10.2, §11; DESIGN-v1.0 §8.2 safety wording).
 * The Vietnamese copy is still pending native-coach review (M17); these tests only enforce the mechanical rules.
 */
import { assert, assertEquals } from '@std/assert';
import drillsJson from '@shared/rubric/drills.json' with { type: 'json' };
import { allStrings, bundles, localizedTexts, wordCount } from './_rubric.ts';

const SAFETY_VI = 'nếu đau, hãy hỏi HLV/chuyên gia';
const SAFETY_EN = 'if it hurts, ask a coach or professional';

/** Banned in any language (copy style + no medical claims + no rating claims). */
const BANNED_ANY = [
  /chuẩn như HLV/i,
  /phòng chấn thương/i,
  /chấn thương/i,
  /chẩn đoán/i,
  /điều trị/i,
  /DUPR/i,
  /trình/i,
];
const BANNED_VI = [/chưa tới/i, /\bbếp\b/i, /vô-lê/i, /động tác vung theo/i];
const BANNED_EN = [/injur/i, /diagnos/i, /treatment/i, /prevent/i, /\bcentre\b/i, /practis/i, /\bmetres?\b/i];

const rubricDocs =
  () => [...bundles().map((r) => ({ skills: r.skills, checkpoints: r.checkpoints, faults: r.faults })), drillsJson];

Deno.test('every localized text has non-empty vi and en', () => {
  for (const doc of rubricDocs()) {
    const texts = localizedTexts(doc);
    assert(texts.length > 0);
    for (const [path, t] of texts) {
      assert(t.vi.trim().length > 0, `${path}.vi empty`);
      assert(t.en.trim().length > 0, `${path}.en empty`);
    }
  }
  for (const r of bundles()) {
    for (const s of r.skills) assert(s.name.vi && s.name.en && s.rulesTip.vi && s.rulesTip.en, s.id);
    for (const c of r.checkpoints) {
      for (const lang of ['vi', 'en'] as const) {
        assert(c.plain[lang].low.trim() && c.plain[lang].high.trim(), `${c.id}.plain.${lang}`);
      }
    }
  }
});

Deno.test('plain evidence templates contain no digits; cues are at most 8 words', () => {
  for (const r of bundles()) {
    for (const c of r.checkpoints) {
      for (const s of [c.plain.vi.low, c.plain.vi.high, c.plain.en.low, c.plain.en.high]) {
        assert(!/\d/.test(s), `${c.id}: digit in plain template "${s}"`);
      }
    }
    for (const f of r.faults) {
      assert(wordCount(f.cue.vi) <= 8, `${f.id}: vi cue "${f.cue.vi}"`);
      assert(wordCount(f.cue.en) <= 8, `${f.id}: en cue "${f.cue.en}"`);
    }
  }
});

Deno.test('banned phrases, medical wording and outdated terms are absent', () => {
  for (const doc of rubricDocs()) {
    for (const [path, s] of allStrings(doc)) {
      for (const re of BANNED_ANY) assert(!re.test(s), `${path}: banned ${re} in "${s}"`);
    }
    for (const [path, t] of localizedTexts(doc)) {
      for (const re of BANNED_VI) assert(!re.test(t.vi), `${path}.vi: ${re} in "${t.vi}"`);
      for (const re of BANNED_EN) assert(!re.test(t.en), `${path}.en: ${re} in "${t.en}"`);
    }
  }
});

Deno.test('Vietnamese copy addresses the player as "bạn" and uses the §10.2 terms', () => {
  const vi = rubricDocs().flatMap((d) => localizedTexts(d).map(([, t]) => t.vi)).join('\n');
  assert(!/\b(anh|chị|em|mày|bạn ơi)\b/iu.test(vi.replace(/\bbạn\b/giu, '')), 'only "bạn" as the address form');
  for (const term of ['bạn', 'Bật nhún (split step)', 'kitchen', 'vô lê', 'Chuyển trọng tâm', 'Tư thế chuẩn bị']) {
    assert(vi.toLowerCase().includes(term.toLowerCase()), `expected the term "${term}" somewhere in VI copy`);
  }
});

Deno.test('injury safety notes end with the fixed referral phrase in both languages', () => {
  for (const r of bundles()) {
    for (const c of r.checkpoints) {
      if (!c.safety) continue;
      assert(c.safety.vi.replace(/[.\s]+$/, '').endsWith(SAFETY_VI), `${c.id}.safety.vi`);
      assert(c.safety.en.replace(/[.\s]+$/, '').endsWith(SAFETY_EN), `${c.id}.safety.en`);
    }
  }
});

Deno.test('V anchors are English (sent to Claude) and distinct', () => {
  for (const r of bundles()) {
    for (const c of r.checkpoints) {
      if (!c.vAnchors) continue;
      assertEquals(new Set(c.vAnchors).size, 5, `${c.id}: anchors must differ`);
      for (const a of c.vAnchors) assert(/^[\x20-\x7E]+$/.test(a), `${c.id}: non-ASCII anchor "${a}"`);
    }
  }
});
