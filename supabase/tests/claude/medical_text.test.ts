/** Medical filter (DESIGN.md §8.4 step 8) and observation text hygiene (step 4). */
import { assert, assertEquals, assertFalse } from '@std/assert';
import { findMedicalTerm, hasMedicalTerm } from '@shared/claude/index.ts';
import { hasDigits, stripNumbers, wordCount } from '@shared/claude/text_clean.ts';

Deno.test('medical filter: whole-word EN terms, "teardrop" is not "tear"', () => {
  assertFalse(hasMedicalTerm('Hit a teardrop serve over the net.'));
  assertFalse(hasMedicalTerm('Tearing down the line is fun.'));
  assertEquals(findMedicalTerm('This may cause a tear in the shoulder.'), 'tear');
  assertEquals(findMedicalTerm('Classic Tennis Elbow pattern.'), 'tennis elbow');
  assertEquals(findMedicalTerm('Looks like TENDINITIS to me'), 'tendinitis');
  assertEquals(findMedicalTerm('I would diagnose it as…'), 'diagnose');
  assertFalse(hasMedicalTerm('Bend your knees and stay low; extend through contact.'));
  assertFalse(hasMedicalTerm('No tearful goodbyes: keep the swing compact.'));
});

Deno.test('medical filter: Vietnamese terms with Unicode boundaries and NFC', () => {
  assertEquals(findMedicalTerm('Có dấu hiệu viêm gân ở cổ tay.'), 'viêm');
  assertEquals(findMedicalTerm('Nguy cơ rách cơ vai'), 'rách cơ');
  assertEquals(findMedicalTerm('BONG GÂN cổ chân'), 'bong gân');
  // Decomposed (NFD) input is normalised before matching.
  assertEquals(findMedicalTerm('chẩn đoán'.normalize('NFD')), 'chẩn đoán');
  // "gần" (near) and "gân" (tendon) differ only by the tone mark: no false hit.
  assertFalse(hasMedicalTerm('Đứng gần lưới hơn một chút.'));
  // Syllables that differ only by diacritics are different words ("mỗi" vs "mổ").
  assertFalse(hasMedicalTerm('Mỗi lần đánh, bạn đều giữ vợt cao.'));
  assertEquals(findMedicalTerm('Có thể cần mổ.'), 'mổ');
  assertFalse(hasMedicalTerm('Hãy giữ khuỷu tay cao khi vung vợt.'));
});

Deno.test('observation hygiene: numbers, hedges and units are stripped', () => {
  assert(hasDigits('Elbow at 142°'));
  assertFalse(hasDigits('Elbow stays low'));
  assertEquals(stripNumbers('Tay chạm cầu ở khoảng 95° nên vẫn còn gập.'), 'Tay chạm cầu nên vẫn còn gập.');
  assertEquals(stripNumbers('Contact point is 1.9 m high, about 12 cm too low.'), 'Contact point is high, too low.');
  assertEquals(stripNumbers('Knees bent 20-30 degrees (good).'), 'Knees bent (good).');
  assertEquals(stripNumbers('Only 3 of 4 strokes kept the paddle up.'), 'Of strokes kept the paddle up.');
  assertEquals(stripNumbers('Elbow at 142°'), 'Elbow');
  assertEquals(wordCount(stripNumbers('Elbow at 142°')), 1);
  assertEquals(stripNumbers('Lift the paddle to 2 T above the waist.'), 'Lift the paddle above the waist.');
  assertEquals(stripNumbers('Gối gập 30 độ khi chờ cầu.'), 'Gối gập khi chờ cầu.');
});
